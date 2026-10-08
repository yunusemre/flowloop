#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { SdkAgentRunner, type AgentRunner, type BudgetRequest } from "./agent.js";
import { BackendError, chooseBackend, createRunner, type Backend } from "./backend.js";
import type { MutantContext } from "./cursor.js";
import { MutantSandbox } from "./mutant.js";
import { RelatedRepo } from "./related.js";
import { currentVersion, readInstallInfo, runUpdate, updateNotice } from "./update.js";
import { printStatus, runSetup, systemDeps, terminalIO } from "./setup.js";
import { CONFIG_FILE, ConfigError, DEFAULT_PROJECT_DOCS, FLOWLOOP_DIR, jiraBaseUrl, ensureGitignore, loadConfig, migrateLegacyProject, workDirFor, workDirsFor , globalJiraBase, parseJiraLink, relatedPath, isGitRepo } from "./config.js";
import { findProjectDocs } from "./projectdocs.js";
import { mergeConfig } from "./configmerge.js";
import { detectBaseBranch, detectProject, renderConfig } from "./tech.js";
import { detectMemoryServers, expandServerNames, loadMcpServers, userClaudeMdPath } from "./usermcp.js";

import { git } from "./git.js";
import { color, consoleLogger } from "./log.js";
import { FlowloopError, ensureExcluded, resumeRun, runTask, type ChangeDecision, type ChangeReviewInfo, type PlanDecision, type QuestionDecision, type RunSummary, type ScopeDecision, type ScopeReviewInfo } from "./orchestrator.js";
import type { AttentionItem, OpenQuestion } from "./notes.js";
import { computeStats, loadRecords, parseSince, renderStats } from "./stats.js";
import { PACKAGE_ROOT, loadRoles } from "./roles.js";
import { JIRA_KEY, JiraError, epicChildren, fetchIssue, issueToTask } from "./jira.js";
import { BATCH_FILE, BATCH_PREFIX, runBatch, type BatchState } from "./batch.js";

const HELP = `flowloop — rol bazlı AI geliştirme ekibi (analist → developer ⇄ reviewer → committer)

Kullanım:
  flowloop init [--force]            Projenin teknolojilerini algılar, .flowloop/flowloop.yaml oluşturur
  flowloop check                     Yapılandırmayı doğrular, rollerin yetkilerini gösterir
  flowloop task <JIRA-123>           Jira kaydından .flowloop/tasks/JIRA-123.md görev dosyasını üretir
  flowloop run <görev.md | JIRA-123 | Jira bağlantısı> [seçenek]  Görevi ekiple çalıştırır (Jira anahtarı verilirse önce görevi çeker)
  flowloop run JIRA-1 JIRA-2 … [seçenek]   Birbirine bağlı görevler: toplu plan (sıra, bağımlılık, bütün sorular bir kez),
                                   sonra görevler sırayla AYNI branch'te; her biri ayrı commit ve Jira yorumu, tek PR
      --epic JIRA-100            Görevleri epic'in bitmemiş alt işlerinden al
      --branch <ad>              Toplu çalışmanın branch adı (varsayılan: ilk görevden)
      --approve-each-plan        Toplu planın yanında her görevin kendi planını da onaya sun
      --restart                  Yarım kalan aynı toplu çalışmayı sürdürme, baştan başla
      --refresh                  Görev dosyası varsa bile Jira'dan yeniden çek
      --no-push                  Bu çalıştırmada push yapma (flowloop.yaml'daki push: true'yu ezer)
      --approve-plan             Plan yazıldıktan sonra onay ister
      --questions ask|jira|assume
                                 Analistin açık soruları: terminalde sor | Jira'ya yaz ve dur | varsayılanla devam
                                 (varsayılan: flowloop.yaml → questions: ask)
      --agent claude|cursor      Ajan aracını seç (varsayılan: flowloop.yaml → agent: auto)
      --skip-review              İş bitince değişiklikleri sormadan commit/push et
      --dry-run                  Ajan çalıştırmadan prompt ve yetkileri gösterir
      -v, --verbose              Ajanların çıktısını canlı gösterir
  flowloop resume <id> [-v] [--agent claude|cursor] [--skip-review]
                                   Yarım kalan çalıştırmayı sürdürür (kontroller → reviewer → commit → push → Jira)
  flowloop runs                      Bu repo için yapılan çalıştırmaları listeler
  flowloop stats [--since 30d] [--json]
                                   Çalıştırmaların ölçüm özeti: başarı, ilk incelemede PASS, tur, insan
                                   müdahalesi, kapsam talepleri, reddedilen işlemler, maliyet ve süre
  flowloop setup [--force]           Hesap bilgilerini (Claude/Cursor, Jira, git, Bitbucket) adım adım kurar
  flowloop setup --check             Hesapların durumunu gösterir (soru sormaz)
  flowloop update                    flowloop'u kurulduğu kaynaktan günceller
  flowloop --version                 Sürümü ve kurulum kaynağını gösterir
  flowloop clean [--all]             Merge edilmiş (ya da --all ile tüm) çalıştırmaların worktree'lerini siler
`;

