import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWithBudget, type AgentResult } from "./agent.js";
import { jiraBaseUrl, loadConfig, relatedPath, isGitRepo, workDirFor, workDirsFor } from "./config.js";
import { git, gitOk, workingTreeHash } from "./git.js";
import { postComment } from "./jira.js";
import { listItems, sectionLines } from "./notes.js";
import {
  FlowloopError,
  MAX_PLAN_ROUNDS,
  branchNameFor,
  jiraBaseFromTask,
  jiraKey,
  slugify,
  stamp,
  taskSlug,
  runTask,
  type PlanDecision,
  type RunOptions,
  type RunSummary,
} from "./orchestrator.js";
import { DEFAULT_FORBIDDEN_FLAGS, type PolicyContext } from "./policy.js";
import { composeRules } from "./projectdocs.js";
import { resolveQuestions, type QuestionRecord } from "./questions.js";
import { RelatedRepo } from "./related.js";
import { PACKAGE_ROOT, loadRoles, render } from "./roles.js";
import { detectBaseBranch } from "./tech.js";
import { expandServerNames, loadMcpServers } from "./usermcp.js";

/**
 * Toplu çalışma: birbirine bağlı birden fazla görev.
 *
 *   1. Toplu plan: analist bütün görevleri birlikte okur; sırayı, bağımlılıkları ve bütün açık
 *      soruları TEK seferde çıkarır. Sorular bir kez cevaplanır, plan (istenirse) onaylanır.
 *   2. Görevler planlanan sırayla, AYNI branch'te, her biri kendi akışıyla (analist → developer ⇄
 *      reviewer → onay → committer) yürütülür. Her görev öncekinin commit'lerinin üzerinden başlar;
 *      toplu plan, cevaplar ve tamamlanan görevlerin özetleri görev bağlamına eklenir.
 *   3. Bir görev durursa çalışma durur; aynı komut tekrar çalıştırılınca tamamlananlar atlanır.
 */

export const BATCH_PREFIX = "batch-";
export const BATCH_FILE = "batch.json";

export interface BatchTask {
  key: string;
  file: string;
  title: string;
  status: "pending" | "success" | "failed";
  runId?: string;
  commits?: string[];
  error?: string;
  jiraCommentUrl?: string;
  /** Committer'ın özeti (sonraki görevlerin bağlamı) */
  summaryText?: string;
  /** Görev başlarken branch'in ucu (yoksa base): başarısız denemenin yarım commit'lerini ayırmak için */
  startSha?: string;
}

