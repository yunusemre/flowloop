import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import type { AgentRequest, AgentResult, AgentRunner, Denial } from "./agent.js";
import { ScopedChecks, renderReport, type CheckResult, type CheckRunner } from "./checks.js";
import { KGFLOW_DIR, jiraBaseUrl, loadConfig, workDirFor, workDirsFor } from "./config.js";
import { changedExisting, changedPaths, fillFiles, git, gitOk, headSha, runConfigured, statusPorcelain, workingTreeHash } from "./git.js";
import type { Logger } from "./log.js";
import { MutantSandbox } from "./mutant.js";
import { DEFAULT_FORBIDDEN_FLAGS, type PolicyContext } from "./policy.js";
import { composeRules } from "./projectdocs.js";
import { PACKAGE_ROOT, loadRoles, render, type RoleName, type RoleSpec } from "./roles.js";
import { detectBaseBranch } from "./tech.js";
import { expandServerNames, loadMcpServers } from "./usermcp.js";
import os from "node:os";
import { extractLessons, parseVerdict } from "./verdict.js";
import { postComment } from "./jira.js";
import { remoteLinks, type RemoteLinks } from "./remote.js";

/** Jira yorumu: committer'ın özeti + kgflow'in eklediği kesin bilgiler */
export function buildJiraComment(aiSummary: string, s: RunSummary, links?: RemoteLinks): string {
  const facts = [
    `- *Branch:* ${s.pushed ? (s.branchUrl ? `[${s.branch}](${s.branchUrl})` : `\`${s.branch}\` (origin'e push edildi)`) : `\`${s.branch}\` (henüz push edilmedi)`}`,
    s.pushed && s.prUrl ? `- *PR aç:* [${s.baseBranch} hedefli PR](${s.prUrl})` : "",
    `- *Commit'ler:*`,
    ...s.commits.map((c) => {
      const i = c.indexOf(" ");
      return `  - \`${c.slice(0, i)}\` ${c.slice(i + 1)}`;
    }),
    `- *Kontroller:* bu işin testleri yeşil, yeni tip/lint hatası yok, reviewer onayı ${s.iterations}. turda`,
  ].filter(Boolean);
  void links;
  return [
    aiSummary.trim() || "## Yapılan\n(özet üretilemedi; commit mesajlarına bakın)",
    "",
    "## Teslim",
    ...facts,
    "",
    "---",
    ...provenance(s),
  ].join("\n");
}

/** Yorumun altına: kim başlattı, hangi araç ve hangi modellerle yapıldı */
export function provenance(s: RunSummary): string[] {
  const byRole = new Map<string, Set<string>>();
  for (const p of s.phases) {
    if (!p.models?.length) continue;
    const set = byRole.get(p.role) ?? new Set<string>();
    p.models.forEach((m) => set.add(m));
    byRole.set(p.role, set);
  }
  const roles = ["analist", "developer", "reviewer", "committer"]
    .filter((r) => byRole.has(r))
    .map((r) => `${r}: ${[...byRole.get(r)!].join(" + ")}`);
  const versions = toolVersions();
  return [
    s.backend === "cursor"
      ? `🤖 *Cursor ile hazırlandı* — kgflow ${versions.kgflow} (Cursor CLI)`
      : `🤖 *Claude ile hazırlandı* — kgflow ${versions.kgflow} (Claude Agent SDK ${versions.sdk})`,
    `- *Modeller:* ${roles.length ? roles.join(" · ") : "bilinmiyor"}`,
    s.initiator ? `- *Başlatan:* ${s.initiator}` : "",
    `- *Akış:* analist → developer ⇄ reviewer (${s.iterations} tur) → committer`,
    "_Merge öncesi insan incelemesi (PR) gereklidir._",
  ].filter(Boolean);
}

let cachedVersions: { kgflow: string; sdk: string } | undefined;
function toolVersions(): { kgflow: string; sdk: string } {
  if (cachedVersions) return cachedVersions;
  const read = (f: string) => {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8")).version as string;
    } catch {
      return "?";
    }
  };
  cachedVersions = {
    kgflow: read(path.join(PACKAGE_ROOT, "package.json")),
    sdk: read(path.join(PACKAGE_ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json")),
  };
  return cachedVersions;
}

export class KgflowError extends Error {}

export interface RunOptions {
  root: string;
  taskFile: string;
  planApproval?: boolean;
  dryRun?: boolean;
  agent: AgentRunner;
  /** Ajanları çalıştıran araç (Jira imzası ve rapor için) */
  backend?: "claude" | "cursor";
  log: Logger;
  confirm?: (question: string) => Promise<boolean>;
  now?: () => Date;
  /** Testlerde kontrol komutlarını taklit etmek için */
  checkRunner?: CheckRunner;
  /** Testlerde fetch'i kapatmak için */
  noFetch?: boolean;
  /** Testlerde ~/.claude ve ~/.claude.json yerine */
  home?: string;
  /** Push'u kapat (testler / --no-push) */
  noPush?: boolean;
  /** Testlerde Jira'yı taklit etmek için */
  jira?: { fetchFn?: (url: string, init: any) => Promise<any>; email?: string; token?: string };
}

interface PhaseCost {
  phase: string;
  role: RoleName | "kontroller";
  iteration?: number;
  costUsd: number;
  sessionId?: string;
  verdict?: string;
  models?: string[];
}

export interface RunSummary {
  status: "success" | "failed" | "dry-run";
  id: string;
  backend?: "claude" | "cursor";
  baseBranch?: string;
  baseRef?: string;
  branch?: string;
  worktree?: string;
  runDir?: string;
  baseSha?: string;
  projectDocs: string[];
  commits: string[];
  totalCostUsd: number;
  iterations: number;
  phases: PhaseCost[];
  checks: CheckResult[][];
  denials: Denial[];
  error?: string;
  jiraKey?: string;
  pushed?: boolean;
  branchUrl?: string;
  prUrl?: string;
  jiraCommentUrl?: string;
  warnings: string[];
  /** Reviewer'ın onayladığı içeriğin tree hash'i (resume için) */
  approvedTree?: string;
  /** İşi başlatan kişi (git user.name / user.email) */
  initiator?: string;
}

const CONVENTIONAL = /^(feat|fix|test|refactor|docs|chore|perf|style|build|ci)(\([a-zA-Z0-9._/-]+\))?!?: .+/;
const PLAN_SMELLS = /git (commit|push)|sub-?skill|superpowers|subagent/i;
const LESSONS_FILE = path.join(KGFLOW_DIR, "lessons.md");

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/ı/g, "i").replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ş/g, "s").replace(/ö/g, "o").replace(/ç/g, "c")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .split("-")
      // kelime ortasından kesme: 50 karakteri aşmayan kadar kelime
      .reduce((acc, w) => (acc && (acc + "-" + w).length > 50 ? acc : acc ? acc + "-" + w : w.slice(0, 50)), "")
      .replace(/-$/, "") || "gorev"
  );
}