function repoRoot(): string {
  const r = git(["rev-parse", "--show-toplevel"], process.cwd());
  if (r.code !== 0) throw new FlowloopError("Bir git deposunun içinde çalıştır.");
  return r.stdout.trim();
}

function cmdInit(root: string, force: boolean): void {
  const cfgPath = path.join(root, CONFIG_FILE);
  if (fs.existsSync(cfgPath) && !force) throw new FlowloopError(`${CONFIG_FILE} zaten var. Yeniden oluşturmak için: flowloop init --force`);
  const d = detectProject(root);
  const base = detectBaseBranch(root);
  const branchName = guessBranchPattern(root);
  fs.mkdirSync(path.join(root, FLOWLOOP_DIR, "tasks"), { recursive: true });
  const memory = detectMemoryServers(root);
  let text = renderConfig(d, base, branchName, memory, guessJiraBase(root) || globalJiraBase());
  let kept: string[] = [];
  if (fs.existsSync(cfgPath)) ({ text, kept } = mergeConfig(text, fs.readFileSync(cfgPath, "utf8")));
  fs.writeFileSync(cfgPath, text);
  const gi = ensureGitignore(root);
  const tpl = path.join(root, FLOWLOOP_DIR, "tasks", "_sablon.md");
  if (!fs.existsSync(tpl)) fs.copyFileSync(path.join(PACKAGE_ROOT, "templates", "task-template.md"), tpl);
  const docs = findProjectDocs(root, DEFAULT_PROJECT_DOCS);
  console.log(color.green(`✓ ${CONFIG_FILE} ${force ? "yeniden " : ""}oluşturuldu`));
  if (kept.length) console.log(color.dim(`  korunan ayarlar: ${kept.join(", ")}`));
  const giMsg = { created: ".gitignore oluşturuldu, .flowloop/ eklendi", added: ".flowloop/ .gitignore'a eklendi", renamed: ".gitignore'daki eski satır (.kgflow/.ekip) .flowloop/ olarak güncellendi", exists: "" }[gi];
  if (giMsg) console.log(color.green(`✓ ${giMsg} (commit'lemeyi unutma)`));
  console.log(`  stack      : ${d.stack}`);
  for (const t of d.tech) console.log(`  teknoloji  : ${t}`);
  console.log(`  base       : ${base || color.yellow("bulunamadı — baseBranch'i elle yaz")}`);
  console.log(`  branch adı : ${branchName}`);
  console.log(`  proje kuralları: ${docs.length ? docs.join(", ") : "bulunamadı"} (otomatik dahil edilir)`);
  console.log(`  kişisel kurallar: ${fs.existsSync(userClaudeMdPath()) ? "~/.claude/CLAUDE.md (dahil edilir)" : "yok"}`);
  console.log(`  kod hafızası (MCP): ${memory.length ? memory.join(", ") + " (salt okuma araçlarıyla açılır)" : "bulunamadı"}`);
  for (const n of d.notes) console.log(color.yellow(`  ! ${n}`));
  console.log(`\nKomutları kontrol et: ${CONFIG_FILE}  →  flowloop check  →  flowloop run .flowloop/tasks/<görev>.md`);
}

/** Daha önce Jira'dan çekilmiş görev dosyalarından Jira adresini bulur */
function guessJiraBase(root: string): string {
  const dir = path.join(root, FLOWLOOP_DIR, "tasks");
  if (!fs.existsSync(dir)) return "";
  for (const f of fs.readdirSync(dir)) {
    const m = /^Kaynak:\s*(https:\/\/[^/\s]+)\/browse\//m.exec(fs.readFileSync(path.join(dir, f), "utf8"));
    if (m) return m[1];
  }
  return "";
}

