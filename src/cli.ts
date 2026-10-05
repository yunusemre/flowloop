#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { SdkAgentRunner, type AgentRunner } from "./agent.js";
import { BackendError, chooseBackend, createRunner, type Backend } from "./backend.js";
import type { MutantContext } from "./cursor.js";
import { MutantSandbox } from "./mutant.js";
import { currentVersion, readInstallInfo, runUpdate, updateNotice } from "./update.js";
import { printStatus, runSetup, systemDeps, terminalIO } from "./setup.js";
import { CONFIG_FILE, ConfigError, DEFAULT_PROJECT_DOCS, KGFLOW_DIR, jiraBaseUrl, ensureGitignore, loadConfig, migrateLegacyProject, workDirFor, workDirsFor , globalJiraBase, parseJiraLink } from "./config.js";
import { findProjectDocs } from "./projectdocs.js";
import { mergeConfig } from "./configmerge.js";
import { detectBaseBranch, detectProject, renderConfig } from "./tech.js";
import { detectMemoryServers, expandServerNames, loadMcpServers, userClaudeMdPath } from "./usermcp.js";

import { git } from "./git.js";
import { color, consoleLogger } from "./log.js";
import { KgflowError, ensureExcluded, resumeRun, runTask, type PlanDecision, type RunSummary } from "./orchestrator.js";
import { PACKAGE_ROOT, loadRoles } from "./roles.js";
import { JIRA_KEY, JiraError, fetchIssue, issueToTask } from "./jira.js";

const HELP = `kgflow — rol bazlı AI geliştirme ekibi (analist → developer ⇄ reviewer → committer)

Kullanım:
  kgflow init [--force]            Projenin teknolojilerini algılar, .kgflow/kgflow.yaml oluşturur
  kgflow check                     Yapılandırmayı doğrular, rollerin yetkilerini gösterir
  kgflow task <JIRA-123>           Jira kaydından .kgflow/tasks/JIRA-123.md görev dosyasını üretir
  kgflow run <görev.md | JIRA-123 | Jira bağlantısı> [seçenek]  Görevi ekiple çalıştırır (Jira anahtarı verilirse önce görevi çeker)
      --refresh                  Görev dosyası varsa bile Jira'dan yeniden çek
      --no-push                  Bu çalıştırmada push yapma (kgflow.yaml'daki push: true'yu ezer)
      --plan-onayi               Plan yazıldıktan sonra onay ister
      --agent claude|cursor      Ajan aracını seç (varsayılan: kgflow.yaml → agent: auto)
      --dry-run                  Ajan çalıştırmadan prompt ve yetkileri gösterir
      -v, --verbose              Ajanların çıktısını canlı gösterir
  kgflow resume <id> [-v] [--agent claude|cursor]
                                   Yarım kalan çalıştırmayı sürdürür (kontroller → reviewer → commit → push → Jira)
  kgflow runs                      Bu repo için yapılan çalıştırmaları listeler
  kgflow setup [--force]           Hesap bilgilerini (Claude/Cursor, Jira, git, Bitbucket) adım adım kurar
  kgflow setup --check             Hesapların durumunu gösterir (soru sormaz)
  kgflow update                    kgflow'u kurulduğu kaynaktan günceller
  kgflow --version                 Sürümü ve kurulum kaynağını gösterir
  kgflow clean [--all]             Merge edilmiş (ya da --all ile tüm) çalıştırmaların worktree'lerini siler
`;

function repoRoot(): string {
  const r = git(["rev-parse", "--show-toplevel"], process.cwd());
  if (r.code !== 0) throw new KgflowError("Bir git deposunun içinde çalıştır.");
  return r.stdout.trim();
}