/**
 * Önceki başarısız çalıştırmadan kalan, hiç commit'i olmayan branch'i ve
 * worktree'lerini temizler (kaybedilecek iş yok). Commit'i olan branch'e dokunmaz.
 */
export function cleanupStaleBranch(root: string, branch: string, baseSha: string, log: Logger): boolean {
  const tip = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root);
  if (tip.code !== 0) return true; // yok, kullanılabilir
  if (git(["rev-list", "--count", `${baseSha}..${branch}`], root).stdout.trim() !== "0") return false;
  const list = git(["worktree", "list", "--porcelain"], root).stdout.split("\n\n");
  for (const entry of list) {
    if (!entry.includes(`branch refs/heads/${branch}`)) continue;
    const wtPath = /^worktree (.+)$/m.exec(entry)?.[1];
    if (!wtPath) continue;
    if (statusPorcelain(wtPath, ["node_modules"]).length) {
      // commit'lenmemiş iş var: silme, arşiv adıyla sakla ve ismi boşalt
      const archived = `kgflow-arsiv/${branch}-${Date.now().toString(36)}`;
      if (git(["branch", "-m", branch, archived], root).code === 0) {
        log.info(`Önceki başarısız çalıştırmanın branch'i arşivlendi: ${archived} (worktree: ${wtPath})`);
        return true;
      }
      return false;
    }
    git(["worktree", "remove", "--force", wtPath], root);
    git(["worktree", "remove", "--force", path.join(path.dirname(wtPath), "base")], root);
  }
  git(["worktree", "prune"], root);
  const del = git(["branch", "-D", branch], root);
  if (del.code === 0) log.info(`Önceki başarısız çalıştırmadan kalan boş branch temizlendi: ${branch}`);
  return del.code === 0;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Görev dosyasından Jira anahtarı: "Jira: IDT-1234" satırı ya da başlıktaki ilk anahtar */
export function jiraKey(task: string): string {
  const explicit = /^\s*(?:<!--\s*)?jira\s*:\s*([A-Z][A-Z0-9]+-\d+)/im.exec(task);
  if (explicit) return explicit[1];
  const title = task.split("\n").find((l) => l.startsWith("#")) ?? "";
  return /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(title)?.[1] ?? "";
}

/** Görev başlığından slug (dosya adı yerine) */
function taskSlug(task: string, fallback: string): string {
  const title = (task.split("\n").find((l) => l.startsWith("#")) ?? "").replace(/^#+\s*/, "").replace(/^görev\s*:\s*/i, "");
  const cleaned = title.replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, "").trim();
  return slugify(cleaned || fallback);
}

export function branchNameFor(pattern: string, vars: { jira: string; slug: string; date: string }): string {
  const p = !vars.jira && pattern.includes("{{jira}}") ? "kgflow/{{slug}}-{{date}}" : pattern;
  return p.replace(/\{\{jira\}\}/g, vars.jira).replace(/\{\{slug\}\}/g, vars.slug).replace(/\{\{date\}\}/g, vars.date);
}

function readLessons(root: string): string {
  const f = path.join(root, LESSONS_FILE);
  if (!fs.existsSync(f)) return "";
  const t = fs.readFileSync(f, "utf8").trim();
  return t.length > 3000 ? "…\n" + t.slice(-3000) : t;
}

function appendLessons(root: string, task: string, lessons: string[], date: Date): void {
  if (lessons.length === 0) return;
  const f = path.join(root, LESSONS_FILE);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const head = fs.existsSync(f)
    ? ""
    : "# kgflow dersleri\n\nReviewer'ın ve otomatik kontrollerin reddettiği konular. Developer ve reviewer bu dosyayı her çalıştırmada görür. Ekiple paylaşmak için commit'leyebilirsin.\n";
  fs.appendFileSync(f, `${head}\n## ${date.toISOString().slice(0, 10)} · ${task}\n${lessons.map((l) => `- ${l}`).join("\n")}\n`);
}

function linkInto(srcRoot: string, dstRoot: string, dirs: string[]): string[] {
  const linked: string[] = [];
  for (const d of dirs) {
    const src = path.join(srcRoot, d);
    const dst = path.join(dstRoot, d);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    fs.symlinkSync(fs.realpathSync.native(src), dst, "dir");
    linked.push(d);
  }
  return linked;
}