export interface BatchState {
  id: string;
  dir: string;
  /** Verildiği sıra */
  keys: string[];
  /** Toplu plandaki sıra */
  order: string[];
  branch: string;
  baseBranch: string;
  baseRef: string;
  baseSha: string;
  status: "planning" | "running" | "success" | "failed";
  /** Toplu plan tamamlandı (sorular cevaplandı, plan onaylandı, sıra belli) */
  planned: boolean;
  tasks: BatchTask[];
  questions: QuestionRecord[];
  questionsUrls?: string[];
  planFeedback: { round: number; comment: string }[];
  warnings: string[];
  totalCostUsd: number;
  prUrl?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

export interface BatchOptions extends Omit<RunOptions, "taskFile" | "batch" | "planApproval"> {
  taskFiles: string[];
  /** Toplu planı onaya sun */
  planApproval?: boolean;
  /** Her görevin kendi planını da onaya sun */
  approveEachPlan?: boolean;
  /** Branch adı (boş = ilk görevden, flowloop.yaml → branchName) */
  branch?: string;
  /** Yarım kalmış aynı toplu çalışmayı sürdürme, baştan başla */
  restart?: boolean;
  /** Üst iş (epic) görev dosyası: toplu plana bağlam olarak verilir */
  epicFile?: string;
  /** Tekrar çalıştırma komutu (mesajlar için) */
  rerun?: string;
}

/** Toplu plandaki "## Sıra" bölümünden görev sırası; eksik görevler sona eklenir */
export function parseBatchOrder(plan: string, keys: string[]): { order: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const lines = sectionLines(plan, /^s[ıi]ra$|^order$|^uygulama s[ıi]ras[ıi]/i);
  const order: string[] = [];
  for (const item of lines ? listItems(lines) : []) {
    const k = keys.find((x) => new RegExp(`(^|[^A-Za-z0-9-])${x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`).test(item.split("\n")[0]));
    if (k && !order.includes(k)) order.push(k);
  }
  if (!lines) warnings.push(`Toplu planda "## Sıra" bölümü yok; görevler verildiği sırayla yapılacak.`);
  const missing = keys.filter((k) => !order.includes(k));
  if (lines && missing.length) warnings.push(`Toplu plandaki sırada olmayan görevler sona eklendi: ${missing.join(", ")}`);
  return { order: [...order, ...missing], warnings };
}

function readTask(file: string, root: string): { key: string; text: string; title: string } {
  const abs = path.resolve(root, file);
  if (!fs.existsSync(abs)) throw new FlowloopError(`Görev dosyası yok: ${file}`);
  const text = fs.readFileSync(abs, "utf8");
  const key = jiraKey(text) || path.basename(abs, path.extname(abs));
  const title = (text.split("\n").find((l) => l.startsWith("#")) ?? key).replace(/^#+\s*/, "").replace(/^görev\s*:\s*/i, "").trim();
  return { key, text, title };
}

/** Aynı görev kümesiyle başlatılmış ve bitmemiş toplu çalışma */
export function findUnfinishedBatch(dirs: string[], keys: string[]): BatchState | undefined {
  const want = [...keys].sort().join(",");
  const found: BatchState[] = [];
  for (const base of dirs) {
    for (const id of fs.readdirSync(base)) {
      if (!id.startsWith(BATCH_PREFIX)) continue;
      const f = path.join(base, id, BATCH_FILE);
      if (!fs.existsSync(f)) continue;
      try {
        const s = JSON.parse(fs.readFileSync(f, "utf8")) as BatchState;
        if (s.status !== "success" && [...s.keys].sort().join(",") === want) found.push(s);
      } catch {
        /* bozuk kayıt */
      }
    }
  }
  return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** Bir toplu çalışmanın görevine ait en son çalıştırma kaydı */
function latestTaskRun(dirs: string[], batchId: string, key: string): RunSummary | undefined {
  let best: { s: RunSummary; t: string } | undefined;
  for (const base of dirs) {
    for (const id of fs.readdirSync(base)) {
      const f = path.join(base, id, "run.json");
      if (id.startsWith(BATCH_PREFIX) || !fs.existsSync(f)) continue;
      try {
        const s = JSON.parse(fs.readFileSync(f, "utf8")) as RunSummary;
        if (s.batch?.id !== batchId || s.batch.keys[s.batch.index - 1] !== key) continue;
        const t = s.startedAt ?? "";
        if (!best || t > best.t) best = { s, t };
      } catch {
        /* bozuk kayıt */
      }
    }
  }
  return best?.s;
}

export async function runBatch(opts: BatchOptions): Promise<BatchState> {
  const { root, log, agent } = opts;
  const now = opts.now ?? (() => new Date());
  const home = opts.home ?? os.homedir();
  const cfg = loadConfig(root);
  cfg.mcp.servers = expandServerNames(cfg.mcp.servers, root, home);
  if (git(["rev-parse", "--is-inside-work-tree"], root).code !== 0) throw new FlowloopError("Bu klasör bir git deposu değil.");

  const tasks = opts.taskFiles.map((f) => ({ file: f, ...readTask(f, root) }));
  if (tasks.length < 2) throw new FlowloopError("Toplu çalışma için en az iki görev gerekir.");
  const keys = tasks.map((t) => t.key);
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) throw new FlowloopError(`Aynı görev iki kez verildi: ${dup}`);
  const rerun = opts.rerun ?? `flowloop run ${keys.join(" ")}`;
  const workBase = workDirFor(cfg, root);

  let state = opts.restart ? undefined : findUnfinishedBatch(workDirsFor(cfg, root), keys);
  const save = () => {
    fs.mkdirSync(state!.dir, { recursive: true });
    fs.writeFileSync(path.join(state!.dir, BATCH_FILE), JSON.stringify(state, null, 2));
  };
  const fail = (msg: string): never => {
    state!.status = "failed";
    state!.error = msg;
    save();
    throw new FlowloopError(msg);
  };

  if (state) {
    const done = state.tasks.filter((t) => t.status === "success").length;
    log.ok(`Yarım kalan toplu çalışma sürdürülüyor: ${state.id} (${done}/${state.tasks.length} görev tamam, branch ${state.branch})`);
    log.info(`  Baştan başlamak için: ${rerun} --restart`);
    state.error = undefined;
    state.status = state.planned ? "running" : "planning";
    // görev dosyaları (ör. --refresh ile) güncellenmiş olabilir
    for (const t of state.tasks) t.file = tasks.find((x) => x.key === t.key)?.file ?? t.file;
  } else {
    // ───────────── base ve branch ─────────────
    const baseBranch = cfg.baseBranch || detectBaseBranch(root);
    if (!baseBranch) throw new FlowloopError("Base branch bulunamadı (production/main/master yok). flowloop.yaml'da baseBranch belirt.");
    if (cfg.fetch && !opts.noFetch && !opts.dryRun && git(["remote"], root).stdout.includes("origin")) {
      const f = git(["fetch", "--quiet", "origin", baseBranch], root);
      if (f.code !== 0) log.warn(`origin/${baseBranch} çekilemedi (${f.stderr.trim().split("\n")[0]}); yerel kopya kullanılacak.`);
    }
    const baseRef = git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${baseBranch}`], root).code === 0 ? `origin/${baseBranch}` : baseBranch;
    if (git(["rev-parse", "--verify", "--quiet", baseRef], root).code !== 0) throw new FlowloopError(`Base branch yok: ${baseRef}`);
    const baseSha = gitOk(["rev-parse", baseRef], root);
    const date = stamp(now());
    const wanted = opts.branch || branchNameFor(cfg.branchName, { jira: jiraKey(tasks[0].text), slug: taskSlug(tasks[0].text, tasks[0].key), date });
    if (git(["check-ref-format", "--branch", wanted], root).code !== 0) throw new FlowloopError(`Geçersiz branch adı: ${wanted}`);
    let branch = wanted;
    for (let n = 2; git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root).code === 0; n++) branch = `${wanted}-${n}`;
    if (branch !== wanted) log.warn(`${wanted} zaten var; toplu çalışma için yeni branch: ${branch}`);
    const id = `${BATCH_PREFIX}${slugify(keys[0])}-${keys.length}-gorev-${date}`;
    state = {
      id, dir: path.join(workBase, id), keys, order: [...keys], branch, baseBranch, baseRef, baseSha, status: "planning", planned: false,
      tasks: tasks.map((t) => ({ key: t.key, file: t.file, title: t.title, status: "pending" })),
      questions: [], planFeedback: [], warnings: [], totalCostUsd: 0, createdAt: now().toISOString(),
    };
  }

  log.step(`TOPLU ÇALIŞMA · ${keys.length} görev · branch ${state.branch} (base ${state.baseRef} ${state.baseSha.slice(0, 7)})`);
  for (const t of tasks) log.info(`  - ${t.key}  ${t.title}`);
  if (opts.dryRun) return state;
  save();

  const runRoot = path.join(state.dir, "run");
  fs.mkdirSync(runRoot, { recursive: true });
  const planFile = path.join(runRoot, "plan.md");
  const contextFile = path.join(runRoot, "answers-context.md");

  // ───────────── 1) TOPLU PLAN ─────────────
  if (!state.planned) {
    const planWt = path.join(state.dir, "plan-wt");
    if (!fs.existsSync(planWt)) gitOk(["worktree", "add", "-q", "--detach", planWt, state.baseSha], root);
    const removePlanWt = () => {
      git(["worktree", "remove", "--force", planWt], root);
      git(["worktree", "prune"], root);
    };
    try {
      await planBatch();
    } finally {
      if (state.planned) removePlanWt();
    }

    async function planBatch(): Promise<void> {
      const st = state!;
      const roles = loadRoles(root, cfg);
      const role = roles.analist;
      const rulesFile = path.join(runRoot, "rules.md");
      fs.writeFileSync(rulesFile, composeRules(cfg, root, planWt, home).text);
      const tasksFile = path.join(runRoot, "tasks.md");
      const epicText = opts.epicFile && fs.existsSync(path.resolve(root, opts.epicFile)) ? fs.readFileSync(path.resolve(root, opts.epicFile), "utf8") : "";
      const tasksText = [
        ...(epicText ? [`# Üst iş (epic) — bağlam\n\n${epicText.trim()}`] : []),
        ...tasks.map((t) => t.text.trim()),
      ].join("\n\n---\n\n");
      fs.writeFileSync(tasksFile, tasksText + "\n");
      const X = cfg.linkDirs;
      // planlamada ilgili repolar olduğu yerden SADECE okunur (analistin yazma yetkisi yalnızca plan dosyası)
      const relatedRoots = cfg.related.map((r) => {
        const p = relatedPath(root, r.path);
        return { name: r.name, root: p, readDeny: RelatedRepo.projectSettings(p).readDeny, git: isGitRepo(p), edit: r.edit };
      });
      const policy: PolicyContext = {
        repoRoot: planWt, runRoot, readDeny: [...cfg.paths.readDeny, ...X.flatMap((d) => [d, `${d}/**`])], forbiddenFlags: DEFAULT_FORBIDDEN_FLAGS, aliasRoot: root,
        extraRoots: relatedRoots.map((r) => ({ name: r.name, root: r.root, readDeny: r.readDeny })),
      };
      const { servers: userMcp } = loadMcpServers(cfg.mcp.servers, root, home);
      const vars: Record<string, string | boolean> = {
        planFile, tasksFile, rulesFile, count: String(tasks.length), keys: keys.join(", "), editPaths: cfg.paths.edit.join(", "),
        related: relatedRoots.length
          ? "İlgili repolar (planlamada SADECE OKUNUR; görevlerin geliştirmesinde flowloop.yaml'daki yetkilerle değiştirilebilir):\n" +
            relatedRoots.map((r) => `- ${r.name}: \`${r.root}\`${r.edit.length ? ` — değiştirilebilir yollar: ${r.edit.join(", ")}` : " — sadece okunur"}`).join("\n") +
            "\nBir görev ilgili repoda değişiklik gerektiriyorsa bunu o görevin notlarına yaz."
          : "",
        memory: Object.keys(userMcp).length && cfg.mcp.roles.includes("analist")
          ? `Kod hafızası araçları kullanılabilir (${Object.keys(userMcp).join(", ")}); kararını her zaman dosyayı okuyarak ver.`
          : "",
      };
      const template = fs.readFileSync(path.join(PACKAGE_ROOT, "templates", "batch-plan.md"), "utf8");
      let budgetLeft = cfg.budgets.analist * Math.max(1, Math.ceil(tasks.length / 3));
      const runPlanner = async (feedback = ""): Promise<AgentResult> => {
        const h0 = workingTreeHash(planWt, X);
        const message = `# Görevler (${tasks.length})\n\n${tasksText}\n\n---\n\n# Bu çalıştırmada senden istenen\n\n${render(template, { ...vars, planFeedback: feedback })}`;
        const res = await runWithBudget(agent, {
          role: "analist", persona: role.persona, ruleset: role.ruleset, prompt: message, cwd: planWt, runRoot, perms: role.perms, policy,
          model: role.model, budgetUsd: Math.max(0.05, budgetLeft), isolation: cfg.isolation, claudeMd: false, log,
          extraMcpServers: cfg.mcp.roles.includes("analist") && Object.keys(userMcp).length ? userMcp : undefined,
          extraDirs: relatedRoots.map((r) => r.root),
        }, { extendBudget: opts.extendBudget, totalSpentBefore: st.totalCostUsd, onExtend: (x) => (budgetLeft += x) });
        st.totalCostUsd += res.costUsd;
        budgetLeft -= res.costUsd;
        log.info(`  analist (toplu plan): $${res.costUsd.toFixed(2)}${res.denials.length ? ` · ${res.denials.length} reddedilen işlem` : ""}`);
        if (!res.ok) fail(res.budgetExceeded ? `Toplu plan için ayrılan bütçe doldu ($${st.totalCostUsd.toFixed(2)}). flowloop.yaml → budgets.analist'i artır.` : `Analist hata ile bitti: ${res.error ?? "bilinmiyor"}`);
        if (workingTreeHash(planWt, X) !== h0) fail("Analist kod değiştirdi! Rol ihlali.");
        if (!fs.existsSync(planFile) || !fs.readFileSync(planFile, "utf8").trim()) fail("Analist toplu plan yazmadı.");
        save();
        return res;
      };

      log.step("1/2 TOPLU PLAN  (analist bütün görevleri birlikte okur — kod değiştiremez)");
      if (fs.existsSync(planFile) && fs.readFileSync(planFile, "utf8").trim()) log.ok("Toplu plan önceki denemeden kullanılıyor.");
      else await runPlanner();

      const jiraBase = cfg.jira.baseUrl || jiraBaseFromTask(tasks[0].text) || jiraBaseUrl(cfg, home);
      const jiraKeys = jiraBase ? keys.filter((k) => /^[A-Z][A-Z0-9]+-\d+$/.test(k)) : [];
      const ask = () =>
        resolveQuestions({
          planFile, runRoot, mode: opts.questionsMode ?? cfg.questions, ask: opts.answerQuestions, jiraKeys,
          postToJira: (key, body) => postComment(key, jiraBase, body, opts.jira ?? {}),
          footer: `🤖 flowloop toplu planlama (${keys.join(", ")})`,
          records: st.questions, log,
          reanalyze: async (fb) => void (await runPlanner(fb)),
          appendContext: (block) => fs.appendFileSync(contextFile, block.trim() + "\n\n"),
          save, fail, rerun, onPosted: (urls) => void (st.questionsUrls = urls),
        });
      await ask();

      if (opts.planApproval) {
        for (let round = 1; ; round++) {
          const planText = fs.readFileSync(planFile, "utf8");
          log.info("\n──── TOPLU PLAN" + (round > 1 ? ` (${round}. sürüm)` : "") + " ────\n" + planText + "\n──────────────");
          const d: PlanDecision = opts.reviewPlan
            ? await opts.reviewPlan(planText, { round, reused: false })
            : (await opts.confirm?.("Toplu plan uygun mu, görevlere geçilsin mi?")) ? { action: "approve" } : { action: "cancel" };
          if (d.action === "approve") break;
          if (d.action === "cancel") fail(`Toplu plan onaylanmadı. Plan saklandı; aynı komutla yeniden çalıştırınca bu plandan devam edilir.\n  Plan: ${planFile}`);
          if (d.action !== "revise" || !d.comment.trim()) continue;
          if (round >= MAX_PLAN_ROUNDS) fail(`Toplu plan ${MAX_PLAN_ROUNDS} kez yenilendi ama onaylanmadı. Plan: ${planFile}`);
          st.planFeedback.push({ round, comment: d.comment.trim() });
          save();
          log.step(`ANALİST  (yorumunla toplu planı güncelliyor — ${round}. tur)`);
          const history = st.planFeedback.length > 1
            ? "Önceki turlardaki yorumlar (hâlâ geçerli):\n" + st.planFeedback.slice(0, -1).map((f) => `- ${f.comment.replace(/\n/g, "\n  ")}`).join("\n") + "\n\nSon yorum:\n"
            : "";
          await runPlanner(history + d.comment.trim());
          await ask();
        }
      }

      const { order, warnings } = parseBatchOrder(fs.readFileSync(planFile, "utf8"), keys);
      for (const w of warnings) log.warn(w);
      st.warnings.push(...warnings);
      st.order = order;
      st.planned = true;
      st.status = "running";
      save();
      log.ok(`Sıra: ${order.join(" → ")}`);
    }
  }

