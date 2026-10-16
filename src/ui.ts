import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AgentRunner, BudgetRequest } from "./agent.js";
import { createRunner, type Backend } from "./backend.js";
import { BATCH_FILE, BATCH_PREFIX, runBatch } from "./batch.js";
import { CONFIG_FILE, isGitRepo, loadConfig, workDirsFor } from "./config.js";
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

// ───────────── oturum: bir çalıştırmanın sohbeti ─────────────

export type MessageLevel = "step" | "info" | "ok" | "warn" | "error" | "detail" | "user" | "done";
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
  readonly id = randomUUID().slice(0, 8);
  status: "running" | "waiting" | "done" | "failed" = "running";
  messages: Message[] = [];
  pending?: Prompt & { resolve: (v: unknown) => void };
  summary?: { runId?: string; branch?: string; prUrl?: string; jiraCommentUrl?: string; cost?: number; durationMs?: number };
  /** Değişiklik onayında farkın tamamı (istenince gönderilir) */
  diff?: () => string;
  private seq = 0;

  constructor(
    readonly project: ProjectEntry,
    readonly title: string,
    private emit: (ev: { type: string; session: string; data: unknown }) => void,
  ) {}

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

  view() {
    return { id: this.id, project: this.project.name, title: this.title, status: this.status, prompt: this.publicPrompt(), summary: this.summary, messages: this.messages };
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

export interface UiOptions {
  port?: number;
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
  const token = randomBytes(18).toString("base64url");
  const sessions = new Map<string, Session>();
  const clients = new Set<http.ServerResponse>();
  const emit = (ev: { type: string; session: string; data: unknown }) => {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const c of clients) c.write(line);
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
  const busy = (p: ProjectEntry) => [...sessions.values()].some((s) => s.project.root === p.root && (s.status === "running" || s.status === "waiting"));

  const start = (p: ProjectEntry, title: string, work: (s: Session, base: Partial<RunOptions> & { agent: AgentRunner; backend: Backend; log: Logger }) => Promise<RunSummary | void>) => {
    if (busy(p)) throw new FlowloopError(`${p.name} projesinde süren bir çalıştırma var; bitince yenisini başlat.`);
    const s = new Session(p, title, emit);
    sessions.set(s.id, s);
    emit({ type: "session", session: s.id, data: { id: s.id, project: p.name, title, status: s.status } });
    void (async () => {
      try {
        const r = (opts.createAgent ?? ((root: string) => createRunner(loadConfig(root))))(p.root);
        s.push("info", `Ajan: ${r.backend === "cursor" ? "Cursor CLI" : "Claude (Agent SDK)"} — ${r.reason}`);
        const sum = await work(s, { ...opts.runExtras, ...s.callbacks(), agent: r.runner, backend: r.backend, log: s.logger() });
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
      emit({ type: "session", session: s.id, data: { id: s.id, project: p.name, title, status: s.status, summary: s.summary } });
    })();
    return s;
  };

  const routes = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> => {
    const m = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean);
    if (m === "GET" && url.pathname === "/api/state") {
      return send(res, 200, {
        projects: readProjects(home).map((p) => ({ ...p, busy: busy(p) })),
        sessions: [...sessions.values()].map((s) => s.view()),
      });
    }
    if (m === "GET" && parts[1] === "projects" && parts[3] === "runs") return send(res, 200, projectRuns(projectByName(decodeURIComponent(parts[2])).root));
    if (m === "POST" && url.pathname === "/api/projects") {
      const b = await readBody(req);
      return send(res, 200, addProject(str(b.path, 1000), home));
    }
    if (m === "POST" && url.pathname === "/api/projects/remove") {
      const b = await readBody(req);
      removeProject(str(b.name, 200), home);
      return send(res, 200, { ok: true });
    }
    if (m === "POST" && url.pathname === "/api/run") {
      const b = await readBody(req);
      const p = projectByName(b.project);
      const inputs = str(b.task, 2000).split(/[\s,]+/).filter(Boolean);
      if (!inputs.length) throw new FlowloopError("Görev yaz: Jira anahtarı (IDT-123), Jira bağlantısı ya da görev dosyası.");
      if (inputs.length > 20) throw new FlowloopError("En fazla 20 görev.");
      const s = start(p, inputs.join(" "), async (s, base) => {
        const files: string[] = [];
        for (const i of inputs) files.push(await resolveTaskInput(p.root, i, s.say(), b.refresh === true));
        const common = { ...base, root: p.root, planApproval: b.approvePlan !== false, noPush: b.noPush === true };
        if (files.length > 1) {
          await runBatch({ ...common, taskFiles: files, rerun: `flowloop run ${inputs.join(" ")}`, approveEachPlan: false });
          return;
        }
        return runTask({ ...common, taskFile: files[0] });
      });
      return send(res, 200, { session: s.id });
    }
    if (m === "POST" && url.pathname === "/api/resume") {
      const b = await readBody(req);
      const p = projectByName(b.project);
      const id = str(b.id, 300);
      if (!/^[\w.-]+$/.test(id)) throw new FlowloopError("Geçersiz çalıştırma.");
      const s = start(p, `devam: ${id}`, (s, base) => resumeRun({ ...base, root: p.root, resume: id, taskFile: "" } as RunOptions & { resume: string }));
      return send(res, 200, { session: s.id });
    }
    if (parts[1] === "sessions" && parts[2]) {
      const s = sessions.get(parts[2]);
      if (!s) return send(res, 404, { error: "Oturum yok." });
      if (m === "POST" && parts[3] === "answer") {
        const b = await readBody(req);
        s.answer(str(b.prompt, 100), b.value);
        return send(res, 200, { ok: true });
      }
      if (m === "GET" && parts[3] === "diff") return send(res, 200, { diff: strip(s.diff?.() ?? "") });
      if (m === "POST" && parts[3] === "dismiss" && s.status !== "running" && s.status !== "waiting") {
        sessions.delete(s.id);
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
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        req.on("close", () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      await routes(req, res, url);
    } catch (e) {
      send(res, e instanceof FlowloopError ? 400 : 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

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
    url: `http://127.0.0.1:${port}/#t=${token}`,
    token,
    port,
    sessions,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.end();
        server.close(() => resolve());
      }),
  };
}

function doneText(s: RunSummary): string {
  const lines = [`Bitti: ${s.commits.length} commit · ${s.branch}`];
  for (const c of s.commits) lines.push(`  ${c}`);
  if (s.pushed) lines.push(`Push: origin/${s.branch}`);
  if (s.prUrl) lines.push(`PR aç: ${s.prUrl}`);
  if (s.jiraCommentUrl) lines.push(`Jira: ${s.jiraCommentUrl}`);
  const cost = s.backend === "cursor" ? "" : ` · $${s.totalCostUsd.toFixed(2)}`;
  lines.push(`${s.iterations} tur${cost}${s.durationMs ? ` · ${fmtDuration(s.durationMs)}` : ""}`);
  for (const w of s.warnings) lines.push(`! ${w}`);
  return lines.join("\n");
}