const LOCKFILES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"];

/**
 * Worktree'ye bağlanan klasörler (ör. node_modules symlink'i) .gitignore'daki "node_modules/"
 * desenine uymaz (symlink klasör değildir) ve ajanlara "takip edilmeyen dosya" gibi görünür.
 * Bunları deponun ortak .git/info/exclude dosyasına kök-çapalı ekler ("/node_modules").
 * Ana çalışma klasöründe zaten yok sayılan klasörler olduğu için davranış değişmez.
 */
export function ensureExcluded(root: string, dirs: string[]): void {
  if (!dirs.length) return;
  const common = path.resolve(root, gitOk(["rev-parse", "--git-common-dir"], root));
  const file = path.join(common, "info", "exclude");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = new Set(current.split("\n").map((l) => l.trim()));
  const add = dirs.map((d) => `/${d.replace(/^\/+|\/+$/g, "")}`).filter((l) => !lines.has(l));
  if (!add.length) return;
  fs.appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}# kgflow: yok sayılan yollar\n${add.join("\n")}\n`);
}

export async function runTask(opts: RunOptions): Promise<RunSummary> {
  const { root, log, agent } = opts;
  const now = opts.now ?? (() => new Date());
  const cfg = loadConfig(root);
  const home = opts.home ?? os.homedir();
  cfg.mcp.servers = expandServerNames(cfg.mcp.servers, root, home);
  const roles = loadRoles(root, cfg);

  const taskPath = path.resolve(root, opts.taskFile);
  if (!fs.existsSync(taskPath)) throw new KgflowError(`Görev dosyası yok: ${opts.taskFile}`);
  const taskText = fs.readFileSync(taskPath, "utf8");
  const slug = taskSlug(taskText, path.basename(taskPath, path.extname(taskPath)));
  const jira = jiraKey(taskText);
  const date = stamp(now());
  const id = `${slugify(jira || "gorev")}-${slug}-${date}`.replace(/^gorev-/, "");
  const summary: RunSummary = { status: "failed", id, projectDocs: [], commits: [], totalCostUsd: 0, iterations: 0, phases: [], checks: [], denials: [], warnings: [], jiraKey: jira || undefined };

  // ───────────── base branch ─────────────
  if (git(["rev-parse", "--is-inside-work-tree"], root).code !== 0) throw new KgflowError("Bu klasör bir git deposu değil.");
  const baseBranch = cfg.baseBranch || detectBaseBranch(root);
  if (!baseBranch) throw new KgflowError("Base branch bulunamadı (production/main/master yok). kgflow.yaml'da baseBranch belirt.");
  if (cfg.fetch && !opts.noFetch && !opts.dryRun && git(["remote"], root).stdout.includes("origin")) {
    const f = git(["fetch", "--quiet", "origin", baseBranch], root);
    if (f.code !== 0) log.warn(`origin/${baseBranch} çekilemedi (${f.stderr.trim().split("\n")[0]}); yerel kopya kullanılacak.`);
  }
  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  const baseRef = git(["rev-parse", "--verify", "--quiet", remoteRef], root).code === 0 ? `origin/${baseBranch}` : baseBranch;
  if (git(["rev-parse", "--verify", "--quiet", baseRef], root).code !== 0) throw new KgflowError(`Base branch yok: ${baseRef}`);
  const baseSha = gitOk(["rev-parse", baseRef], root);
  const wanted = branchNameFor(cfg.branchName, { jira, slug, date });
  let branch = wanted;
  if (!opts.dryRun) cleanupStaleBranch(root, wanted, baseSha, log);
  for (let n = 2; git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root).code === 0; n++) branch = `${wanted}-${n}`;
  if (branch !== wanted) log.warn(`${wanted} zaten var ve içinde commit'ler var; yeni branch: ${branch}`);
  Object.assign(summary, { baseBranch, baseRef, baseSha, branch });
  const who = [git(["config", "user.name"], root).stdout.trim(), git(["config", "user.email"], root).stdout.trim()].filter(Boolean);
  summary.initiator = who.length === 2 ? `${who[0]} <${who[1]}>` : who[0];
  summary.backend = opts.backend ?? "claude";

  const workBase = workDirFor(cfg, root);
  const runDir = path.join(workBase, id);
  const wt = path.join(runDir, "wt");
  const baseWt = path.join(runDir, "base");
  const runRoot = path.join(runDir, "run");
  const files = { task: path.join(runRoot, "task.md"), plan: path.join(runRoot, "plan.md"), rules: path.join(runRoot, "rules.md"), mutant: path.join(runRoot, "mutant"), summary: path.join(runRoot, "summary.md") };
  const vars: Record<string, string | boolean> = {
    taskFile: files.task,
    planFile: files.plan,
    rulesFile: files.rules,
    mutantDir: files.mutant,
    summaryFile: files.summary,
    testCmd: cfg.commands.testRelated,
    typecheckCmd: cfg.commands.typecheck,
    lintCmd: cfg.commands.lint,
    editPaths: cfg.paths.edit.join(", "),
    mutation: cfg.mutation.enabled,
    lessons: readLessons(root),
    baseBranch: baseRef,
    memory: "",
  };
  const { servers: userMcp, missing: missingMcp } = loadMcpServers(cfg.mcp.servers, root, home);
  if (Object.keys(userMcp).length) {
    const tools = Object.keys(userMcp).flatMap((srv) => cfg.mcp.tools.map((t) => `mcp__${srv}__${t}`));
    vars.memory = `Kod hafızası araçları kullanılabilir: ${tools.join(", ")}. Hafıza, geliştiricinin yerel kopyasından ` +
      `indekslenmiştir ve güncel olmayabilir; ilgili kodu hızlı bulmak için kullan, ama kararını her zaman çalışma ` +
      `kopyasındaki dosyayı okuyarak ver. Hafızanın döndürdüğü ${root} yolları otomatik olarak çalışma kopyasına çevrilir.`;
  }

  log.info(`Base: ${baseRef} (${baseSha.slice(0, 7)}) → yeni branch: ${branch}`);
  if (opts.dryRun) {
    log.step("DRY RUN — ajan çalıştırılmaz");
    const { text, docs } = composeRules(cfg, root, root, home);
    if (cfg.mcp.servers.length) log.info(`MCP: ${Object.keys(userMcp).join(", ") || "—"}${missingMcp.length ? ` (bulunamadı: ${missingMcp.join(", ")})` : ""}`);
    log.info(`Proje kural dosyaları: ${docs.join(", ") || "yok"}`);
    for (const r of Object.values(roles)) {
      log.info(`\n[${r.name}] kaynak: ${r.source}${r.model ? ` · model: ${r.model}` : ""}`);
      log.info(`  araçlar  : ${r.perms.tools.join(", ")}`);
      log.info(`  yazabilir: ${r.perms.edit.join(", ") || "—"}`);
      log.info(`  bash     : ${r.perms.bash.join(" | ") || "—"}`);
      log.detail(render(r.promptTemplate, { ...vars, feedback: "", checks: "(otomatik kontrol sonuçları)" }));
    }
    log.detail("\n──── rules.md ────\n" + text);
    summary.status = "dry-run";
    summary.projectDocs = docs;
    return summary;
  }

  const dirty = statusPorcelain(root, cfg.linkDirs).filter((l) => !l.slice(3).startsWith(LESSONS_FILE));
  if (dirty.length) log.warn(`Yerel çalışma alanında ${dirty.length} commit'lenmemiş değişiklik var; bu çalışma onları İÇERMEZ (temiz ${baseRef} üzerinden başlar).`);

  // ───────────── temiz çalışma alanı ─────────────
  fs.mkdirSync(runRoot, { recursive: true });
  gitOk(["worktree", "add", "-q", wt, "-b", branch, baseSha], root);
  gitOk(["worktree", "add", "-q", "--detach", baseWt, baseSha], root);
  summary.worktree = wt;
  summary.runDir = runDir;
  fs.copyFileSync(taskPath, files.task);
  log.ok(`Temiz çalışma alanı: ${wt}`);

  const saveSummary = () => fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(summary, null, 2));
  const fail = (msg: string): never => {
    summary.status = "failed";
    summary.error = msg;
    saveSummary();
    throw new KgflowError(`${msg}\n  Çalışma alanı incelemen için bırakıldı: ${wt}`);
  };

  // bağımlılıklar: lock dosyası base ile aynıysa repodakini bağla, değilse kur
  const lockSame = LOCKFILES.every((lf) => {
    const local = path.join(root, lf);
    const atBase = git(["show", `${baseSha}:${lf}`], root);
    if (!fs.existsSync(local)) return atBase.code !== 0;
    return atBase.code === 0 && atBase.stdout === fs.readFileSync(local, "utf8");
  });
  if (cfg.linkDirs.length && lockSame && cfg.linkDirs.every((d) => fs.existsSync(path.join(root, d)))) {
    const l = linkInto(root, wt, cfg.linkDirs);
    linkInto(root, baseWt, cfg.linkDirs);
    log.ok(`Bağımlılıklar repodan bağlandı: ${l.join(", ")}`);
  } else if (cfg.commands.install) {
    log.info(`Bağımlılık kurulumu: ${cfg.commands.install}${lockSame ? "" : " (lock dosyası base'den farklı)"}`);
    const s = runConfigured(cfg.commands.install, wt, undefined, { fullEnv: true }); // özel npm registry token'ı gerekebilir
    if (s.code !== 0) fail(`Kurulum başarısız: ${s.stderr.trim().split("\n").slice(-5).join(" / ")}`);
    linkInto(wt, baseWt, cfg.linkDirs);
  }
  const X = cfg.linkDirs; // git işlemlerinde hariç tutulacak symlink'ler
  ensureExcluded(root, X);
  if (opts.backend === "cursor") ensureExcluded(root, [".cursor/hooks.json", ".cursor/cli.json"]); // kgflow'un geçici yetki dosyaları
  if (statusPorcelain(wt, X).length) fail("Kurulum izlenen dosyaları değiştirdi (ör. lock dosyası).");

  const { text: rulesText, docs } = composeRules(cfg, root, baseWt, home);
  if (missingMcp.length) log.warn(`MCP sunucusu bulunamadı (~/.claude.json): ${missingMcp.join(", ")} — onsuz devam ediliyor.`);
  if (Object.keys(userMcp).length) log.info(`Ajanlara açılan MCP: ${Object.keys(userMcp).join(", ")} (araçlar: ${cfg.mcp.tools.join(", ")}; roller: ${cfg.mcp.roles.join(", ")})`);
  fs.writeFileSync(files.rules, rulesText);
  summary.projectDocs = docs;
  log.info(`Proje kuralları: ${docs.length ? docs.join(", ") : "bulunamadı"}${cfg.rules.length ? " + " + cfg.rules.join(", ") : ""}`);

  // bağlanan bağımlılık klasörleri (node_modules vb.) ajanların inceleme alanı değil
  const policy: PolicyContext = { repoRoot: wt, runRoot, readDeny: [...cfg.paths.readDeny, ...X.flatMap((d) => [d, `${d}/**`])], forbiddenFlags: DEFAULT_FORBIDDEN_FLAGS, aliasRoot: root };
  const checks = new ScopedChecks(cfg, wt, baseWt, opts.checkRunner);
  const changed = () => changedExisting(wt, X);
  const atBase = (fs_: string[]) => fs_.filter((f) => fs.existsSync(path.join(baseWt, f)));
  const mutant = cfg.mutation.enabled
    ? new MutantSandbox(wt, files.mutant, () => fillFiles(cfg.commands.testRelated, changed()), X, cfg.mutation.testTimeoutSec)
    : undefined;

  const budgetLeft = () => cfg.budgets.total - summary.totalCostUsd;
  const call = async (role: RoleSpec, phase: string, phaseBudgetLeft: number, extraVars: Record<string, string> = {}, iteration?: number): Promise<AgentResult> => {
    const budget = Math.min(phaseBudgetLeft, budgetLeft());
    if (budget <= 0.01) fail(`Bütçe bitti (${phase}). Harcanan: $${summary.totalCostUsd.toFixed(2)}`);
    const req: AgentRequest = {
      role: role.name,
      persona: role.persona,
      prompt: render(role.promptTemplate, { ...vars, ...extraVars }),
      cwd: wt,
      runRoot,
      perms: role.perms,
      policy,
      model: role.model,
      budgetUsd: budget,
      isolation: cfg.isolation,
      claudeMd: false,
      mutant: role.name === "reviewer" ? mutant : undefined,
      extraMcpServers: cfg.mcp.roles.includes(role.name) ? userMcp : undefined,
      log,
    };
    const res = await agent.run(req);
    summary.totalCostUsd += res.costUsd;
    summary.denials.push(...res.denials);
    summary.phases.push({ phase, role: role.name, iteration, costUsd: res.costUsd, sessionId: res.sessionId, models: res.models });
    log.info(`  ${role.name}: $${res.costUsd.toFixed(2)}${res.sessionId ? ` · oturum: ${res.sessionId}` : ""}${res.denials.length ? ` · ${res.denials.length} reddedilen işlem` : ""}`);
    if (!res.ok) fail(`${role.name} hata ile bitti: ${res.error ?? "bilinmiyor"}`);
    saveSummary();
    return res;
  };

  // ───────────── 1) ANALİST ─────────────
  log.step("1/3 ANALİST  (okur, plan yazar — kod değiştiremez)");
  const h0 = workingTreeHash(wt, X);
  await call(roles.analist, "analist", cfg.budgets.analist);
  if (workingTreeHash(wt, X) !== h0) fail("Analist kod değiştirdi! Rol ihlali.");
  if (!fs.existsSync(files.plan) || !fs.readFileSync(files.plan, "utf8").trim()) fail("Analist plan yazmadı.");
  log.ok("Plan hazır, kod değişmedi.");
  const planText = fs.readFileSync(files.plan, "utf8");
  if (PLAN_SMELLS.test(planText)) log.warn("Plan rollerle çelişen talimat içeriyor (commit/push ya da dış skill). Developer bunları uygulayamaz.");
  if (opts.planApproval) {
    log.info("\n──── PLAN ────\n" + planText + "\n──────────────");
    const yes = opts.confirm ? await opts.confirm("Plan uygun mu, geliştirmeye geçilsin mi?") : false;
    if (!yes) fail(`Plan onaylanmadı. Plan: ${files.plan}`);
  }

  // ───────────── 2) DEVELOPER ⇄ (KONTROLLER) ⇄ REVIEWER ─────────────
  log.step("2/3 DEVELOPER ⇄ REVIEWER  (geliştirir/inceler — commit atamaz)");
  const editMatch = picomatch(cfg.paths.edit, { dot: true });
  const assertDevScope = (who: string) => {
    if (headSha(wt) !== baseSha) fail(`${who} commit attı! Rol ihlali.`);
    const outside = changedPaths(wt, X).filter((p) => !editMatch(p));
    if (outside.length) fail(`${who} izinli yollar dışında değişiklik yaptı: ${outside.join(", ")}`);
  };
  let feedback = "";
  let passed = false;
  let gelistirSpent = 0;
  for (let i = 1; i <= cfg.maxIterations; i++) {
    summary.iterations = i;
    log.info(`\n· Tur ${i}/${cfg.maxIterations}`);
    const d = await call(roles.developer, "gelistir", cfg.budgets.gelistir - gelistirSpent, { feedback }, i);
    gelistirSpent += d.costUsd;
    assertDevScope("Developer");

    // Deterministik, işe odaklı kontroller
    const files_ = changed();
    if (files_.length === 0) {
      feedback = "Hiçbir dosya değişmedi. Görevi uygula.";
      log.warn("Developer hiçbir şey değiştirmedi.");
      continue;
    }
    const results: CheckResult[] = [checks.format(files_)];
    assertDevScope("Formatter");
    const after = changed();
    results.push(checks.tests(after, atBase(after)), checks.typecheck(after), checks.lint(after, atBase(after)));
    summary.checks.push(results);
    const report = renderReport(results);
    for (const r of results) (r.status === "fail" ? log.warn : log.info)(`  kontrol · ${r.name}: ${r.summary}`);
    if (results.some((r) => r.status === "fail")) {
      feedback = `OTOMATİK KONTROLLER başarısız (reviewer'a gidilmedi). Sadece bu işle gelen sorunlar:\n${report}`;
      appendLessons(root, slug, results.filter((r) => r.status === "fail").map((r) => `❌ ${r.name}: ${r.summary}`), now());
      saveSummary();
      continue;
    }

    const beforeReview = workingTreeHash(wt, X);
    const r = await call(roles.reviewer, "gelistir", cfg.budgets.gelistir - gelistirSpent, { checks: report }, i);
    gelistirSpent += r.costUsd;
    if (workingTreeHash(wt, X) !== beforeReview) fail("Reviewer gerçek dosyaları değiştirdi! Rol ihlali.");
    if (headSha(wt) !== baseSha) fail("Reviewer commit attı! Rol ihlali.");

    const v = parseVerdict(r.text);
    summary.phases[summary.phases.length - 1].verdict = v.verdict;
    if (v.verdict === "PASS") {
      passed = true;
      log.ok(`Reviewer PASS (tur ${i})`);
      break;
    }
    log.warn(`Reviewer FAIL (tur ${i})${v.explicit ? "" : " — VERDICT satırı yok"}`);
    log.detail(v.feedback);
    feedback = v.feedback;
    appendLessons(root, slug, extractLessons(v.feedback), now());
  }
  if (!passed) fail(`${cfg.maxIterations} turda onay alınamadı. Son geri bildirim run.json ve ${LESSONS_FILE} içinde.`);
  if (statusPorcelain(wt, X).length === 0) fail("Onay geldi ama hiçbir değişiklik yok.");
  const approved = workingTreeHash(wt, X);
  log.ok(`Onaylanan içerik: ${approved.slice(0, 12)}`);

  summary.approvedTree = approved;
  saveSummary();
  return commitAndDeliver({ cfg, root, wt, baseWt, baseSha, baseBranch, branch, jira, X, approved, summary, saveSummary, fail, call, committer: roles.committer, log, opts, files, taskText });
}

