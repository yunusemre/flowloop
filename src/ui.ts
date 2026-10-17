import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { runWithBudget, type AgentRequest, type AgentRunner, type BudgetRequest } from "./agent.js";
import { createRunner, type Backend } from "./backend.js";
import { BATCH_FILE, BATCH_PREFIX, runBatch } from "./batch.js";
import { CONFIG_FILE, isGitRepo, loadConfig, workDirsFor, type ExtraRelated } from "./config.js";
import type { Logger } from "./log.js";
import { attentionLabel, needsDecision, suggestTriage, type AttentionItem, type OpenQuestion } from "./notes.js";
import {
  FlowloopError,
  resumeRun,
  runTask,
  type ChangeDecision,
  type ChangeReviewInfo,
  type PlanDecision,
  type RunOptions,
  type RunSummary,
  type ScopeDecision,
  type ScopeReviewInfo,
  type TriageChoice,
} from "./orchestrator.js";
import type { QuestionDecision } from "./questions.js";
import { PACKAGE_ROOT } from "./roles.js";
import { readText } from "./platform.js";
import { redact } from "./redact.js";
import { git } from "./git.js";
import { resolveTaskInput, type Say } from "./tasks.js";
import { fmtDuration } from "./timing.js";

/**
 * flowloop ui: yerel, küçük bir sohbet arayüzü.
 *
 * - Sadece 127.0.0.1'e bağlanır; her istek başlangıçta üretilen rastgele anahtarı taşımalı (tarayıcıdaki başka
 *   sitelerin isteklerine ve DNS rebinding'e karşı Host ve Origin de kontrol edilir).
 * - Çalıştırmalar bu süreçte yürür: terminaldeki soruların (plan onayı, açık sorular, inceleme maddeleri,
 *   değişiklik onayı, kapsam talebi, ek bütçe) aynısı sohbette kart olarak gelir.
 * - Sadece kayıtlı projelerde çalışır (~/.flowloop/projects.json); proje başına aynı anda bir çalıştırma.
 */

// ───────────── proje kaydı ─────────────

export interface ProjectEntry {
  name: string;
  root: string;
  /** Bu projede son görevle birlikte seçilen diğer projeler (sonraki görevde hazır gelir) */
  companions?: { name: string; edit: boolean }[];
}

export function projectsFile(home = os.homedir()): string {
  return path.join(home, ".flowloop", "projects.json");
}

export function readProjects(home = os.homedir()): ProjectEntry[] {
  try {
    const j = JSON.parse(readText(projectsFile(home))) as { projects?: ProjectEntry[] };
    return (j.projects ?? []).filter((p) => p && typeof p.root === "string" && typeof p.name === "string");
  } catch {
    return [];
  }
}

function writeProjects(list: ProjectEntry[], home = os.homedir()): void {
  fs.mkdirSync(path.dirname(projectsFile(home)), { recursive: true });
  fs.writeFileSync(projectsFile(home), JSON.stringify({ projects: list }, null, 2));
}

/** Projeyi kayda ekler; flowloop kurulu bir git reposu olmalı. Dönen: kayıt (zaten varsa o) */
export function addProject(dir: string, home = os.homedir()): ProjectEntry {
  const root = path.resolve(dir.replace(/^~(?=$|[\\/])/, os.homedir()));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new FlowloopError(`Klasör yok: ${root}`);
  if (!isGitRepo(root)) throw new FlowloopError(`Git reposu değil: ${root}`);
  if (!fs.existsSync(path.join(root, CONFIG_FILE))) throw new FlowloopError(`flowloop kurulu değil (${CONFIG_FILE} yok). Önce o klasörde: flowloop init`);
  const list = readProjects(home);
  const same = list.find((p) => path.resolve(p.root) === root);
  if (same) return same;
  let name = path.basename(root);
  for (let n = 2; list.some((p) => p.name === name); n++) name = `${path.basename(root)}-${n}`;
  const entry = { name, root };
  writeProjects([...list, entry], home);
  return entry;
}

/**
 * Bir klasörü ekler: kendisi flowloop kurulu bir repoysa onu, değilse altındaki (2 seviyeye kadar) flowloop kurulu
 * repoların hepsini. flowloop kurulu olmayan git repoları ayrıca döner (flowloop init gerekir).
 */
export function addProjectsFrom(dir: string, home = os.homedir()): { added: ProjectEntry[]; notReady: string[] } {
  const root = path.resolve(dir.replace(/^~(?=$|[\\/])/, os.homedir()));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new FlowloopError(`Klasör yok: ${root}`);
  if (fs.existsSync(path.join(root, CONFIG_FILE)) || isGitRepo(root)) return { added: [addProject(root, home)], notReady: [] };
  const added: ProjectEntry[] = [];
  const notReady: string[] = [];
  const SKIP = new Set(["node_modules", ".git", "bin", "obj", "dist", "build", "vendor", ".venv", "venv"]);
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const sub = path.join(d, e.name);
      if (fs.existsSync(path.join(sub, ".git"))) {
        if (fs.existsSync(path.join(sub, CONFIG_FILE))) added.push(addProject(sub, home));
        else notReady.push(path.relative(root, sub));
      } else if (depth < 2) walk(sub, depth + 1);
    }
  };
  walk(root, 1);
  if (!added.length && !notReady.length) throw new FlowloopError(`${root} altında git reposu bulunamadı.`);
  return { added, notReady };
}

function setCompanions(name: string, companions: { name: string; edit: boolean }[], home = os.homedir()): void {
  writeProjects(
    readProjects(home).map((p) => (p.name === name ? { ...p, companions } : p)),
    home,
  );
}

export function removeProject(name: string, home = os.homedir()): void {
  writeProjects(
    readProjects(home).filter((p) => p.name !== name),
    home,
  );
}

/** Bir projenin çalıştırmaları (en yenisi önce) */
export function projectRuns(root: string): { id: string; status: string; jiraKey?: string; branch?: string; cost?: number; startedAt?: string; durationMs?: number; error?: string; batch?: boolean }[] {
  let dirs: string[] = [];
  try {
    dirs = workDirsFor(loadConfig(root), root);
  } catch {
    return [];
  }
  const out: ReturnType<typeof projectRuns> = [];
  for (const base of dirs) {
    if (!fs.existsSync(base)) continue;
    for (const id of fs.readdirSync(base)) {
      const batch = id.startsWith(BATCH_PREFIX);
      const f = path.join(base, id, batch ? BATCH_FILE : "run.json");
      if (!fs.existsSync(f)) continue;
      try {
        const j = JSON.parse(readText(f));
        // özet başta "failed" yazılır; hatası yoksa çalıştırma ya sürüyor ya da yarıda kesildi
        out.push({ id, status: j.status === "failed" && !j.error ? "yarım" : (j.status ?? "yarım"), jiraKey: j.jiraKey ?? j.keys?.join(", "), branch: j.branch, cost: j.totalCostUsd, startedAt: j.startedAt, durationMs: j.durationMs, error: j.error?.split("\n")[0], batch });
      } catch {
        /* bozuk kayıt */
      }
    }
  }
  return out.sort((a, b) => (b.startedAt ?? b.id).localeCompare(a.startedAt ?? a.id));
}