function cmdInit(root: string, force: boolean): void {
  const cfgPath = path.join(root, CONFIG_FILE);
  if (fs.existsSync(cfgPath) && !force) throw new KgflowError(`${CONFIG_FILE} zaten var. Yeniden oluşturmak için: kgflow init --force`);
  const d = detectProject(root);
  const base = detectBaseBranch(root);
  const branchName = guessBranchPattern(root);
  fs.mkdirSync(path.join(root, KGFLOW_DIR, "tasks"), { recursive: true });
  const memory = detectMemoryServers(root);
  let text = renderConfig(d, base, branchName, memory, guessJiraBase(root) || globalJiraBase());
  let kept: string[] = [];
  if (fs.existsSync(cfgPath)) ({ text, kept } = mergeConfig(text, fs.readFileSync(cfgPath, "utf8")));
  fs.writeFileSync(cfgPath, text);
  const gi = ensureGitignore(root);
  const tpl = path.join(root, KGFLOW_DIR, "tasks", "_sablon.md");
  if (!fs.existsSync(tpl)) fs.copyFileSync(path.join(PACKAGE_ROOT, "templates", "task-template.md"), tpl);
  const docs = findProjectDocs(root, DEFAULT_PROJECT_DOCS);
  console.log(color.green(`✓ ${CONFIG_FILE} ${force ? "yeniden " : ""}oluşturuldu`));
  if (kept.length) console.log(color.dim(`  korunan ayarlar: ${kept.join(", ")}`));
  const giMsg = { created: ".gitignore oluşturuldu, .kgflow/ eklendi", added: ".kgflow/ .gitignore'a eklendi", renamed: ".gitignore'daki .ekip satırı .kgflow/ olarak güncellendi", exists: "" }[gi];
  if (giMsg) console.log(color.green(`✓ ${giMsg} (commit'lemeyi unutma)`));
  console.log(`  stack      : ${d.stack}`);
  for (const t of d.tech) console.log(`  teknoloji  : ${t}`);
  console.log(`  base       : ${base || color.yellow("bulunamadı — baseBranch'i elle yaz")}`);
  console.log(`  branch adı : ${branchName}`);
  console.log(`  proje kuralları: ${docs.length ? docs.join(", ") : "bulunamadı"} (otomatik dahil edilir)`);
  console.log(`  kişisel kurallar: ${fs.existsSync(userClaudeMdPath()) ? "~/.claude/CLAUDE.md (dahil edilir)" : "yok"}`);
  console.log(`  kod hafızası (MCP): ${memory.length ? memory.join(", ") + " (salt okuma araçlarıyla açılır)" : "bulunamadı"}`);
  for (const n of d.notes) console.log(color.yellow(`  ! ${n}`));
  console.log(`\nKomutları kontrol et: ${CONFIG_FILE}  →  kgflow check  →  kgflow run .kgflow/tasks/<görev>.md`);
}

/** Daha önce Jira'dan çekilmiş görev dosyalarından Jira adresini bulur */
function guessJiraBase(root: string): string {
  const dir = path.join(root, KGFLOW_DIR, "tasks");
  if (!fs.existsSync(dir)) return "";
  for (const f of fs.readdirSync(dir)) {
    const m = /^Kaynak:\s*(https:\/\/[^/\s]+)\/browse\//m.exec(fs.readFileSync(path.join(dir, f), "utf8"));
    if (m) return m[1];
  }
  return "";
}

/** Repodaki branch isimlerinden Jira kalıbını tahmin eder (ör. IDT-1234-...) */
function guessBranchPattern(root: string): string {
  const r = git(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], root);
  const jiraLike = r.stdout.split("\n").filter((b) => /(^|\/)[A-Z][A-Z0-9]+-\d+([-_]|$)/.test(b)).length;
  return jiraLike >= 3 ? "{{jira}}-{{slug}}" : "kgflow/{{slug}}-{{date}}";
}