interface CommitCtx {
  cfg: ReturnType<typeof loadConfig>;
  root: string;
  wt: string;
  baseWt: string;
  baseSha: string;
  baseBranch: string;
  branch: string;
  jira: string;
  X: string[];
  approved: string;
  summary: RunSummary;
  saveSummary: () => void;
  fail: (msg: string) => never;
  call: (role: RoleSpec, phase: string, budget: number) => Promise<AgentResult>;
  committer: RoleSpec;
  log: Logger;
  opts: RunOptions;
  files: { summary: string };
  taskText?: string;
}

/** Jira'dan üretilmiş görev dosyasındaki "Kaynak: https://x.atlassian.net/browse/KEY" satırından adres */
export function jiraBaseFromTask(task: string): string {
  return /^Kaynak:\s*(https:\/\/[^/\s]+)\/browse\//m.exec(task)?.[1] ?? "";
}

async function commitAndDeliver(ctx: CommitCtx): Promise<RunSummary> {
  const { cfg, root, wt, baseWt, baseSha, baseBranch, branch, jira, X, approved, summary, saveSummary, fail, call, log, opts, files } = ctx;
  // ───────────── 3) COMMITTER ─────────────
  log.step("3/3 COMMITTER  (sadece git add/commit — kod değiştiremez)");
  const c = await call(ctx.committer, "commit", cfg.budgets.commit);
  if (/COMMIT İPTAL/i.test(c.text)) fail(`Committer iptal etti: ${c.text.split("\n").find((l) => /COMMIT İPTAL/i.test(l))}`);
  if (headSha(wt) === baseSha) fail("Committer hiç commit atmadı.");
  const leftover = statusPorcelain(wt, X);
  const hooks = fs.existsSync(path.join(wt, ".husky")) ? " Commit hook'u (husky/lint-staged) dosya değiştirmiş olabilir." : "";
  if (leftover.length) fail(`Commit sonrası değişiklik kaldı: ${leftover.map((l) => l.slice(3)).slice(0, 10).join(", ")}.${hooks}`);
  if (gitOk(["rev-parse", "HEAD^{tree}"], wt) !== approved) fail(`Commit'lenen içerik reviewer'ın onayladığıyla AYNI DEĞİL!${hooks}`);
  if (gitOk(["rev-list", "--merges", `${baseSha}..HEAD`], wt)) fail("Merge commit oluşmuş; beklenmiyor.");
  const subjects = gitOk(["log", "--format=%s", `${baseSha}..HEAD`], wt).split("\n").filter(Boolean);
  if (cfg.commands.commitCheck) {
    const chk = runConfigured(cfg.commands.commitCheck.replace(/\{\{base\}\}/g, baseSha), wt);
    if (chk.code !== 0) fail(`Commit kontrolü başarısız (${cfg.commands.commitCheck}):\n${(chk.stdout + chk.stderr).trim()}`);
  } else {
    const bad = subjects.filter((s) => !CONVENTIONAL.test(s));
    if (bad.length) fail(`Conventional Commits'e uymayan mesaj: ${bad.join(" | ")}`);
  }
  log.ok("Commit'ler onaylanan içerikle birebir aynı.");

  summary.commits = gitOk(["log", "--format=%h %s", `${baseSha}..HEAD`], wt).split("\n").filter(Boolean);
  summary.status = "success";
  // Başarılı: branch kalır, worktree'ler kaldırılır → kullanıcı branch'e kendi repo'sunda geçebilir
  git(["worktree", "remove", "--force", baseWt], root);
  git(["worktree", "remove", "--force", wt], root);
  saveSummary();

  // ───────────── gönder ve bildir ─────────────
  const links = remoteLinks(root);
  const hasOrigin = git(["remote", "get-url", "origin"], root).code === 0;
  if (cfg.push && hasOrigin && !opts.noPush) {
    const p = git(["push", "-u", "origin", `refs/heads/${branch}:refs/heads/${branch}`], root);
    if (p.code === 0) {
      summary.pushed = true;
      summary.branchUrl = links?.branch(branch);
      summary.prUrl = links?.pr(branch, baseBranch);
      log.ok(`Push edildi: origin/${branch}`);
    } else {
      const w = `Push başarısız: ${p.stderr.trim().split("\n").slice(-2).join(" / ")}`;
      summary.warnings.push(w);
      log.warn(w);
    }
  } else if (cfg.push && !hasOrigin) {
    summary.warnings.push("push atlandı: origin remote'u yok");
  }

  const jiraBase = cfg.jira.baseUrl || jiraBaseFromTask(ctx.taskText ?? "") || jiraBaseUrl(cfg);
  if (jira && cfg.jira.comment && jiraBase) {
    const body = buildJiraComment(fs.existsSync(files.summary) ? fs.readFileSync(files.summary, "utf8") : "", summary, links);
    try {
      summary.jiraCommentUrl = await postComment(jira, jiraBase, body, opts.jira ?? {});
      log.ok(`Jira'ya yorum eklendi: ${jira}`);
    } catch (e) {
      const w = `Jira yorumu eklenemedi: ${(e as Error).message}`;
      summary.warnings.push(w);
      log.warn(w);
    }
  }
  saveSummary();
  return summary;
}