  // ───────────── 2) GÖREVLER ─────────────
  log.step(`2/2 GÖREVLER  (sırayla, aynı branch'te: ${state.branch})`);
  const dirs = () => workDirsFor(cfg, root);
  const total = state.order.length;
  for (let i = 0; i < total; i++) {
    const key = state.order[i];
    const t = state.tasks.find((x) => x.key === key)!;
    if (t.status === "success") continue;
    // görev bu arada "flowloop resume" ile tamamlanmış olabilir
    const prevRun = latestTaskRun(dirs(), state.id, key);
    if (prevRun?.status === "success") {
      record(t, prevRun);
      log.ok(`${key} daha önce tamamlanmış (${prevRun.id}); atlanıyor.`);
      continue;
    }
    if (prevRun) discardFailedAttempt(t, prevRun);
    const tip = git(["rev-parse", "--verify", "--quiet", `refs/heads/${state.branch}`], root);
    t.startSha = tip.code === 0 ? tip.stdout.trim() : state.baseSha;
    save();
    log.step(`TOPLU ${i + 1}/${total} · ${key} — ${t.title}`);
    let s: RunSummary;
    try {
      s = await runTask({
        ...opts,
        taskFile: t.file,
        planApproval: opts.approveEachPlan ?? false,
        batch: { id: state.id, index: i + 1, total, keys: state.order, branch: state.branch, context: batchContext(state, t, i) },
      });
    } catch (e) {
      if (!(e instanceof FlowloopError)) throw e;
      t.status = "failed";
      t.error = e.message;
      const r = latestTaskRun(dirs(), state.id, key);
      if (r) {
        t.runId = r.id;
        state.totalCostUsd += r.totalCostUsd ?? 0;
      }
      const left = state.order.slice(i + 1);
      fail(
        `${key} tamamlanamadı (${i + 1}/${total}): ${e.message}\n\n` +
          `  Toplu çalışma durdu.${left.length ? ` Sıradaki görevler bekliyor: ${left.join(", ")}` : ""}\n` +
          (r?.approvedTree ? `  Bu görev commit onayında kaldıysa önce: flowloop resume ${r.id}\n` : "") +
          `  Devam etmek için aynı komutu tekrar çalıştır (tamamlanan görevler atlanır): ${rerun}`,
      );
      return state; // fail fırlatır; tip için
    }
    record(t, s);
    state.totalCostUsd += s.totalCostUsd;
    save();
  }
  state.status = "success";
  state.finishedAt = now().toISOString();
  save();
  return state;