/** .kgflow/tasks/<KEY>.md yoksa (ya da --refresh) Jira'dan üretir; varsa olduğu gibi kullanır (elle düzenlenmiş olabilir). */
async function ensureJiraTask(root: string, key: string, refresh = false, baseOverride?: string): Promise<string> {
  const rel = path.join(KGFLOW_DIR, "tasks", `${key}.md`);
  const abs = path.join(root, rel);
  if (fs.existsSync(abs) && !refresh) {
    console.log(color.dim(`Görev dosyası mevcut, o kullanılıyor: ${rel} (Jira'dan yeniden çekmek için --refresh)`));
    return rel;
  }
  const baseUrl = baseOverride || jiraBaseUrl(loadConfig(root));
  console.log(`Jira'dan çekiliyor: ${key}`);
  const issue = await fetchIssue(key, baseUrl);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, issueToTask(issue, new Date()));
  console.log(color.green(`✓ ${rel} oluşturuldu: ${issue.summary}`));
  if (!issue.acceptance) console.log(color.yellow("  ! Jira'da kabul kriteri alanı yok; analist açıklamadan çıkaracak. --plan-onayi ile kontrol etmen önerilir."));
  return rel;
}

/** Claude ya da Cursor: ayara, --agent'a ve erişime göre seçer */
function pickRunner(root: string, override: string | undefined, dryRun = false): { runner: AgentRunner; backend: Backend } {
  if (override && !["auto", "claude", "cursor"].includes(override)) throw new KgflowError(`--agent claude | cursor | auto olmalı (verilen: ${override})`);
  try {
    const r = createRunner(loadConfig(root), override);
    console.log(color.dim(`Ajan: ${r.backend === "cursor" ? "Cursor CLI" : "Claude (Agent SDK)"} — ${r.reason}`));
    return r;
  } catch (e) {
    if (dryRun && e instanceof BackendError) return { runner: new SdkAgentRunner(), backend: "claude" };
    if (e instanceof BackendError) throw new KgflowError(e.message);
    throw e;
  }
}

async function cmdRun(root: string, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "plan-onayi": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      refresh: { type: "boolean", default: false },
      "no-push": { type: "boolean", default: false },
      agent: { type: "string" },
    },
  });
  if (positionals.length !== 1) throw new KgflowError("Kullanım: kgflow run <görev.md | JIRA-123>");
  let taskFile = positionals[0];
  const link = parseJiraLink(taskFile); // https://sirket.atlassian.net/browse/IDT-1234 de verilebilir
  if (link) taskFile = await ensureJiraTask(root, link.key, values.refresh, link.base);
  else if (JIRA_KEY.test(taskFile)) taskFile = await ensureJiraTask(root, taskFile, values.refresh);
  const log = consoleLogger(values.verbose || values["dry-run"]);
  const confirm = async (q: string) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question(`${q} [e/H] `);
    rl.close();
    return /^[eEyY]$/.test(a.trim());
  };
  if (values["plan-onayi"] && !values["dry-run"] && !process.stdin.isTTY) throw new KgflowError("--plan-onayi etkileşimli bir terminal ister.");
  const ask = async (q: string) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question(q);
    rl.close();
    return a;
  };
  const readComment = async (): Promise<string> => {
    console.log(color.dim("Yorumunu yaz. Birden fazla satır olabilir; bitirmek için boş bir satırda Enter'a bas."));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
    const lines: string[] = [];
    rl.prompt();
    for await (const line of rl) {
      if (!line.trim()) break;
      lines.push(line);
      rl.prompt();
    }
    rl.close();
    return lines.join("\n");
  };
  const reviewPlan = async (_plan: string, ctx: { round: number; reused: boolean }): Promise<PlanDecision> => {
    const options = [
      "  [e] Onayla, geliştirmeye geç",
      "  [y] Yorum yaz — analist yorumunu değerlendirip planı güncellesin",
      ...(ctx.reused ? ["  [b] Bu planı kullanma, baştan analiz et"] : []),
      "  [h] İptal (plan saklanır; görevi yeniden çalıştırınca bu plandan devam edilir)",
    ];
    for (;;) {
      console.log(color.bold("\nPlan uygun mu?") + "\n" + options.join("\n"));
      const a = (await ask(`Seçimin [e/y${ctx.reused ? "/b" : ""}/h]: `)).trim().toLowerCase();
      if (a === "e" || a === "evet") return { action: "approve" };
      if (a === "y" || a === "yorum") {
        const comment = await readComment();
        if (comment.trim()) return { action: "revise", comment };
        console.log(color.yellow("Yorum boş; tekrar seç."));
        continue;
      }
      if (a === "b" && ctx.reused) return { action: "restart" };
      if (a === "h" || a === "hayır" || a === "hayir" || a === "iptal") return { action: "cancel" };
    }
  };
  const r = pickRunner(root, values.agent, values["dry-run"]);
  const s = await runTask({
    root,
    taskFile,
    planApproval: values["plan-onayi"],
    noPush: values["no-push"],
    dryRun: values["dry-run"],
    agent: r.runner,
    backend: r.backend,
    log,
    confirm,
    reviewPlan,
  });
  if (s.status === "dry-run") return 0;
  printDone(root, s, log);
  return 0;
}