/**
 * Onaylanmış ama commit aşamasında yarım kalmış bir çalıştırmayı sürdürür:
 * analist/developer/reviewer tekrar çalışmaz; sadece committer + push + Jira.
 */
export async function resumeRun(opts: RunOptions & { resume: string }): Promise<RunSummary> {
  const { root, log, agent } = opts;
  const cfg = loadConfig(root);
  const home = opts.home ?? os.homedir();
  cfg.mcp.servers = expandServerNames(cfg.mcp.servers, root, home);
  const roles = loadRoles(root, cfg);
  const runDir = fs.existsSync(path.join(opts.resume, "run.json"))
    ? opts.resume
    : [...workDirsFor(cfg, root), workDirFor(cfg, root)].map((d) => path.join(d, opts.resume)).find((d) => fs.existsSync(path.join(d, "run.json"))) ?? path.join(workDirFor(cfg, root), opts.resume);
  const jsonPath = path.join(runDir, "run.json");
  if (!fs.existsSync(jsonPath)) throw new KgflowError(`Çalıştırma bulunamadı: ${opts.resume} (kgflow runs ile listele)`);
  const summary = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as RunSummary;
  summary.warnings = summary.warnings ?? [];
  if (opts.backend) summary.backend = opts.backend;
  if (summary.status === "success") throw new KgflowError("Bu çalıştırma zaten başarıyla bitmiş.");
  const wt = path.join(runDir, "wt");
  const baseWt = path.join(runDir, "base");
  const runRoot = path.join(runDir, "run");
  if (!fs.existsSync(wt)) throw new KgflowError(`Çalışma klasörü yok: ${wt}`);
  const { baseSha, baseBranch, branch } = summary as Required<Pick<RunSummary, "baseSha" | "baseBranch" | "branch">>;
  const lastReview = [...summary.phases].reverse().find((p) => p.role === "reviewer");
  const lastDev = [...summary.phases].reverse().find((p) => p.role === "developer");
  // Reviewer onayı yoksa: developer'ın son hâli üzerinden kontroller + reviewer tekrar çalışır
  const needsReview = lastReview?.verdict !== "PASS" || (lastDev && summary.phases.lastIndexOf(lastDev) > summary.phases.lastIndexOf(lastReview!));
  if (needsReview && !lastDev) throw new KgflowError("Bu çalıştırmada henüz kod yazılmamış; baştan çalıştır: kgflow run ...");

  const X = cfg.linkDirs;
  ensureExcluded(root, X);
  if (opts.backend === "cursor") ensureExcluded(root, [".cursor/hooks.json", ".cursor/cli.json"]); // kgflow'un geçici yetki dosyaları
  if (headSha(wt) !== baseSha) gitOk(["reset", "-q", "--soft", baseSha], wt); // yarım kalmış commit'leri geri al, dosyalar aynen kalır
  gitOk(["reset", "-q"], wt); // stage'i temizle
  const current = workingTreeHash(wt, X);
  if (!needsReview) {
    if (!summary.approvedTree) log.warn("Eski sürümle başlatılmış çalıştırma: onaylanan içerik olarak mevcut çalışma kopyası kabul edildi.");
    if (current !== (summary.approvedTree ?? current)) throw new KgflowError("Çalışma kopyası reviewer'ın onayladığı içerikten farklı; resume edilemez.");
  }

  const files = { task: path.join(runRoot, "task.md"), plan: path.join(runRoot, "plan.md"), summary: path.join(runRoot, "summary.md"), mutant: path.join(runRoot, "mutant"), rules: path.join(runRoot, "rules.md") };
  const vars: Record<string, string | boolean> = {
    taskFile: files.task, planFile: files.plan, summaryFile: files.summary, rulesFile: files.rules, mutantDir: files.mutant,
    testCmd: cfg.commands.testRelated, typecheckCmd: cfg.commands.typecheck, lintCmd: cfg.commands.lint, editPaths: cfg.paths.edit.join(", "),
    mutation: cfg.mutation.enabled, lessons: readLessons(root), baseBranch: summary.baseRef ?? baseBranch, memory: "",
  };
  const { servers: userMcp } = needsReview ? loadMcpServers(cfg.mcp.servers, root, home) : { servers: {} };
  if (Object.keys(userMcp).length) {
    const tools = Object.keys(userMcp).flatMap((srv) => cfg.mcp.tools.map((t) => `mcp__${srv}__${t}`));
    vars.memory = `Kod hafızası araçları kullanılabilir: ${tools.join(", ")}. Hafıza güncel olmayabilir; kararını her zaman çalışma kopyasındaki dosyayı okuyarak ver.`;
  }
  const policy: PolicyContext = { repoRoot: wt, runRoot, readDeny: [...cfg.paths.readDeny, ...X.flatMap((d) => [d, `${d}/**`])], forbiddenFlags: DEFAULT_FORBIDDEN_FLAGS, aliasRoot: root };
  const saveSummary = () => fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
  const fail = (msg: string): never => {
    summary.status = "failed";
    summary.error = msg;
    saveSummary();
    throw new KgflowError(`${msg}\n  Çalışma alanı incelemen için bırakıldı: ${wt}`);
  };
  summary.error = undefined;
  const changed = () => changedExisting(wt, X);
  const mutant = needsReview && cfg.mutation.enabled
    ? new MutantSandbox(wt, files.mutant, () => fillFiles(cfg.commands.testRelated, changed()), X, cfg.mutation.testTimeoutSec)
    : undefined;
  const call = async (role: RoleSpec, phase: string, budget: number, extraVars: Record<string, string> = {}): Promise<AgentResult> => {
    const res = await agent.run({
      role: role.name, persona: role.persona, prompt: render(role.promptTemplate, { ...vars, ...extraVars }), cwd: wt, runRoot, perms: role.perms, policy,
      model: role.model, budgetUsd: budget, isolation: cfg.isolation, claudeMd: false, log,
      mutant: role.name === "reviewer" ? mutant : undefined,
      extraMcpServers: cfg.mcp.roles.includes(role.name) && Object.keys(userMcp).length ? userMcp : undefined,
    });
    summary.totalCostUsd += res.costUsd;
    summary.denials.push(...res.denials);
    summary.phases.push({ phase, role: role.name, costUsd: res.costUsd, sessionId: res.sessionId, models: res.models });
    log.info(`  ${role.name}: $${res.costUsd.toFixed(2)}${res.denials.length ? ` · ${res.denials.length} reddedilen işlem` : ""}`);
    if (!res.ok) fail(`${role.name} hata ile bitti: ${res.error ?? "bilinmiyor"}`);
    saveSummary();
    return res;
  };

  let approved = summary.approvedTree ?? current;
  if (needsReview) {
    // Developer'ın son hâli: güncel kgflow.yaml ile otomatik kontroller, sonra reviewer
    log.step("SÜRDÜR · otomatik kontroller + reviewer (analist/developer tekrar çalışmaz)");
    if (!fs.existsSync(baseWt)) throw new KgflowError(`Base kopya yok: ${baseWt}`);
    const editMatch = picomatch(cfg.paths.edit, { dot: true });
    const outside = changedPaths(wt, X).filter((p) => !editMatch(p));
    if (outside.length) fail(`İzinli yollar dışında değişiklik var: ${outside.join(", ")}`);
    const fs_ = changed();
    if (!fs_.length) fail("Çalışma kopyasında değişiklik yok.");
    const atBase = (l: string[]) => l.filter((f) => fs.existsSync(path.join(baseWt, f)));
    const checks = new ScopedChecks(cfg, wt, baseWt, opts.checkRunner);
    const results: CheckResult[] = [checks.format(fs_)];
    const after = changed();
    results.push(checks.tests(after, atBase(after)), checks.typecheck(after), checks.lint(after, atBase(after)));
    summary.checks.push(results);
    for (const r of results) (r.status === "fail" ? log.warn : log.info)(`  kontrol · ${r.name}: ${r.summary}`);
    const report = renderReport(results);
    if (results.some((r) => r.status === "fail")) fail(`Otomatik kontroller hâlâ başarısız:\n${report}`);
    const before = workingTreeHash(wt, X);
    const r = await call(roles.reviewer, "gelistir", Math.min(cfg.budgets.gelistir, cfg.budgets.total), { checks: report });
    if (workingTreeHash(wt, X) !== before) fail("Reviewer gerçek dosyaları değiştirdi! Rol ihlali.");
    if (headSha(wt) !== baseSha) fail("Reviewer commit attı! Rol ihlali.");
    const v = parseVerdict(r.text);
    summary.phases[summary.phases.length - 1].verdict = v.verdict;
    if (v.verdict !== "PASS") {
      log.detail(v.feedback);
      appendLessons(root, summary.id, extractLessons(v.feedback), (opts.now ?? (() => new Date()))());
      fail(`Reviewer FAIL. Geri bildirim run.json içinde; düzeltme için yeniden çalıştır: kgflow run ${summary.jiraKey ?? "<görev>"}`);
    }
    log.ok("Reviewer PASS");
    approved = workingTreeHash(wt, X);
    summary.approvedTree = approved;
    saveSummary();
  }
  log.ok(`Sürdürülüyor: ${summary.id} · branch ${branch} · onaylanan içerik ${approved.slice(0, 12)}`);
  const taskFile = path.join(runRoot, "task.md");
  const taskText = fs.existsSync(taskFile) ? fs.readFileSync(taskFile, "utf8") : "";
  return commitAndDeliver({ cfg, root, wt, baseWt, baseSha, baseBranch, branch, jira: summary.jiraKey ?? "", X, approved, summary, saveSummary, fail, call, committer: roles.committer, log, opts, files, taskText });
}