  /**
   * Görevin önceki başarısız denemesi: çalışma kopyaları branch'i tuttuğu için kaldırılır; denemenin
   * branch'e eklediği (onaylanmamış) commit'ler arşiv branch'ine alınır ve branch görevin başladığı
   * noktaya döner. Onay ya da commit aşamasında kalmış deneme silinmez: önce resume edilmelidir.
   */
  function discardFailedAttempt(t: BatchTask, r: RunSummary): void {
    if (r.approvedTree) {
      fail(
        `${t.key} önceki denemede onay/commit aşamasında kaldı; iş kaybolmasın diye silinmedi.\n` +
          `  Önce tamamla: flowloop resume ${r.id}\n  Sonra aynı komutla devam et: ${rerun}`,
      );
    }
    const wts = [r.worktree, r.runDir ? path.join(r.runDir, "base") : undefined].filter((x): x is string => !!x && fs.existsSync(x));
    for (const w of wts) git(["worktree", "remove", "--force", w], root);
    for (const rel of r.related ?? []) {
      if (rel.git === false) continue;
      for (const w of [rel.wt, rel.baseWt]) if (w && fs.existsSync(w)) git(["worktree", "remove", "--force", w], rel.root);
      git(["worktree", "prune"], rel.root);
    }
    git(["worktree", "prune"], root);
    if (wts.length) log.info(`${t.key}: önceki başarısız denemenin çalışma kopyası kaldırıldı (${r.id}); görev baştan yapılacak.`);
    const expected = t.startSha ?? state!.baseSha;
    const tip = git(["rev-parse", "--verify", "--quiet", `refs/heads/${state!.branch}`], root);
    if (tip.code === 0 && tip.stdout.trim() !== expected) {
      const archive = `flowloop-arsiv/${state!.branch}-${slugify(t.key)}-${Date.now().toString(36)}`;
      gitOk(["branch", archive, tip.stdout.trim()], root);
      gitOk(["branch", "-f", state!.branch, expected], root);
      log.warn(`${t.key}: başarısız denemenin onaylanmamış commit'leri ${archive} branch'ine alındı; ${state!.branch} görevin başladığı noktaya döndü.`);
    }
  }