function printDone(root: string, s: RunSummary, log: ReturnType<typeof consoleLogger>): void {
  log.step("BİTTİ");
  for (const c of s.commits) console.log(`  ${c}`);
  console.log(`
  Branch  : ${s.branch}
  Maliyet : ${s.backend === "cursor" ? "Cursor aboneliği (maliyet bildirilmez)" : "$" + s.totalCostUsd.toFixed(2)} · ${s.iterations} tur · ${s.denials.length} reddedilen işlem
  Kayıt   : ${path.join(s.runDir!, "run.json")}

  Push    : ${s.pushed ? `origin/${s.branch} ✓` : `yapılmadı → git push -u origin ${s.branch}`}${s.prUrl ? `\n  PR aç   : ${s.prUrl}` : ""}${s.jiraCommentUrl ? `\n  Jira    : ${s.jiraCommentUrl}` : ""}

  İncele  : git checkout ${s.branch}   ya da   git diff ${s.baseSha!.slice(0, 7)}..${s.branch}
  Temizle : kgflow clean   (merge edildikten sonra)`);
  for (const w of s.warnings) console.log(color.yellow(`  ! ${w}`));
  // yerel base, origin'den farklıysa uyar (ör. yerelde push'lanmamış commit)
  const local = git(["rev-parse", "--verify", "--quiet", `refs/heads/${s.baseBranch}`], root).stdout.trim();
  if (local && s.baseRef !== s.baseBranch && local !== s.baseSha) {
    const ahead = git(["rev-list", "--count", `${s.baseSha}..${local}`], root).stdout.trim();
    if (ahead !== "0") console.log(color.yellow(`\n  ! Yerel ${s.baseBranch} branch'inde origin'de olmayan ${ahead} commit var; bu iş onları içermez (temiz ${s.baseRef} üzerinden yapıldı). Yerelde birleştirmek yerine PR ile ilerle.`));
  }
  if (s.denials.length) {
    const groups = new Map<string, number>();
    for (const d of s.denials) groups.set(`${d.role} · ${d.tool}: ${d.input.slice(0, 90)}`, (groups.get(`${d.role} · ${d.tool}: ${d.input.slice(0, 90)}`) ?? 0) + 1);
    console.log(color.dim(`\n  Reddedilen işlemler (yetki dışı denemeler; hepsi engellendi):`));
    for (const [k, n] of groups) console.log(color.dim(`    - ${k}${n > 1 ? `  ×${n}` : ""}`));
  }
}

function listRuns(root: string): { id: string; dir: string; status: string; branch?: string; cost?: number }[] {
  return workDirsFor(loadConfig(root), root).flatMap((base) => fs.readdirSync(base).sort().map((id) => {
    const f = path.join(base, id, "run.json");
    const j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    return { id, dir: path.join(base, id), status: j.status ?? "yarım", branch: j.branch, cost: j.totalCostUsd };
  }));
}