/** Görev dosyasının başlığı: "IDT-22685 · GSM Format Validasyonu" (Jira anahtarı varsa önde) */
export function taskTitle(root: string, rel: string): string | undefined {
  try {
    const text = readText(path.resolve(root, rel));
    const head = /^#\s+(.+)$/m.exec(text)?.[1]?.replace(/^Görev:\s*/i, "").trim();
    const key = /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(text)?.[1];
    if (!head) return key;
    return key && !head.includes(key) ? `${key} · ${head}` : head.replace(new RegExp(`^(${key})\\s*[:—-]?\\s*`), "$1 · ");
  } catch {
    return undefined;
  }
}

/** Projenin görev dosyaları (en yenisi önce): sohbet arayüzünde hızlı seçim için */
export function projectTasks(root: string): { file: string; key?: string; title: string; mtime: number }[] {
  const dir = path.join(root, ".flowloop", "tasks");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const rel = path.posix.join(".flowloop", "tasks", f);
      const key = /^([A-Z][A-Z0-9]+-\d+)\.md$/.exec(f)?.[1];
      return { file: rel, key, title: taskTitle(root, rel) ?? f, mtime: fs.statSync(path.join(dir, f)).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 30);
}

/**
 * Bir çalıştırmayı siler: çalışma kopyaları (ilgili repolarınkiler dahil) ve run klasörü.
 * Branch'ler: commit'i olmayan (boş) branch silinir; commit'i olan korunur (push'lanmış ya da senin işin olabilir).
 * Ölçüm geçmişi (.flowloop/history.jsonl) silinmez; flowloop stats etkilenmez.
 */