  function record(t: BatchTask, s: RunSummary): void {
    t.status = "success";
    t.runId = s.id;
    t.error = undefined;
    t.commits = [...s.commits, ...(s.related ?? []).flatMap((r) => (r.commits ?? []).map((c) => `${r.name}: ${c}`))];
    t.jiraCommentUrl = s.jiraCommentUrl;
    const sf = s.runDir ? path.join(s.runDir, "run", "summary.md") : "";
    if (sf && fs.existsSync(sf)) t.summaryText = fs.readFileSync(sf, "utf8").trim().slice(0, 1500);
    state!.prUrl = s.prUrl ?? state!.prUrl;
  }

  function batchContext(st: BatchState, t: BatchTask, i: number): string {
    const plan = fs.existsSync(planFile) ? fs.readFileSync(planFile, "utf8").trim() : "";
    const answers = fs.existsSync(contextFile) ? fs.readFileSync(contextFile, "utf8").trim() : "";
    const done = st.order.slice(0, i).map((k) => st.tasks.find((x) => x.key === k)!).filter((x) => x.status === "success");
    return [
      `## Toplu çalışma (${i + 1}/${st.order.length})`,
      "",
      `Bu görev, aynı branch'te (\`${st.branch}\`) sırayla yapılan ${st.order.length} görevlik bir çalışmanın parçası.`,
      `Sıra: ${st.order.map((k) => (k === t.key ? `**${k}** (bu görev)` : k)).join(" → ")}`,
      "Önceki görevlerin değişiklikleri çalışma kopyasında zaten commit'li: onları bozma, tekrar yapma. Sonraki görevlerin işini bu görevde yapma; sadece BU görevin kapsamını uygula.",
      "",
      "### Toplu plan",
      "",
      (plan.length > 15000 ? plan.slice(0, 15000) + "\n…(kısaltıldı)" : plan).replace(/^(#{1,4}) /gm, "##$1 "),
      ...(answers ? ["", "### Toplu planlamada açık sorulara verilen cevaplar", "", answers.replace(/^(#{1,4}) /gm, "##$1 ")] : []),
      ...(done.length
        ? ["", "### Bu çalışmada tamamlanan görevler", "", ...done.map((d) => `- ${d.key} — ${d.title}\n${(d.commits ?? []).map((c) => `  - ${c}`).join("\n")}${d.summaryText ? `\n  Özet: ${d.summaryText.replace(/\s*\n\s*/g, " ").slice(0, 600)}` : ""}`)]
        : []),
    ].join("\n");
  }
}