/** Repodaki branch isimlerinden Jira kalıbını tahmin eder (ör. PROJ-1234-...) */
function guessBranchPattern(root: string): string {
  const r = git(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], root);
  const jiraLike = r.stdout.split("\n").filter((b) => /(^|\/)[A-Z][A-Z0-9]+-\d+([-_]|$)/.test(b)).length;
  return jiraLike >= 3 ? "{{jira}}-{{slug}}" : "flowloop/{{slug}}-{{date}}";
}

/** .flowloop/tasks/<KEY>.md yoksa (ya da --refresh) Jira'dan üretir; varsa olduğu gibi kullanır (elle düzenlenmiş olabilir). */
async function ensureJiraTask(root: string, key: string, refresh = false, baseOverride?: string): Promise<string> {
  const rel = path.join(FLOWLOOP_DIR, "tasks", `${key}.md`);
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
  if (!issue.acceptance) console.log(color.yellow("  ! Jira'da kabul kriteri alanı yok; analist açıklamadan çıkaracak. --approve-plan ile kontrol etmen önerilir."));
  return rel;
}

/** Claude ya da Cursor: ayara, --agent'a ve erişime göre seçer */
function pickRunner(root: string, override: string | undefined, dryRun = false): { runner: AgentRunner; backend: Backend } {
  if (override && !["auto", "claude", "cursor"].includes(override)) throw new FlowloopError(`--agent claude | cursor | auto olmalı (verilen: ${override})`);
  try {
    const r = createRunner(loadConfig(root), override);
    console.log(color.dim(`Ajan: ${r.backend === "cursor" ? "Cursor CLI" : "Claude (Agent SDK)"} — ${r.reason}`));
    return r;
  } catch (e) {
    if (dryRun && e instanceof BackendError) return { runner: new SdkAgentRunner(), backend: "claude" };
    if (e instanceof BackendError) throw new FlowloopError(e.message);
    throw e;
  }
}