function cmdClean(root: string, all: boolean): void {
  const cfg = loadConfig(root);
  for (const r of listRuns(root)) {
    const branch = r.branch ?? `kgflow/${r.id}`;
    const base = cfg.baseBranch || detectBaseBranch(root);
    const merged = [base, `origin/${base}`].some((b) => git(["merge-base", "--is-ancestor", branch, b], root).code === 0);
    if (!all && !merged) {
      console.log(color.dim(`  atlandı (merge edilmemiş): ${r.id}`));
      continue;
    }
    git(["worktree", "remove", "--force", path.join(r.dir, "wt")], root);
    git(["worktree", "remove", "--force", path.join(r.dir, "base")], root);
    git(["branch", merged ? "-d" : "-D", branch], root);
    fs.rmSync(r.dir, { recursive: true, force: true });
    console.log(color.green(`  silindi: ${r.id}`));
  }
  git(["worktree", "prune"], root);
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(HELP);
    return 0;
  }
  if (cmd === "--version" || cmd === "-V" || cmd === "version") {
    const i = readInstallInfo();
    console.log(`kgflow ${currentVersion()}${i ? color.dim(`  (${i.mode === "local" ? "yerel repo" : "kaynak"}: ${i.source}${i.commit ? " @ " + i.commit.slice(0, 7) : ""})`) : ""}`);
    return 0;
  }
  if (cmd === "update") return runUpdate();
  if (cmd === "setup") {
    const deps = systemDeps();
    if (rest.includes("--check")) return (await printStatus(deps, { log: console.log }, { network: true })) ? 0 : 1;
    if (!process.stdin.isTTY) throw new KgflowError("kgflow setup etkileşimli bir terminal ister (durum için: kgflow setup --check)");
    await runSetup(terminalIO(), deps, { force: rest.includes("--force") });
    return 0;
  }
  if (cmd === "run" || cmd === "check" || cmd === "init") {
    const notice = updateNotice();
    if (notice) console.log(color.yellow(`! ${notice}`));
  }
  const root = repoRoot();
  if (migrateLegacyProject(root)) console.log(color.yellow(`Eski .ekip klasörü ${KGFLOW_DIR}/ olarak taşındı (ekip.yaml → kgflow.yaml).`));
  if (git(["rev-parse", "--git-dir"], root).code === 0) ensureExcluded(root, [KGFLOW_DIR]); // .gitignore'a dokunmadan yerel olarak yok say
  switch (cmd) {
    case "init":
      cmdInit(root, rest.includes("--force"));
      return 0;
    case "check": {
      const cfg = loadConfig(root);
      cfg.mcp.servers = expandServerNames(cfg.mcp.servers, root);
      console.log(color.green(`✓ ${CONFIG_FILE} geçerli`) + color.dim(`  (stack: ${cfg.stack}, izolasyon: ${cfg.isolation ? "açık" : "KAPALI"})`));
      if (cfg.tech.trim()) console.log(color.dim(cfg.tech.trim()));
      try {
        const b = chooseBackend(cfg);
        console.log(`  ajan     : ${b.backend === "cursor" ? `Cursor CLI (${b.cursorBin})` : "Claude (Agent SDK)"} — ${b.reason}`);
      } catch (e) {
        console.log(color.yellow(`  ajan     : ${(e as Error).message}`));
      }
      await printStatus(systemDeps(jiraBaseUrl(cfg)), { log: console.log });
      const roles = loadRoles(root, cfg);
      for (const r of Object.values(roles)) {
        console.log(`\n${color.bold(r.name)} ${color.dim(`(${r.source}${r.model ? ", model: " + r.model : ""})`)}`);
        console.log(`  araçlar  : ${r.perms.tools.join(", ")}`);
        console.log(`  yazabilir: ${r.perms.edit.join(", ") || "—"}`);
        console.log(`  bash     : ${r.perms.bash.join(" | ") || "—"}`);
      }
      console.log(`\n  okunamaz : ${cfg.paths.readDeny.join(", ") || "—"}`);
      console.log(`  base     : ${cfg.baseBranch || detectBaseBranch(root) || "BULUNAMADI"} · branch adı: ${cfg.branchName}`);
      console.log(`  testler  : ${cfg.commands.testRelated}`);
      console.log(`  tip      : ${cfg.commands.typecheck || "—"}  (sadece yeni hatalar)`);
      console.log(`  lint     : ${cfg.commands.lint || "—"}  (sadece yeni hatalar)`);
      console.log(`  format   : ${cfg.commands.format || "—"}`);
      const docs = findProjectDocs(root, cfg.projectDocs);
      console.log(`  proje kuralları: ${docs.join(", ") || "—"}`);
      console.log(`  kişisel kurallar: ${cfg.userClaudeMd && fs.existsSync(userClaudeMdPath()) ? "~/.claude/CLAUDE.md" : "—"}`);
      const { servers, missing } = loadMcpServers(cfg.mcp.servers, root);
      console.log(`  MCP      : ${Object.keys(servers).join(", ") || "—"}${missing.length ? color.yellow(` (bulunamadı: ${missing.join(", ")})`) : ""}${Object.keys(servers).length ? ` · araçlar: ${cfg.mcp.tools.join(", ")} · roller: ${cfg.mcp.roles.join(", ")}` : ""}`);
      const found = detectMemoryServers(root).filter((n) => !cfg.mcp.servers.includes(n));
      if (found.length) console.log(color.dim(`             (tanımlı ama açılmamış hafıza sunucuları: ${found.join(", ")} → kgflow.yaml mcp.servers)`));
      console.log(`  çalışma  : ${workDirFor(cfg, root)}`);
      return 0;
    }
    case "task": {
      const arg = rest.find((a) => !a.startsWith("-"));
      const link = arg ? parseJiraLink(arg) : undefined;
      const key = link?.key ?? arg;
      if (!key || !JIRA_KEY.test(key)) throw new KgflowError("Kullanım: kgflow task <JIRA-123 | Jira bağlantısı> [--refresh]");
      const rel = await ensureJiraTask(root, key, rest.includes("--refresh"), link?.base);
      console.log(`İncele/düzenle: ${rel}  →  kgflow run ${key} --plan-onayi -v`);
      return 0;
    }
    case "run":
      return cmdRun(root, rest);
    case "__mutant": {
      // Cursor reviewer'ının mutasyon komutu (iç kullanım)
      const [action, ctxFile] = rest;
      const ctx = JSON.parse(fs.readFileSync(ctxFile, "utf8")) as MutantContext;
      const sb = new MutantSandbox(ctx.repoRoot, ctx.dir, () => ctx.testCmd, ctx.linkDirs, ctx.timeoutSec);
      if (action === "reset") {
        const r = sb.reset();
        console.log(`Kopya hazır: ${ctx.dir} (${r.files} dosya)`);
        return 0;
      }
      if (action === "test") {
        const r = sb.test();
        console.log(`exit=${r.code}\n${r.output}`);
        return 0;
      }
      throw new KgflowError("Kullanım: mutant reset | test");
    }
    case "resume": {
      const id = rest.find((a, i) => !a.startsWith("-") && rest[i - 1] !== "--agent");
      if (!id) throw new KgflowError("Kullanım: kgflow resume <çalıştırma-id>  (kgflow runs ile listele)");
      const log = consoleLogger(rest.includes("-v") || rest.includes("--verbose"));
      const ai = rest.findIndex((a) => a === "--agent" || a.startsWith("--agent="));
      const agentOpt = ai < 0 ? undefined : rest[ai].includes("=") ? rest[ai].split("=")[1] : rest[ai + 1];
      const r = pickRunner(root, agentOpt);
      const s = await resumeRun({ root, resume: id, taskFile: "", agent: r.runner, backend: r.backend, log, noPush: rest.includes("--no-push") });
      printDone(root, s, log);
      return 0;
    }
    case "runs":
      for (const r of listRuns(root)) console.log(`${r.status.padEnd(8)} ${r.id}  ${r.cost !== undefined ? "$" + r.cost.toFixed(2) : ""}`);
      return 0;
    case "clean":
      cmdClean(root, rest.includes("--all"));
      return 0;
    default:
      console.log(HELP);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof KgflowError || e instanceof ConfigError || e instanceof JiraError) {
      console.error(color.red("✗ " + e.message));
      process.exit(1);
    }
    console.error(e);
    process.exit(1);
  },
);