export function deleteRun(root: string, id: string): { removed: string; keptBranches: string[] } {
  if (!/^[\w.-]+$/.test(id)) throw new FlowloopError("Geçersiz çalıştırma.");
  const dir = workDirsFor(loadConfig(root), root)
    .map((base) => path.join(base, id))
    .find((d) => fs.existsSync(path.join(d, id.startsWith(BATCH_PREFIX) ? BATCH_FILE : "run.json")));
  if (!dir) throw new FlowloopError(`Çalıştırma bulunamadı: ${id}`);
  const keptBranches: string[] = [];
  const dropBranch = (repo: string, branch: string | undefined, baseSha: string | undefined) => {
    if (!branch || git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo).code !== 0) return;
    const ahead = baseSha ? git(["rev-list", "--count", `${baseSha}..refs/heads/${branch}`], repo).stdout.trim() : "1";
    if (ahead === "0") git(["branch", "-D", branch], repo);
    else keptBranches.push(`${path.basename(repo)}: ${branch}`);
  };
  if (id.startsWith(BATCH_PREFIX)) {
    git(["worktree", "remove", "--force", path.join(dir, "plan-wt")], root);
  } else {
    let s: RunSummary | undefined;
    try {
      s = JSON.parse(readText(path.join(dir, "run.json")));
    } catch {
      /* kayıt bozuk: sadece klasör silinir */
    }
    for (const w of ["wt", "base"]) git(["worktree", "remove", "--force", path.join(dir, w)], root);
    for (const r of s?.related ?? []) {
      if (r.git === false) continue;
      git(["worktree", "remove", "--force", r.wt], r.root);
      git(["worktree", "remove", "--force", r.baseWt], r.root);
      git(["worktree", "prune"], r.root);
      if (!s?.batch) dropBranch(r.root, r.branch, r.baseSha);
    }
    // toplu çalışmanın branch'i ortaktır: bir görevin kaydı silinince dokunulmaz
    if (!s?.batch && s?.status !== "success") dropBranch(root, s?.branch, s?.baseSha);
    else if (s?.branch) keptBranches.push(`${path.basename(root)}: ${s.branch}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  git(["worktree", "prune"], root);
  return { removed: id, keptBranches: [...new Set(keptBranches)] };
}

/** Görev referansı mı: Jira anahtarı, Jira bağlantısı ya da görev dosyası (.md) */
export function isTaskRef(token: string): boolean {
  return /^[A-Z][A-Z0-9]+-\d+$/.test(token) || /^https?:\/\/\S+\/browse\/[A-Z][A-Z0-9]+-\d+/.test(token) || /\.md$/i.test(token);
}

/**
 * Serbest yazılmış isteği görev dosyasına çevirir (.flowloop/tasks/istek-<tarih>-<özet>.md). Metinde Jira anahtarı
 * geçiyorsa bilgi olarak eklenir (o kayıt çekilmez). Dönen: repo-göreli yol.
 */
export function writeRequestTask(root: string, text: string, context = "", now = new Date()): string {
  const first = text.split("\n").find((l) => l.trim())!.trim();
  const title = first.length > 80 ? `${first.slice(0, 77).replace(/\s+\S*$/, "")}…` : first;
  const slug = first
    .toLocaleLowerCase("tr")
    .replace(/[çğıöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" })[c]!)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "") || "istek";
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const rel = path.posix.join(".flowloop", "tasks", `istek-${stamp}-${slug}.md`);
  const keys = [...new Set(text.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [])];
  const body =
    `# ${title}\n\n` +
    `Kaynak: flowloop ui (serbest istek, ${now.toISOString().slice(0, 16).replace("T", " ")})\n` +
    (keys.length ? `İlgili Jira kayıtları: ${keys.join(", ")} (çekilmedi; gerekiyorsa analist açık soru olarak sorsun)\n` : "") +
    `\n## İstek\n\n${text.trim()}\n` +
    (context.trim() ? `\n## Sohbetten notlar\n\n${context.trim()}\n` : "") +
    `\n## Kabul kriterleri\n\nBelirtilmedi; analist istekten çıkaracak.\n`;
  fs.mkdirSync(path.join(root, ".flowloop", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
  return rel;
}

/** Projenin gizli dosya listesi (ayar okunamazsa güvenli varsayılan) */
function safeReadDeny(root: string): string[] {
  try {
    return loadConfig(root).paths.readDeny;
  } catch {
    return [".env", ".env.*", "**/appsettings*.json", "**/*.pem", "**/*.key"];
  }
}

/** Sürdürülecek çalıştırmanın değiştirilebilir ilgili repoları (run.json → related) */
function recordedEditRoots(root: string, id: string): string[] {
  try {
    for (const base of workDirsFor(loadConfig(root), root)) {
      const f = path.join(base, id, "run.json");
      if (!fs.existsSync(f)) continue;
      const j = JSON.parse(readText(f)) as RunSummary;
      return (j.related ?? []).filter((r) => r.edit?.length && r.git !== false).map((r) => path.resolve(r.root));
    }
  } catch {
    /* kayıt okunamadı */
  }
  return [];
}

/** Çalıştırmanın kaydı (run.json) ve klasörü; toplu çalışmalar hariç */
function readRun(root: string, id: string): { dir: string; run: RunSummary } | undefined {
  if (!/^[\w.-]+$/.test(id) || id.startsWith(BATCH_PREFIX)) return undefined;
  try {
    for (const base of workDirsFor(loadConfig(root), root)) {
      const f = path.join(base, id, "run.json");
      if (fs.existsSync(f)) return { dir: path.join(base, id), run: JSON.parse(readText(f)) as RunSummary };
    }
  } catch {
    /* kayıt okunamadı */
  }
  return undefined;
}

/** Yarım kalan çalıştırma kaldığı yerden sürdürülebilir mi: kayıt ve çalışma kopyası duruyor, başarıyla bitmemiş */
export function runResumable(root: string, id: string): boolean {
  const r = readRun(root, id);
  return !!r && r.run.status !== "success" && !!r.run.worktree && fs.existsSync(r.run.worktree);
}

/** Çalıştırmanın başlığı: görev dosyasının başlığı, yoksa Jira anahtarı */
function runTitle(root: string, id: string): string {
  const r = readRun(root, id);
  if (!r) return id;
  return taskTitle(root, path.join(r.dir, "run", "task.md")) ?? r.run.jiraKey ?? id;
}

// ───────────── sohbet geçmişi (kalıcı) ─────────────

/** Sohbetler: ~/.flowloop/ui/chats/<id>.json — arayüz yeniden başlayınca geri gelir */
export function chatsDir(home = os.homedir()): string {
  return path.join(home, ".flowloop", "ui", "chats");
}
export interface ChatRecord {
  id: string;
  kind: "task" | "ask";
  project: string;
  projectRoot: string;
  title: string;
  status: Session["status"];
  startedAt: number;
  costUsd: number;
  agentSession?: string;
  runId?: string;
  interrupted?: boolean;
  companions: { name: string; edit: boolean }[];
  summary?: Session["summary"];
  messages: Message[];
}
/** En yeni 200 sohbet */
function loadChats(home: string): ChatRecord[] {
  const dir = chatsDir(home);
  if (!fs.existsSync(dir)) return [];
  const out: { rec: ChatRecord; at: number }[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^[\w-]+\.json$/.test(f)) continue;
    try {
      const rec = JSON.parse(readText(path.join(dir, f))) as ChatRecord;
      if (rec?.id && Array.isArray(rec.messages)) out.push({ rec, at: rec.messages.at(-1)?.at ?? rec.startedAt ?? 0 });
    } catch {
      /* bozuk kayıt */
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 200).map((x) => x.rec);
}

// ───────────── oturum: bir çalıştırmanın sohbeti ─────────────

export type MessageLevel = "step" | "info" | "ok" | "warn" | "error" | "detail" | "user" | "done" | "answer";
export interface Message {
  seq: number;
  at: number;
  level: MessageLevel;
  text: string;
}
export type PromptKind = "plan" | "questions" | "triage" | "changes" | "scope" | "budget" | "confirm";
export interface Prompt {
  id: string;
  kind: PromptKind;
  payload: unknown;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI, "");

export class Session {
  readonly id: string;
  /** Görev sohbetinin çalıştırması (yarım kalırsa aynı sohbette sürdürülür) */
  runId?: string;
  /** Arayüz kapanırken sürüyordu */
  interrupted?: boolean;
  status: "running" | "waiting" | "done" | "failed" = "running";
  /** task: plan → geliştirme → inceleme → teslim · ask: sadece okuyan ajanla soru-cevap */
  kind: "task" | "ask" = "task";
  /** Soru-cevapta ajanın oturumu: takip soruları aynı bağlamla sürer */
  agentSession?: string;
  costUsd = 0;
  messages: Message[] = [];
  pending?: Prompt & { resolve: (v: unknown) => void };
  summary?: { runId?: string; branch?: string; prUrl?: string; jiraCommentUrl?: string; cost?: number; durationMs?: number };
  /** Değişiklik onayında farkın tamamı (istenince gönderilir) */
  diff?: () => string;
  private seq = 0;

  constructor(
    readonly project: ProjectEntry,
    public title: string,
    private emit: (ev: { type: string; session: string; data: unknown }) => void,
    id?: string,
  ) {
    this.id = id ?? randomUUID().slice(0, 8);
  }

  toRecord(): ChatRecord {
    return {
      id: this.id, kind: this.kind, project: this.project.name, projectRoot: this.project.root, title: this.title, status: this.status, startedAt: this.startedAt,
      costUsd: this.costUsd, agentSession: this.agentSession, runId: this.runId, interrupted: this.interrupted, companions: this.companions, summary: this.summary, messages: this.messages,
    };
  }

  static fromRecord(rec: ChatRecord, project: ProjectEntry, emit: (ev: { type: string; session: string; data: unknown }) => void): Session {
    const s = new Session(project, rec.title, emit, rec.id);
    s.kind = rec.kind === "ask" ? "ask" : "task";
    s.status = rec.status;
    s.startedAt = rec.startedAt ?? Date.now();
    s.costUsd = rec.costUsd ?? 0;
    s.agentSession = rec.agentSession;
    s.runId = rec.runId;
    s.interrupted = rec.interrupted;
    s.companions = rec.companions ?? [];
    s.summary = rec.summary;
    s.messages = rec.messages;
    s.seq = rec.messages.reduce((m, x) => Math.max(m, x.seq ?? 0), 0);
    return s;
  }

  push(level: MessageLevel, text: string): void {
    const m = { seq: ++this.seq, at: Date.now(), level, text: strip(text) };
    this.messages.push(m);
    if (this.messages.length > 5000) this.messages.splice(0, this.messages.length - 5000);
    this.emit({ type: "message", session: this.id, data: m });
  }

  logger(): Logger {
    return {
      step: (t) => this.push("step", t),
      info: (m) => this.push("info", m),
      ok: (m) => this.push("ok", m),
      warn: (m) => this.push("warn", m),
      error: (m) => this.push("error", m),
      detail: (m) => this.push("detail", m),
    };
  }

  say(): Say {
    return { info: (m) => this.push("info", m), ok: (m) => this.push("ok", m), warn: (m) => this.push("warn", m) };
  }

  /** Kullanıcıya bir kart gösterir ve cevabını bekler */
  ask<T>(kind: PromptKind, payload: unknown): Promise<T> {
    return new Promise<T>((resolve) => {
      this.pending = { id: randomUUID().slice(0, 8), kind, payload, resolve: resolve as (v: unknown) => void };
      this.status = "waiting";
      this.emit({ type: "prompt", session: this.id, data: this.publicPrompt() });
    });
  }

  /** Cevap: doğrulanır, kart kapanır */
  answer(promptId: string, value: unknown): void {
    const p = this.pending;
    if (!p || p.id !== promptId) throw new FlowloopError("Bu soru artık beklenmiyor (sayfayı yenile).");
    const v = validateAnswer(p.kind, value, p.payload);
    this.pending = undefined;
    this.status = "running";
    this.push("user", describeAnswer(p.kind, v));
    this.emit({ type: "prompt", session: this.id, data: null });
    p.resolve(v);
  }

  publicPrompt(): Prompt | null {
    return this.pending ? { id: this.pending.id, kind: this.pending.kind, payload: this.pending.payload } : null;
  }

  view(canResume = false) {
    return { id: this.id, kind: this.kind, costUsd: this.costUsd, project: this.project.name, title: this.title, status: this.status, startedAt: this.startedAt, companions: this.companions, prompt: this.publicPrompt(), summary: this.summary, runId: this.runId, interrupted: this.interrupted, canResume, messages: this.messages };
  }

  startedAt = Date.now();
  /** Bu çalıştırmada değiştirilebilen ilgili repoların kökleri (aynı anda başka çalıştırma onları değiştiremez) */
  editRoots: string[] = [];
  companions: { name: string; edit: boolean }[] = [];

  /** Başlık değişti (ör. görev dosyası çekilince "IDT-1 · başlık") */
  rename(title: string): void {
    this.title = title;
    this.emit({ type: "session", session: this.id, data: { id: this.id, project: this.project.name, title, status: this.status } });
  }

  /** orchestrator'a verilen soru fonksiyonları: terminaldekilerin aynısı, kart olarak */
  callbacks(): Pick<RunOptions, "confirm" | "reviewPlan" | "answerQuestions" | "triage" | "reviewChanges" | "reviewScope" | "extendBudget"> {
    return {
      confirm: (question) => this.ask<boolean>("confirm", { question }),
      reviewPlan: (plan, ctx) => this.ask<PlanDecision>("plan", { plan, ...ctx }),
      answerQuestions: (questions: OpenQuestion[], ctx) => this.ask<QuestionDecision>("questions", { questions, ...ctx }),
      triage: (items: AttentionItem[]) =>
        this.ask<{ choice: TriageChoice; note?: string }[]>("triage", {
          items: items.map((a) => ({ text: a.text, label: attentionLabel(a), suggest: suggestTriage(a), ask: needsDecision(a), decision: a.tag === "decision" })),
        }),
      reviewChanges: (info: ChangeReviewInfo) => {
        this.diff = info.diff;
        return this.ask<ChangeDecision>("changes", {
          round: info.round,
          diffStat: info.diffStat,
          reviewerNote: info.reviewerNote.split("\n").filter((l) => !/^VERDICT:/i.test(l.trim())).join("\n").trim(),
          assumptions: info.assumptions,
          attention: info.attention.map((a) => ({ text: a.text, label: attentionLabel(a) })),
          triage: info.triage,
          worktree: info.worktree,
          canRevise: info.canRevise,
        });
      },
      reviewScope: (info: ScopeReviewInfo) => this.ask<ScopeDecision>("scope", info),
      extendBudget: (b: BudgetRequest) => this.ask<number>("budget", { ...b, step: b.budgetUsd > 0 ? Math.max(0.5, Math.round(b.budgetUsd * 100) / 100) : 1 }),
    };
  }
}

const str = (v: unknown, max = 20000) => (typeof v === "string" ? v.slice(0, max) : "");

/** Tarayıcıdan gelen cevabı kartın beklediği biçime zorlar; uymayanı reddeder */
export function validateAnswer(kind: PromptKind, v: any, payload: any): unknown {
  const bad = () => {
    throw new FlowloopError("Geçersiz cevap.");
  };
  if (!v || typeof v !== "object") bad();
  switch (kind) {
    case "confirm":
      return v.yes === true;
    case "plan":
      if (v.action === "approve" || v.action === "cancel") return { action: v.action };
      if (v.action === "restart" && payload?.reused) return { action: "restart" };
      if (v.action === "revise" && str(v.comment).trim()) return { action: "revise", comment: str(v.comment) };
      return bad();
    case "questions": {
      if (v.action === "assume" || v.action === "cancel") return { action: v.action };
      if (v.action === "jira" && payload?.canPostToJira) return { action: "jira" };
      if (v.action === "answer" && v.answers && typeof v.answers === "object") {
        const ids = new Set((payload?.questions ?? []).map((q: OpenQuestion) => q.id));
        const answers: Record<string, string> = {};
        for (const [k, a] of Object.entries(v.answers)) if (ids.has(k)) answers[k] = str(a);
        return { action: "answer", answers };
      }
      return bad();
    }
    case "triage": {
      const n = payload?.items?.length ?? 0;
      if (!Array.isArray(v.choices) || v.choices.length !== n) return bad();
      return v.choices.map((c: any, i: number) => {
        const choice = ["fix", "manual", "followup", "skip"].includes(c?.choice) ? (c.choice as TriageChoice) : (payload.items[i].suggest as TriageChoice);
        const note = str(c?.note).trim();
        return note ? { choice, note } : { choice };
      });
    }
    case "changes":
      if (v.action === "approve" || v.action === "cancel") return { action: v.action };
      if (v.action === "revise" && payload?.canRevise && str(v.comment).trim()) return { action: "revise", comment: str(v.comment) };
      return bad();
    case "scope":
      if (v.action === "continue" || v.action === "cancel") return { action: v.action };
      if (v.action === "expand") {
        const allowed: string[] = payload?.expandable ?? [];
        const repos = (Array.isArray(v.repos) && v.repos.length ? v.repos : allowed).filter((r: unknown) => typeof r === "string" && allowed.includes(r));
        return repos.length ? { action: "expand", repos } : bad();
      }
      return bad();
    case "budget": {
      const n = Number(v.amount);
      if (n === 0) return 0;
      return n > 0 && n <= 100 ? n : bad();
    }
  }
  return bad();
}

function describeAnswer(kind: PromptKind, v: any): string {
  switch (kind) {
    case "confirm":
      return v ? "Evet" : "Hayır";
    case "plan":
      return v.action === "approve" ? "Planı onayladım." : v.action === "revise" ? `Plana yorum: ${v.comment}` : v.action === "restart" ? "Baştan analiz et." : "İptal.";
    case "questions":
      return v.action === "answer"
        ? Object.entries(v.answers as Record<string, string>)
            .map(([k, a]) => `${k}: ${a || "(varsayılan)"}`)
            .join("\n")
        : v.action === "assume"
          ? "Varsayılanlarla devam et."
          : v.action === "jira"
            ? "Soruları Jira'ya yaz ve dur."
            : "Durdur.";
    case "triage": {
      const c = (x: string) => (v as { choice: string }[]).filter((o) => o.choice === x).length;
      return `İnceleme maddeleri: ${c("fix")} düzeltilecek · ${c("manual")} elle · ${c("followup")} ayrı iş · ${c("skip")} geçildi`;
    }
    case "changes":
      return v.action === "approve" ? "Onayla: commit, push ve Jira yorumu." : v.action === "revise" ? `Değişiklik isteği: ${v.comment}` : "Şimdilik onaylamıyorum.";
    case "scope":
      return v.action === "expand" ? `Kapsamı genişlet: ${v.repos.join(", ")}` : v.action === "continue" ? "Genişletmeden devam et." : "Durdur.";
    case "budget":
      return v > 0 ? `Ek bütçe: $${Number(v).toFixed(2)}` : "Durdur.";
  }
  return "";
}

// ───────────── sunucu ─────────────

/** Arayüzün kalıcı durumu: anahtar sabit kalır (yer imi çalışsın), çalışan sürecin pid'i ve portu */
export interface UiState {
  token: string;
  port?: number;
  pid?: number;
  startedAt?: string;
}

export function uiStateFile(home = os.homedir()): string {
  return path.join(home, ".flowloop", "ui.json");
}

export function readUiState(home = os.homedir()): UiState | undefined {
  try {
    const j = JSON.parse(readText(uiStateFile(home))) as UiState;
    return typeof j.token === "string" && j.token.length >= 16 ? j : undefined;
  } catch {
    return undefined;
  }
}

export function writeUiState(st: UiState, home = os.homedir()): void {
  const f = uiStateFile(home);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(st, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(f, 0o600);
  } catch {
    /* Windows */
  }
}

/** Kayıtlı anahtar (yoksa ya da yenisi istenirse üretilir) */
export function uiToken(home = os.homedir(), renew = false): string {
  const st = readUiState(home);
  if (st && !renew) return st.token;
  const token = randomBytes(18).toString("base64url");
  writeUiState({ token }, home);
  return token;
}

export const uiUrl = (port: number, token: string) => `http://127.0.0.1:${port}/#t=${token}`;

/** Kayıttaki süreç hâlâ çalışıyor ve bu anahtarla cevap veriyor mu */
export async function uiAlive(st: UiState | undefined): Promise<boolean> {
  if (!st?.pid || !st.port) return false;
  try {
    process.kill(st.pid, 0);
  } catch {
    return false;
  }
  try {
    const r = await fetch(`http://127.0.0.1:${st.port}/api/state`, { headers: { "x-flowloop-token": st.token }, signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

export interface UiOptions {
  port?: number;
  /** Sabit anahtar (verilmezse rastgele) */
  token?: string;
  home?: string;
  /** Testlerde gerçek ajan yerine */
  createAgent?: (root: string) => { runner: AgentRunner; backend: Backend; reason: string };
  /** Testlerde ek çalıştırma seçenekleri (noFetch, home...) */
  runExtras?: Partial<RunOptions>;
}

export interface UiServer {
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
  sessions: Map<string, Session>;
}

const MAX_BODY = 256 * 1024;

export async function startUi(opts: UiOptions = {}): Promise<UiServer> {
  const home = opts.home ?? os.homedir();
  const token = opts.token ?? randomBytes(18).toString("base64url");
  const sessions = new Map<string, Session>();
  const clients = new Set<http.ServerResponse>();
  // sohbetler diske yazılır (her değişiklikten kısa süre sonra; kapanırken hemen)
  const saveTimers = new Map<string, NodeJS.Timeout>();
  const saveNow = (id: string) => {
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    const s = sessions.get(id);
    if (!s) return;
    try {
      fs.mkdirSync(chatsDir(home), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(chatsDir(home), `${s.id}.json`), JSON.stringify(s.toRecord()), { mode: 0o600 });
    } catch {
      /* yazılamadı: sohbet bu oturumda yine görünür */
    }
  };
  const scheduleSave = (id: string) => {
    if (!saveTimers.has(id)) saveTimers.set(id, setTimeout(() => saveNow(id), 300));
  };
  const forget = (s: Session) => {
    clearTimeout(saveTimers.get(s.id));
    saveTimers.delete(s.id);
    sessions.delete(s.id);
    fs.rmSync(path.join(chatsDir(home), `${s.id}.json`), { force: true });
  };
  const emit = (ev: { type: string; session: string; data: unknown }) => {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const c of clients) safeWrite(c, line);
    if (ev.session) scheduleSave(ev.session);
  };
  // önceki sohbetler: arayüz kapanırken sürenler yarıda kalmış sayılır (iş kaldığı yerden sürdürülebilir)
  for (const rec of loadChats(home)) {
    if (!rec.projectRoot || !fs.existsSync(rec.projectRoot)) continue;
    const p = readProjects(home).find((x) => x.root === rec.projectRoot) ?? { name: rec.project, root: rec.projectRoot };
    const s = Session.fromRecord(rec, p, emit);
    sessions.set(s.id, s);
    if (s.status === "running" || s.status === "waiting") {
      s.status = "failed";
      s.interrupted = true;
      s.push("warn", s.kind === "ask" ? "Arayüz kapandığında cevap hazırlanıyordu; soruyu tekrar sorabilirsin." : "Arayüz kapandığında bu iş sürüyordu. Kaldığı yerden devam etmek için Devam et'e bas.");
    }
  }
  const canResume = (s: Session) => s.kind === "task" && s.status !== "running" && s.status !== "waiting" && !!s.runId && runResumable(s.project.root, s.runId);
  // kapanmış bir tarayıcı sekmesine yazmak süreci düşürmesin
  const safeWrite = (c: http.ServerResponse, line: string) => {
    if (c.destroyed || c.writableEnded) {
      clients.delete(c);
      return;
    }
    try {
      c.write(line);
    } catch {
      clients.delete(c);
    }
  };
  const html = () => readText(path.join(PACKAGE_ROOT, "templates", "ui", "index.html"));
  let port = 0;

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage): Promise<any> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new FlowloopError("İstek çok büyük."));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
        } catch {
          reject(new FlowloopError("Geçersiz JSON."));
        }
      });
      req.on("error", reject);
    });

  const projectByName = (name: unknown) => {
    const p = readProjects(home).find((x) => x.name === name);
    if (!p) throw new FlowloopError("Proje kayıtlı değil.");
    return p;
  };
  // soru-cevap oturumları hiçbir şey değiştirmez: meşguliyete sayılmaz
  const active = () => [...sessions.values()].filter((s) => s.kind === "task" && (s.status === "running" || s.status === "waiting"));
  // bir repo aynı anda iki çalıştırmada değiştirilmesin: ana proje ya da "değiştirilebilir" seçilen ilgili proje
  const busy = (p: ProjectEntry) => active().some((s) => s.project.root === p.root || s.editRoots.includes(p.root));

  const start = (
    p: ProjectEntry,
    title: string,
    work: (s: Session, base: Partial<RunOptions> & { agent: AgentRunner; backend: Backend; log: Logger }) => Promise<RunSummary | void>,
    editRoots: string[] = [],
    existing?: Session,
  ) => {
    if (busy(p)) throw new FlowloopError(`${p.name} projesinde süren bir çalıştırma var; bitince yenisini başlat.`);
    for (const r of editRoots) {
      const other = active().find((s) => s.project.root === r || s.editRoots.includes(r));
      if (other) throw new FlowloopError(`${path.basename(r)} şu an başka bir çalıştırmada (${other.title}) değiştiriliyor; bitince başlat ya da o projeyi "okur" seç.`);
    }
    const s = existing ?? new Session(p, title, emit);
    s.editRoots = editRoots;
    if (existing) {
      s.status = "running";
      s.interrupted = false;
      s.pending = undefined;
      s.summary = undefined;
    } else s.companions = [];
    sessions.set(s.id, s);
    emit({ type: "session", session: s.id, data: { id: s.id, project: p.name, title: s.title, status: s.status } });
    void (async () => {
      try {
        const r = (opts.createAgent ?? ((root: string) => createRunner(loadConfig(root))))(p.root);
        s.push("info", `Ajan: ${r.backend === "cursor" ? "Cursor CLI" : "Claude (Agent SDK)"} — ${r.reason}`);
        const onRunStarted = (id: string) => {
          s.runId = id;
          scheduleSave(s.id);
        };
        const sum = await work(s, { ...opts.runExtras, ...s.callbacks(), agent: r.runner, backend: r.backend, log: s.logger(), onRunStarted });
        s.status = "done";
        if (sum) {
          s.summary = { runId: sum.id, branch: sum.branch, prUrl: sum.prUrl, jiraCommentUrl: sum.jiraCommentUrl, cost: sum.backend === "cursor" ? undefined : sum.totalCostUsd, durationMs: sum.durationMs };
          s.push("done", doneText(sum));
        } else s.push("done", "Bitti.");
      } catch (e) {
        s.status = "failed";
        if (s.pending) s.pending = undefined;
        s.push("error", e instanceof FlowloopError || e instanceof Error ? e.message : String(e));
      }
      emit({ type: "session", session: s.id, data: { id: s.id, project: p.name, title: s.title, status: s.status, summary: s.summary } });
    })();
    return s;
  };

  /** Soru-cevap: sadece okuyan bir ajan seçili projelerin kodunu inceleyip cevaplar; hiçbir dosyayı değiştiremez */
  const askQuestion = async (s: Session, question: string, withProjects: ProjectEntry[]) => {
    s.status = "running";
    s.push("user", question);
    emit({ type: "session", session: s.id, data: { id: s.id, kind: s.kind, project: s.project.name, title: s.title, status: s.status } });
    try {
      const cfg = loadConfig(s.project.root);
      const r = (opts.createAgent ?? ((root: string) => createRunner(loadConfig(root))))(s.project.root);
      const runRoot = path.join(home, ".flowloop", "ask", s.id);
      fs.mkdirSync(runRoot, { recursive: true });
      const extraRoots = withProjects.map((q) => ({ name: q.name, root: q.root, readDeny: safeReadDeny(q.root) }));
      const req: AgentRequest = {
        role: "analist",
        persona:
          "Ekibin kıdemli geliştiricisisin ve soruları kodu okuyarak cevaplarsın. Kod DEĞİŞTİRMEZSİN, komut çalıştırmazsın; " +
          "sadece okursun. Cevabını Türkçe, kısa ve somut ver: ilgili dosya ve satırları `yol:satır` biçiminde göster, emin olmadığın yeri söyle.",
        prompt:
          (s.agentSession ? "" : `Proje: ${s.project.name} (${s.project.root})${withProjects.length ? `\nBirlikte bakılabilecek projeler: ${withProjects.map((q) => `${q.name} (${q.root})`).join(", ")}` : ""}\n\n`) +
          `Soru:\n${question}`,
        cwd: s.project.root,
        runRoot,
        perms: { tools: ["Read", "Glob", "Grep"], read: ["**", ...withProjects.map((q) => `@${q.name}:**`)], edit: [], bash: [] },
        policy: { repoRoot: s.project.root, runRoot, readDeny: cfg.paths.readDeny, forbiddenFlags: {}, extraRoots },
        model: cfg.roles.analist?.model || cfg.model || undefined,
        budgetUsd: cfg.budgets.analist,
        isolation: cfg.isolation,
        claudeMd: true,
        extraDirs: withProjects.map((q) => q.root),
        resumeSessionId: s.agentSession,
        log: s.logger(),
      };
      const res = await runWithBudget(r.runner, req, { extendBudget: s.callbacks().extendBudget, totalSpentBefore: s.costUsd });
      s.costUsd += res.costUsd;
      if (res.sessionId) s.agentSession = res.sessionId;
      if (!res.ok) throw new FlowloopError(res.limitReached ? `Kullanım limiti doldu: ${res.limitReached}` : `Cevap alınamadı: ${res.error ?? "bilinmiyor"}`);
      s.push("answer", redact(res.text.trim() || "(boş cevap)", { personal: cfg.redact.personal }));
      s.status = "done";
    } catch (e) {
      s.status = "failed";
      s.push("error", e instanceof Error ? e.message : String(e));
    }
    emit({ type: "session", session: s.id, data: { id: s.id, kind: s.kind, project: s.project.name, title: s.title, status: s.status, costUsd: s.costUsd } });
  };

  /** Yarım kalan çalıştırmayı sürdürür: sohbeti varsa aynı sohbette (mesajlar alta eklenir) */
  const resumeIn = (p: ProjectEntry, id: string, existing?: Session) => {
    const chat = existing ?? [...sessions.values()].find((x) => x.kind === "task" && x.runId === id && x.project.root === p.root);
    if (chat && (chat.status === "running" || chat.status === "waiting")) throw new FlowloopError("Bu iş zaten sürüyor.");
    const s = start(p, chat?.title ?? runTitle(p.root, id), (s, base) => {
      s.push("step", "Kaldığı yerden devam");
      return resumeRun({ ...base, root: p.root, resume: id, taskFile: "" } as RunOptions & { resume: string });
    }, recordedEditRoots(p.root, id), chat);
    s.runId = id;
    return s;
  };
  const openRun = (p: ProjectEntry, id: string) => {
    const chat = [...sessions.values()].find((x) => x.kind === "task" && x.runId === id && x.project.root === p.root);
    if (chat) return chat;
    const r = readRun(p.root, id);
    if (!r) throw new FlowloopError(`Çalıştırma bulunamadı: ${id}`);
    const s = new Session(p, runTitle(p.root, id), emit);
    s.runId = id;
    s.startedAt = r.run.startedAt ? Date.parse(r.run.startedAt) || Date.now() : Date.now();
    s.costUsd = r.run.totalCostUsd ?? 0;
    sessions.set(s.id, s);
    s.push("info", `Bu çalıştırma arayüz dışında (terminalde) başlatıldı; sohbeti yok, kaydından özet:`);
    const lines = [`Başlangıç: ${r.run.startedAt ? new Date(r.run.startedAt).toLocaleString("tr-TR") : "?"}`];
    if (r.run.branch) lines.push(`Branch: ${r.run.branch}`);
    for (const ph of r.run.phases ?? []) lines.push(`${ph.role}${ph.iteration ? ` (tur ${ph.iteration})` : ""}${ph.verdict ? ` — ${ph.verdict}` : ""}`);
    s.push("info", lines.join("\n"));
    if (r.run.status === "success") {
      s.status = "done";
      s.push("done", `Bitti: ${r.run.commits?.length ?? 0} commit · ${r.run.branch ?? ""}`);
    } else {
      s.status = "failed";
      s.push(r.run.error ? "error" : "warn", r.run.error ?? "Yarıda kaldı.");
    }
    return s;
  };

  const routes = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> => {
    const m = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean);
    if (m === "GET" && url.pathname === "/api/state") {
      return send(res, 200, {
        projects: readProjects(home).map((p) => ({ ...p, busy: busy(p) })),
        sessions: [...sessions.values()].map((s) => s.view(canResume(s))),
      });
    }
    if (m === "GET" && parts[1] === "projects" && parts[3] === "runs") return send(res, 200, projectRuns(projectByName(decodeURIComponent(parts[2])).root));
    if (m === "GET" && parts[1] === "projects" && parts[3] === "tasks") return send(res, 200, projectTasks(projectByName(decodeURIComponent(parts[2])).root));
    if (m === "POST" && url.pathname === "/api/projects") {
      const b = await readBody(req);
      return send(res, 200, addProjectsFrom(str(b.path, 1000), home));
    }
    if (m === "POST" && url.pathname === "/api/projects/remove") {
      const b = await readBody(req);
      removeProject(str(b.name, 200), home);
      return send(res, 200, { ok: true });
    }
    if (m === "POST" && url.pathname === "/api/run") {
      const b = await readBody(req);
      const p = projectByName(b.project);
      const text = str(b.task, 20000).trim();
      if (!text) throw new FlowloopError("Görev yaz: Jira anahtarı (IDT-123), Jira bağlantısı, görev dosyası ya da ne yapılmasını istediğini.");
      // sadece anahtar/bağlantı/dosya yolu yazıldıysa onlar; değilse yazılan metin serbest istek olarak görev dosyası olur
      let inputs = text.split(/[\s,]+/).filter(Boolean);
      if (!inputs.every(isTaskRef)) inputs = [writeRequestTask(p.root, text, str(b.context, 20000))];
      if (inputs.length > 20) throw new FlowloopError("En fazla 20 görev.");
      // birlikte çalışılacak diğer kayıtlı projeler: okur ya da değiştirir (yetki sınırı o projenin kendi flowloop.yaml'ı)
      const picked: { name: string; edit: boolean }[] = (Array.isArray(b.related) ? b.related : [])
        .filter((x: any) => x && typeof x.name === "string" && x.name !== p.name)
        .slice(0, 10)
        .map((x: any) => ({ name: x.name, edit: x.edit === true }));
      const extraRelated: ExtraRelated[] = picked.map((x) => {
        const q = projectByName(x.name);
        const edit = x.edit ? loadConfig(q.root).paths.edit : [];
        return { name: q.name, path: q.root, edit };
      });
      setCompanions(p.name, picked, home);
      const s = start(p, inputs.join(" "), async (s, base) => {
        if (extraRelated.length) s.push("info", `Birlikte çalışılan projeler: ${extraRelated.map((r) => `${r.name} (${r.edit.length ? `değiştirir: ${r.edit.join(", ")}` : "okur"})`).join(" · ")}`);
        const files: string[] = [];
        for (const i of inputs) files.push(await resolveTaskInput(p.root, i, s.say(), b.refresh === true));
        if (files.length === 1) s.rename(taskTitle(p.root, files[0]) ?? s.title);
        const common = { ...base, root: p.root, planApproval: b.approvePlan !== false, noPush: b.noPush === true, extraRelated };
        if (files.length > 1) {
          await runBatch({ ...common, onRunStarted: undefined, taskFiles: files, rerun: `flowloop run ${inputs.join(" ")}`, approveEachPlan: false });
          return;
        }
        return runTask({ ...common, taskFile: files[0] });
      }, extraRelated.filter((r) => r.edit.length).map((r) => r.path));
      s.companions = picked;
      return send(res, 200, { session: s.id });
    }
    if (m === "POST" && url.pathname === "/api/ask") {
      const b = await readBody(req);
      const p = projectByName(b.project);
      const question = str(b.question, 20000).trim();
      if (!question) throw new FlowloopError("Sorunu yaz.");
      const withProjects = (Array.isArray(b.related) ? b.related : [])
        .filter((x: any) => x && typeof x.name === "string" && x.name !== p.name)
        .slice(0, 10)
        .map((x: any) => projectByName(x.name));
      const s = new Session(p, question.split("\n")[0].slice(0, 80), emit);
      s.kind = "ask";
      s.companions = withProjects.map((q: ProjectEntry) => ({ name: q.name, edit: false }));
      sessions.set(s.id, s);
      emit({ type: "session", session: s.id, data: { id: s.id, kind: s.kind, project: p.name, title: s.title, status: s.status, companions: s.companions } });
      void askQuestion(s, question, withProjects);
      return send(res, 200, { session: s.id });
    }
    if (m === "POST" && url.pathname === "/api/runs/delete") {
      const b = await readBody(req);
      const p = projectByName(b.project);
      // süren bir çalıştırmanın klasörü silinmesin
      if (busy(p)) throw new FlowloopError(`${p.name} projesinde süren bir çalıştırma var; bitince sil.`);
      const id = str(b.id, 300);
      const out = deleteRun(p.root, id);
      for (const s of [...sessions.values()]) if (s.runId === id && s.project.root === p.root) forget(s);
      return send(res, 200, out);
    }
    if (m === "POST" && url.pathname === "/api/resume") {
      const b = await readBody(req);
      const p = projectByName(b.project);
      const id = str(b.id, 300);
      if (!/^[\w.-]+$/.test(id)) throw new FlowloopError("Geçersiz çalıştırma.");
      return send(res, 200, { session: resumeIn(p, id).id });
    }
    // geçmişteki bir çalıştırmayı sohbet olarak aç: sohbeti varsa o, yoksa kaydından özet
    if (m === "POST" && url.pathname === "/api/runs/open") {
      const b = await readBody(req);
      const p = projectByName(b.project);
      const id = str(b.id, 300);
      if (!/^[\w.-]+$/.test(id)) throw new FlowloopError("Geçersiz çalıştırma.");
      return send(res, 200, { session: openRun(p, id).id });
    }
    if (parts[1] === "sessions" && parts[2]) {
      const s = sessions.get(parts[2]);
      if (!s) return send(res, 404, { error: "Oturum yok." });
      if (m === "POST" && parts[3] === "ask") {
        if (s.kind !== "ask") throw new FlowloopError("Bu bir görev sohbeti; soru için yeni bir soru sohbeti aç.");
        if (s.status === "running" || s.status === "waiting") throw new FlowloopError("Önceki cevap bekleniyor.");
        const b = await readBody(req);
        const question = str(b.question, 20000).trim();
        if (!question) throw new FlowloopError("Sorunu yaz.");
        const withProjects = s.companions.map((c) => readProjects(home).find((x) => x.name === c.name)).filter((x): x is ProjectEntry => !!x);
        void askQuestion(s, question, withProjects);
        return send(res, 200, { ok: true });
      }
      if (m === "POST" && parts[3] === "resume") {
        if (s.kind !== "task" || !s.runId) throw new FlowloopError("Bu sohbette sürdürülecek bir iş yok.");
        if (s.status === "running" || s.status === "waiting") throw new FlowloopError("Bu iş zaten sürüyor.");
        resumeIn(s.project, s.runId, s);
        return send(res, 200, { ok: true });
      }
      if (m === "POST" && parts[3] === "answer") {
        const b = await readBody(req);
        s.answer(str(b.prompt, 100), b.value);
        return send(res, 200, { ok: true });
      }
      if (m === "GET" && parts[3] === "diff") return send(res, 200, { diff: strip(s.diff?.() ?? "") });
      if (m === "POST" && parts[3] === "dismiss" && s.status !== "running" && s.status !== "waiting") {
        forget(s);
        return send(res, 200, { ok: true });
      }
    }
    return send(res, 404, { error: "Bulunamadı." });
  };

  const server = http.createServer(async (req, res) => {
    try {
      // DNS rebinding ve başka sitelerin istekleri: sadece kendi adresimiz ve doğru anahtar
      const host = (req.headers.host ?? "").toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: "host" });
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, { error: "origin" });
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
        });
        return res.end(html());
      }
      const given = url.pathname === "/api/events" ? url.searchParams.get("t") : req.headers["x-flowloop-token"];
      if (given !== token) return send(res, 401, { error: "Anahtar yok ya da yanlış. flowloop ui'nin yazdığı adresi kullan." });
      if (url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": bağlandı\n\n");
        clients.add(res);
        const ping = setInterval(() => safeWrite(res, ": ping\n\n"), 25_000);
        const drop = () => {
          clearInterval(ping);
          clients.delete(res);
        };
        // tarayıcı kapanınca bağlantı koparsa: hata yutulur, istemci listeden çıkar (sunucu ve çalıştırmalar sürer)
        req.on("close", drop);
        res.on("close", drop);
        res.on("error", drop);
        req.on("error", drop);
        return;
      }
      await routes(req, res, url);
    } catch (e) {
      send(res, e instanceof FlowloopError ? 400 : 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  // bozuk/yarım kalan istemci bağlantıları sunucuyu düşürmesin
  server.on("clientError", (_e, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const tryListen = (p: number) => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && p !== 0) tryListen(0);
        else reject(e);
      });
      server.listen(p, "127.0.0.1", () => resolve());
    };
    tryListen(opts.port ?? 4317);
  });
  port = (server.address() as { port: number }).port;
  return {
    url: uiUrl(port, token),
    token,
    port,
    sessions,
    close: () =>
      new Promise<void>((resolve) => {
        for (const id of [...saveTimers.keys()]) saveNow(id);
        for (const c of clients) c.destroy();
        server.close(() => resolve());
      }),
  };
}

function doneText(s: RunSummary): string {
  const lines = [`Bitti: ${s.commits.length} commit · ${s.branch}`];
  for (const c of s.commits) lines.push(`  ${c}`);
  if (s.pushed) lines.push(`Push: origin/${s.branch}`);
  if (s.prUrl) lines.push(`PR aç: ${s.prUrl}`);
  for (const r of s.related ?? []) {
    if (!r.commits?.length) continue;
    lines.push("", `${r.name}: ${r.commits.length} commit · ${r.branch}`);
    for (const c of r.commits) lines.push(`  ${c}`);
    if (r.pushed) lines.push(`Push: origin/${r.branch}`);
    if (r.prUrl) lines.push(`PR aç: ${r.prUrl}`);
  }
  if (s.jiraCommentUrl) lines.push(`Jira: ${s.jiraCommentUrl}`);
  const cost = s.backend === "cursor" ? "" : ` · $${s.totalCostUsd.toFixed(2)}`;
  lines.push(`${s.iterations} tur${cost}${s.durationMs ? ` · ${fmtDuration(s.durationMs)}` : ""}`);
  for (const w of s.warnings) lines.push(`! ${w}`);
  return lines.join("\n");
}