/** Etkileşimli sorular (plan onayı, değişiklik onayı) */
const ask = async (q: string) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q);
  rl.close();
  return a;
};
const readComment = async (hint = "Yorumunu yaz"): Promise<string> => {
  console.log(color.dim(`${hint}. Birden fazla satır olabilir; bitirmek için boş bir satırda Enter'a bas.`));
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

/** Bir rolün bütçesi dolunca: ek bütçe ver ve kaldığı yerden devam et ya da durdur */
async function extendBudgetPrompt(b: BudgetRequest): Promise<number> {
  const step = b.budgetUsd > 0 ? Math.max(0.5, Math.round(b.budgetUsd * 100) / 100) : 1;
  console.log(
    "\n" + color.yellow(`! ${b.role} için ayrılan bütçe doldu`) +
      color.dim(` (bu rolde $${b.spentUsd.toFixed(2)}, çalıştırmada toplam $${b.totalSpentUsd.toFixed(2)} — SDK'nın tahmini)`),
  );
  console.log(`  [e] +$${step.toFixed(2)} ile kaldığı yerden devam et\n  [t] Tutar gir\n  [h] Durdur (sonra .flowloop/flowloop.yaml → budgets ile artırabilirsin)`);
  for (;;) {
    const a = (await ask("Seçimin [e/t/h]: ")).trim().toLowerCase();
    if (a === "e" || a === "evet") return step;
    if (a === "h" || a === "hayır" || a === "hayir") return 0;
    if (a === "t") {
      const n = Number((await ask("Ek bütçe (USD): ")).trim().replace(",", "."));
      if (n > 0 && n <= 100) return n;
      console.log(color.yellow("0 ile 100 arasında bir tutar yaz."));
    }
  }
}

/** Analistin açık soruları: cevapla / varsayılanla devam / Jira'ya yaz / durdur */
async function answerQuestionsPrompt(qs: OpenQuestion[], ctx: { round: number; canPostToJira: boolean }): Promise<QuestionDecision> {
  console.log("\n" + color.bold(`━━ AÇIK SORULAR${ctx.round > 1 ? ` (${ctx.round}. tur)` : ""} — geliştirmeye geçmeden önce cevabın gerekiyor ━━`));
  for (const q of qs) {
    console.log(`\n${color.bold(q.id)}  ${q.text.replace(/\n/g, "\n      ")}`);
    if (q.fallback) console.log(color.dim(`      Cevap gelmezse: ${q.fallback}`));
  }
  const options = [
    "  [c] Cevapla — sorular sırayla sorulur; boş bırakırsan analistin önerdiği varsayılan kullanılır",
    "  [v] Varsayılanlarla devam et — Jira yorumunda \"Varsayımlar\" olarak listelenir",
    ...(ctx.canPostToJira ? ["  [j] Soruları Jira'ya yorum olarak yaz ve dur — cevaplar gelince: flowloop run <KEY> --refresh"] : []),
    "  [h] Durdur — plan saklanır",
  ];
  for (;;) {
    console.log(color.bold("\nNe yapalım?") + "\n" + options.join("\n"));
    const a = (await ask(`Seçimin [c/v${ctx.canPostToJira ? "/j" : ""}/h]: `)).trim().toLowerCase();
    if (a === "c" || a === "cevapla") {
      const answers: Record<string, string> = {};
      for (const q of qs) {
        console.log(`\n${color.bold(q.id)}  ${q.text.split("\n")[0]}`);
        answers[q.id] = await readComment(`Cevabın${q.fallback ? " (boş = varsayılan)" : ""}`);
      }
      return { action: "answer", answers };
    }
    if (a === "v") return { action: "assume" };
    if (a === "j" && ctx.canPostToJira) return { action: "jira" };
    if (a === "h" || a === "hayır" || a === "hayir" || a === "iptal") return { action: "cancel" };
  }
}

/** Varsayımlar ve incelenmesi önerilenler (onay ekranı ve bitiş özeti) */
function printNotes(assumptions: string[], attention: AttentionItem[], max = 10): void {
  const list = (items: string[]) => items.slice(0, max).map((t) => `  - ${t.replace(/\s*\n\s*/g, " ")}`).join("\n") + (items.length > max ? `\n  … ve ${items.length - max} madde daha (run.json)` : "");
  if (assumptions.length) console.log("\n" + color.yellow("Varsayımlar") + color.dim(" (doğru değilse değişiklik iste):") + "\n" + list(assumptions));
  const look = attention.filter((a) => a.kind !== "preexisting").map((a) => `${a.kind === "skipped" ? "[doğrulanmadı] " : a.from === "reviewer" ? "" : "[risk] "}${a.text}`);
  if (look.length) console.log("\n" + color.bold("İncelenmesi önerilenler:") + "\n" + list(look));
  const pre = attention.filter((a) => a.kind === "preexisting").map((a) => a.text);
  if (pre.length) console.log(color.dim("\nProjede önceden var olan sorunlar (bu işte dokunulmadı):\n" + list(pre)));
}

/** İş bitince, commit'ten önce: değişiklikleri göster ve kullanıcıya sor */
async function reviewChangesPrompt(info: ChangeReviewInfo): Promise<ChangeDecision> {
  console.log("\n" + color.bold("━━ İŞ TAMAMLANDI — commit'ten önce senin onayın gerekiyor ━━"));
  if (info.reviewerNote.trim()) {
    const note = info.reviewerNote.trim().split("\n").filter((l) => !/^VERDICT:/i.test(l.trim())).slice(0, 15).join("\n");
    if (note) console.log(color.dim("Reviewer:\n" + note));
  }
  printNotes(info.assumptions, info.attention);
  console.log("\nDeğişen dosyalar:\n" + (info.diffStat.trim() || "(fark yok)"));
  console.log(color.dim(`\nKodu editöründe de açabilirsin: ${info.worktree}`));
  const options = [
    "  [e] Onayla — commit, push ve Jira yorumu",
    "  [d] Farkın tamamını göster",
    ...(info.canRevise ? ["  [y] Değişiklik iste — yorumun developer'a gider, testler ve reviewer tekrar çalışır"] : []),
    "  [h] Şimdilik onaylama — commit yapılmaz, sonra: flowloop resume",
  ];
  for (;;) {
    console.log(color.bold("\nDeğişiklikler uygun mu?") + "\n" + options.join("\n"));
    const a = (await ask(`Seçimin [e/d${info.canRevise ? "/y" : ""}/h]: `)).trim().toLowerCase();
    if (a === "e" || a === "evet") return { action: "approve" };
    if (a === "d") {
      const diff = info.diff();
      // uzun farklar için sayfalayıcı (less) varsa onu kullan
      const pager = spawnSync("less", ["-R", "-F", "-X"], { input: diff, stdio: ["pipe", "inherit", "inherit"] });
      if (pager.status !== 0) console.log(diff);
      continue;
    }
    if ((a === "y" || a === "yorum") && info.canRevise) {
      const comment = await readComment();
      if (comment.trim()) return { action: "revise", comment };
      console.log(color.yellow("Yorum boş; tekrar seç."));
      continue;
    }
    if (a === "h" || a === "hayır" || a === "hayir" || a === "iptal") return { action: "cancel" };
  }
}

/** Developer kapsam dışı bir değişiklik istediğinde: kararı kullanıcı verir */
async function reviewScopePrompt(info: ScopeReviewInfo): Promise<ScopeDecision> {
  console.log("\n" + color.bold(`━━ KAPSAM TALEBİ (tur ${info.turn}) — senin kararın gerekiyor ━━`));
  console.log(info.request);
  const options = [
    ...(info.expandable.length ? [`  [g] Kapsamı genişlet — yazılabilir yapılabilecek repolar: ${info.expandable.join(", ")} (flowloop.yaml sınırları içinde)`] : []),
    "  [d] Genişletmeden devam et — developer mevcut kapsamda kalır, yapamadığını özetler",
    "  [h] Durdur — bu değişiklik için ayrı bir görev açarsın (talep run klasöründe saklanır)",
  ];
  if (!info.expandable.length) console.log(color.dim("\nflowloop.yaml'ın izin verdiği kapalı repo yok; kapsam genişletilemez (tavanı değiştirmek senin kararın: flowloop.yaml → related[].edit)."));
  for (;;) {
    console.log(color.bold("\nNe yapalım?") + "\n" + options.join("\n"));
    const a = (await ask(`Seçimin [${info.expandable.length ? "g/" : ""}d/h]: `)).trim().toLowerCase();
    if (a === "g" && info.expandable.length) {
      if (info.expandable.length === 1) return { action: "expand", repos: info.expandable };
      const picked = (await ask(`Hangi repolar? (virgülle; boş = hepsi: ${info.expandable.join(", ")}): `)).split(",").map((x) => x.trim()).filter(Boolean);
      const repos = picked.length ? picked.filter((x) => info.expandable.includes(x)) : info.expandable;
      if (repos.length) return { action: "expand", repos };
      console.log(color.yellow("Geçerli repo adı yok; tekrar seç."));
      continue;
    }
    if (a === "d") return { action: "continue" };
    if (a === "h" || a === "iptal") return { action: "cancel" };
  }
}

function cmdStats(root: string, args: string[]): void {
  const { values } = parseArgs({ args, options: { since: { type: "string" }, json: { type: "boolean", default: false } } });
  let since: Date | undefined;
  try {
    since = values.since ? parseSince(values.since) : undefined;
  } catch (e) {
    throw new FlowloopError((e as Error).message);
  }
  const cfg = loadConfig(root);
  const stats = computeStats(loadRecords(root, workDirsFor(cfg, root), since));
  if (values.json) console.log(JSON.stringify(stats, null, 2));
  else console.log(renderStats(stats, values.since ? `Son ${values.since}` : "Tüm kayıtlar"));
}

/** Eski Türkçe bayraklar (--plan-onayi, --onaysiz) uyarıyla yeni adlarına çevrilir */
const LEGACY_FLAGS: Record<string, string> = { "--plan-onayi": "--approve-plan", "--onaysiz": "--skip-review" };
function mapLegacyFlags(args: string[]): string[] {
  return args.map((a) => {
    const n = LEGACY_FLAGS[a];
    if (!n) return a;
    console.error(color.yellow(`! ${a} yerine artık ${n} kullanılıyor (eski bayrak bir süre daha çalışır).`));
    return n;
  });
}

async function cmdRun(root: string, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: mapLegacyFlags(args),
    allowPositionals: true,
    options: {
      "approve-plan": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      refresh: { type: "boolean", default: false },
      "no-push": { type: "boolean", default: false },
      agent: { type: "string" },
      "skip-review": { type: "boolean", default: false },
      questions: { type: "string" },
      epic: { type: "string" },
      branch: { type: "string" },
      "approve-each-plan": { type: "boolean", default: false },
      restart: { type: "boolean", default: false },
    },
  });
  const qm = values.questions;
  if (qm !== undefined && !["ask", "jira", "assume"].includes(qm)) throw new FlowloopError(`--questions ask | jira | assume olmalı (verilen: ${qm})`);
  const inputs = [...positionals];
  let epicFile: string | undefined;
  if (values.epic) {
    const epicLink = parseJiraLink(values.epic);
    const epicKey = epicLink?.key ?? values.epic;
    const base = epicLink?.base || jiraBaseUrl(loadConfig(root));
    epicFile = await ensureJiraTask(root, epicKey, values.refresh, epicLink?.base);
    const kids = await epicChildren(epicKey, base);
    if (!kids.length) throw new FlowloopError(`${epicKey} altında bitmemiş iş yok.`);
    console.log(`${epicKey} altındaki bitmemiş işler (${kids.length}):`);
    for (const k of kids) console.log(color.dim(`  - ${k.key}  ${k.summary}  [${k.status}]`));
    for (const k of kids) if (!inputs.includes(k.key)) inputs.push(k.key);
  }
  if (!inputs.length) throw new FlowloopError("Kullanım: flowloop run <görev.md | JIRA-123> [JIRA-124 …]  ya da  flowloop run --epic JIRA-100");
  const files: string[] = [];
  for (const arg of inputs) {
    const link = parseJiraLink(arg); // https://sirket.atlassian.net/browse/PROJ-1234 de verilebilir
    if (link) files.push(await ensureJiraTask(root, link.key, values.refresh, link.base));
    else if (JIRA_KEY.test(arg)) files.push(await ensureJiraTask(root, arg, values.refresh));
    else files.push(arg);
  }
  const taskFile = files[0];
  const log = consoleLogger(values.verbose || values["dry-run"]);
  const confirm = async (q: string) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question(`${q} [e/H] `);
    rl.close();
    return /^[eEyY]$/.test(a.trim());
  };
  if (values["approve-plan"] && !values["dry-run"] && !process.stdin.isTTY) throw new FlowloopError("--approve-plan etkileşimli bir terminal ister.");
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
  if (files.length > 1) {
    const st = await runBatch({
      root,
      taskFiles: files,
      epicFile,
      branch: values.branch,
      restart: values.restart,
      planApproval: values["approve-plan"],
      approveEachPlan: values["approve-each-plan"],
      rerun: `flowloop run ${values.epic ? `--epic ${values.epic}` : inputs.join(" ")}${values["approve-plan"] ? " --approve-plan" : ""}`,
      noPush: values["no-push"],
      dryRun: values["dry-run"],
      agent: r.runner,
      backend: r.backend,
      log,
      confirm,
      reviewPlan,
      answerQuestions: process.stdin.isTTY && !values["dry-run"] ? answerQuestionsPrompt : undefined,
      questionsMode: qm as "ask" | "jira" | "assume" | undefined,
      reviewScope: process.stdin.isTTY ? reviewScopePrompt : undefined,
      reviewChanges: !values["dry-run"] && !values["skip-review"] && process.stdin.isTTY ? reviewChangesPrompt : undefined,
      extendBudget: process.stdin.isTTY ? extendBudgetPrompt : undefined,
    });
    if (values["dry-run"]) {
      console.log(color.dim("\nDRY RUN — ajan çalıştırılmadı. Toplu çalışma: önce toplu plan, sonra görevler bu branch'te sırayla."));
      return 0;
    }
    printBatchDone(st, log);
    return 0;
  }
  const s = await runTask({
    root,
    taskFile,
    planApproval: values["approve-plan"],
    noPush: values["no-push"],
    dryRun: values["dry-run"],
    agent: r.runner,
    backend: r.backend,
    log,
    confirm,
    reviewPlan,
    // açık sorular: etkileşimli terminalde sorulur (questions: assume değilse); değilse flowloop.yaml → questions
    answerQuestions: process.stdin.isTTY && !values["dry-run"] ? answerQuestionsPrompt : undefined,
    questionsMode: qm as "ask" | "jira" | "assume" | undefined,
    // etkileşimsiz çalıştırmada kapsam talebi gelirse çalıştırma durur (yetki kendiliğinden açılmaz)
    reviewScope: process.stdin.isTTY ? reviewScopePrompt : undefined,
    // etkileşimli terminalde iş bitince commit'ten önce sorulur; --skip-review ile atlanır
    reviewChanges: !values["dry-run"] && !values["skip-review"] && process.stdin.isTTY ? reviewChangesPrompt : undefined,
    extendBudget: process.stdin.isTTY ? extendBudgetPrompt : undefined,
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
  Temizle : flowloop clean   (merge edildikten sonra)`);
  for (const w of s.warnings) console.log(color.yellow(`  ! ${w}`));
  if (s.assumptions?.length || s.attention?.some((a) => a.kind !== "preexisting")) {
    printNotes(s.assumptions ?? [], (s.attention ?? []).filter((a) => a.kind !== "preexisting"), 6);
    if (s.jiraCommentUrl) console.log(color.dim("  (bunlar Jira yorumuna da eklendi)"));
  }
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

function printBatchDone(st: BatchState, log: ReturnType<typeof consoleLogger>): void {
  log.step("TOPLU ÇALIŞMA BİTTİ");
  for (const k of st.order) {
    const t = st.tasks.find((x) => x.key === k)!;
    console.log(`  ${color.green("✓")} ${t.key}  ${t.title}  ${color.dim(`(${t.commits?.length ?? 0} commit)`)}`);
    for (const c of t.commits ?? []) console.log(color.dim(`      ${c}`));
    if (t.jiraCommentUrl) console.log(color.dim(`      Jira: ${t.jiraCommentUrl}`));
  }
  console.log(`
  Branch  : ${st.branch}  (bütün görevler bu branch'te)
  Maliyet : $${st.totalCostUsd.toFixed(2)} (tahmini)${st.prUrl ? `\n  PR aç   : ${st.prUrl}` : ""}
  Kayıt   : ${path.join(st.dir, BATCH_FILE)}

  İncele  : git log --oneline ${st.baseSha.slice(0, 7)}..${st.branch}`);
  for (const w of st.warnings) console.log(color.yellow(`  ! ${w}`));
}

function listBatches(root: string): BatchState[] {
  return workDirsFor(loadConfig(root), root).flatMap((base) =>
    fs.readdirSync(base).filter((id) => id.startsWith(BATCH_PREFIX) && fs.existsSync(path.join(base, id, BATCH_FILE))).sort().map((id) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(base, id, BATCH_FILE), "utf8")) as BatchState;
      } catch {
        return undefined;
      }
    }).filter((x): x is BatchState => !!x),
  );
}

function listRuns(root: string): { id: string; dir: string; status: string; branch?: string; cost?: number }[] {
  return workDirsFor(loadConfig(root), root).flatMap((base) => fs.readdirSync(base).filter((id) => !id.startsWith(BATCH_PREFIX)).sort().map((id) => {
    const f = path.join(base, id, "run.json");
    const j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    return { id, dir: path.join(base, id), status: j.status ?? "yarım", branch: j.branch, cost: j.totalCostUsd };
  }));
}

function cmdClean(root: string, all: boolean): void {
  const cfg = loadConfig(root);
  for (const r of listRuns(root)) {
    const branch = r.branch ?? `flowloop/${r.id}`;
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
  // toplu çalışma kayıtları: bitmiş olanlar (ya da --all ile hepsi)
  for (const b of listBatches(root)) {
    if (!all && b.status !== "success") continue;
    git(["worktree", "remove", "--force", path.join(b.dir, "plan-wt")], root);
    fs.rmSync(b.dir, { recursive: true, force: true });
    console.log(color.green(`  silindi: ${b.id}`));
  }
  git(["worktree", "prune"], root);
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (/(^|\/)kgflow$/.test(process.argv[1] ?? "")) console.error(color.yellow("! kgflow komutunun adı flowloop oldu; bundan sonra flowloop yaz (kgflow bir süre daha çalışır)."));
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(HELP);
    return 0;
  }
  if (cmd === "--version" || cmd === "-V" || cmd === "version") {
    const i = readInstallInfo();
    console.log(`flowloop ${currentVersion()}${i ? color.dim(`  (${i.mode === "local" ? "yerel repo" : "kaynak"}: ${i.source}${i.commit ? " @ " + i.commit.slice(0, 7) : ""})`) : ""}`);
    return 0;
  }
  if (cmd === "update") return runUpdate();
  if (cmd === "setup") {
    const deps = systemDeps();
    if (rest.includes("--check")) return (await printStatus(deps, { log: console.log }, { network: true })) ? 0 : 1;
    if (!process.stdin.isTTY) throw new FlowloopError("flowloop setup etkileşimli bir terminal ister (durum için: flowloop setup --check)");
    await runSetup(terminalIO(), deps, { force: rest.includes("--force") });
    return 0;
  }
  if (cmd === "run" || cmd === "check" || cmd === "init") {
    const notice = updateNotice();
    if (notice) console.log(color.yellow(`! ${notice}`));
  }
  const root = repoRoot();
  const migrated = migrateLegacyProject(root);
  if (migrated) console.log(color.yellow(`Eski .${migrated} klasörü ${FLOWLOOP_DIR}/ olarak taşındı (${migrated}.yaml → flowloop.yaml).`));
  if (git(["rev-parse", "--git-dir"], root).code === 0) ensureExcluded(root, [FLOWLOOP_DIR]); // .gitignore'a dokunmadan yerel olarak yok say
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
      for (const r of cfg.related) {
        const p = relatedPath(root, r.path);
        const st = RelatedRepo.projectSettings(p);
        const gitRepo = isGitRepo(p);
        console.log(`  ilgili   : ${r.name} → ${p} · ${r.edit.length ? `değiştirilebilir: ${r.edit.join(", ")}` : "sadece okunur"}${gitRepo ? ` · test: ${st.commands.testRelated || "—"} (${st.source})` : " · git değil (ortak klasör)"}`);
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
      if (found.length) console.log(color.dim(`             (tanımlı ama açılmamış hafıza sunucuları: ${found.join(", ")} → flowloop.yaml mcp.servers)`));
      console.log(`  çalışma  : ${workDirFor(cfg, root)}`);
      return 0;
    }
    case "task": {
      const arg = rest.find((a) => !a.startsWith("-"));
      const link = arg ? parseJiraLink(arg) : undefined;
      const key = link?.key ?? arg;
      if (!key || !JIRA_KEY.test(key)) throw new FlowloopError("Kullanım: flowloop task <JIRA-123 | Jira bağlantısı> [--refresh]");
      const rel = await ensureJiraTask(root, key, rest.includes("--refresh"), link?.base);
      console.log(`İncele/düzenle: ${rel}  →  flowloop run ${key} --approve-plan -v`);
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
      throw new FlowloopError("Kullanım: mutant reset | test");
    }
    case "resume": {
      const id = rest.find((a, i) => !a.startsWith("-") && rest[i - 1] !== "--agent");
      if (!id) throw new FlowloopError("Kullanım: flowloop resume <çalıştırma-id>  (flowloop runs ile listele)");
      const log = consoleLogger(rest.includes("-v") || rest.includes("--verbose"));
      const ai = rest.findIndex((a) => a === "--agent" || a.startsWith("--agent="));
      const agentOpt = ai < 0 ? undefined : rest[ai].includes("=") ? rest[ai].split("=")[1] : rest[ai + 1];
      const r = pickRunner(root, agentOpt);
      const s = await resumeRun({
        root, resume: id, taskFile: "", agent: r.runner, backend: r.backend, log, noPush: rest.includes("--no-push"),
        reviewChanges: !mapLegacyFlags(rest).includes("--skip-review") && process.stdin.isTTY ? reviewChangesPrompt : undefined,
        extendBudget: process.stdin.isTTY ? extendBudgetPrompt : undefined,
      });
      printDone(root, s, log);
      return 0;
    }
    case "runs":
      for (const b of listBatches(root)) {
        const done = b.tasks.filter((t) => t.status === "success").length;
        console.log(`${b.status.padEnd(8)} ${b.id}  ${done}/${b.tasks.length} görev · ${b.branch}  $${b.totalCostUsd.toFixed(2)}`);
      }
      for (const r of listRuns(root)) console.log(`${r.status.padEnd(8)} ${r.id}  ${r.cost !== undefined ? "$" + r.cost.toFixed(2) : ""}`);
      return 0;
    case "clean":
      cmdClean(root, rest.includes("--all"));
      return 0;
    case "stats":
      cmdStats(root, rest);
      return 0;
    default:
      console.log(HELP);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof FlowloopError || e instanceof ConfigError || e instanceof JiraError) {
      console.error(color.red("✗ " + e.message));
      process.exit(1);
    }
    if (typeof e?.code === "string" && e.code.startsWith("ERR_PARSE_ARGS")) {
      console.error(color.red("✗ " + e.message) + color.dim("\n  Seçenekler için: flowloop --help"));
      process.exit(2);
    }
    console.error(e);
    process.exit(1);
  },
);
