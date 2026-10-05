import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRequest, AgentResult, AgentRunner } from "../src/agent.js";
import { gitOk, sh } from "../src/git.js";
import { silentLogger } from "../src/log.js";
import { MutantSandbox } from "../src/mutant.js";
import { FlowloopError, runTask, type ChangeDecision, type ChangeReviewInfo, type PlanDecision } from "../src/orchestrator.js";
import type { RoleName } from "../src/roles.js";

// ───────────── küçük örnek repo ─────────────
function makeRepo(extraCfg = "", opts: { commands?: string; files?: Record<string, string> } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-e2e-"));
  const w = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  w("package.json", JSON.stringify({ name: "demo", type: "module", scripts: { test: "node --test" } }));
  w("src/fiyat.js", 'export function fiyat(kg) {\n  return kg <= 5 ? 90 : 140;\n}\n');
  w("test/fiyat.test.js", 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { fiyat } from "../src/fiyat.js";\ntest("3 kg", () => assert.equal(fiyat(3), 90));\n');
  w("README.md", "# demo\n");
  w(".gitignore", "node_modules/\n");
  w(".flowloop/tasks/ekspres.md", "# Görev: Ekspres teslimat\n\nJira: KG-42\n\n1. ekspres +50 TL\n");
  for (const [k, v] of Object.entries(opts.files ?? {})) w(k, v);
  w(
    ".flowloop/flowloop.yaml",
    `version: 2
stack: node
baseBranch: ""
branchName: "{{jira}}-{{slug}}"
commands:
${opts.commands ?? '  testRelated: "node --test {{testFiles}}"'}
paths: { edit: ["src/**", "test/**"], readDeny: [".env"] }
mutation: { enabled: true }
budgets: { analist: 1, gelistir: 3, commit: 0.5, total: 5 }
maxIterations: 3
workDir: ${JSON.stringify(path.join(root, "..", path.basename(root) + "-work"))}
${extraCfg}`,
  );
  const g = (...a: string[]) => gitOk(a, root);
  g("init", "-q", "-b", "main");
  // testler makinenin global git ayarına bağlı olmasın ("Başlatan" bilgisi buradan okunur)
  g("config", "user.name", "Test Kişi");
  g("config", "user.email", "test@kolaygelsin.com");
  g("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "chore: init");
  return root;
}

// ───────────── sahte ajan: her rol için senaryo ─────────────
type Script = (req: AgentRequest, call: number) => string | void;
class FakeAgent implements AgentRunner {
  calls: { role: RoleName; prompt: string; mcp: string[] }[] = [];
  constructor(private scripts: Partial<Record<RoleName, Script>>, private cost = 0.1) {}
  async run(req: AgentRequest): Promise<AgentResult> {
    const n = this.calls.filter((c) => c.role === req.role).length + 1;
    this.calls.push({ role: req.role, prompt: req.prompt, mcp: Object.keys(req.extraMcpServers ?? {}) });
    const text = this.scripts[req.role]?.(req, n) ?? "tamam";
    return { ok: true, text, costUsd: this.cost, denials: [], models: [req.role === "reviewer" ? "claude-opus-4-test" : "claude-sonnet-4-test"] };
  }
}
const W = (req: AgentRequest, rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(req.cwd, rel)), { recursive: true });
  fs.writeFileSync(path.join(req.cwd, rel), body);
};
const planFile = (req: AgentRequest) => path.join(req.runRoot, "plan.md");
const GIT = (req: AgentRequest, ...a: string[]) => gitOk(["-c", "user.name=ai", "-c", "user.email=ai@x", ...a], req.cwd);

const good: Partial<Record<RoleName, Script>> = {
  analist: (req) => {
    fs.writeFileSync(planFile(req), "# Plan\nAK-1: ekspres +50\n");
  },
  developer: (req) => {
    W(req, "src/fiyat.js", 'export function fiyat(kg, ekspres = false) {\n  const n = kg <= 5 ? 90 : 140;\n  return ekspres ? n + 50 : n;\n}\n');
    W(req, "test/ekspres.test.js", 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { fiyat } from "../src/fiyat.js";\ntest("ekspres", () => assert.equal(fiyat(3, true), 140));\n');
  },
  reviewer: () => "✅ her şey yolunda\nVERDICT: PASS",
  committer: (req) => {
    GIT(req, "add", "src/fiyat.js");
    GIT(req, "commit", "-qm", "feat(fiyat): ekspres teslimat", "-m", "AK-1");
    GIT(req, "add", "test/ekspres.test.js");
    GIT(req, "commit", "-qm", "test(fiyat): ekspres testi");
  },
};

async function run(scripts: Partial<Record<RoleName, Script>>, extraCfg = "", cost = 0.1, repoOpts: Parameters<typeof makeRepo>[1] = {}, prep?: (root: string) => void, home?: (root: string) => string) {
  const root = makeRepo(extraCfg, repoOpts);
  prep?.(root);
  const homeDir = home ? home(root) : fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-emptyhome-"));
  const agent = new FakeAgent({ ...good, ...scripts }, cost);
  const log = silentLogger();
  try {
    const s = await runTask({ root, taskFile: ".flowloop/tasks/ekspres.md", agent, log, noFetch: true, home: homeDir, now: () => new Date(2026, 9, 3, 12, 0, 0) });
    return { root, agent, log, s, err: undefined as string | undefined };
  } catch (e) {
    if (!(e instanceof FlowloopError)) throw e;
    return { root, agent, log, s: undefined, err: e.message };
  }
}

test("mutlu yol: 4 rol, 2 commit, main'e dokunulmaz", async () => {
  const { root, s, err, agent } = await run({});
  assert.equal(err, undefined);
  assert.equal(s!.status, "success");
  assert.equal(s!.commits.length, 2);
  assert.deepEqual(agent.calls.map((c) => c.role), ["analist", "developer", "reviewer", "committer"]);
  assert.equal(gitOk(["log", "--oneline"], root).split("\n").length, 1, "main değişmemeli");
  assert.ok(fs.existsSync(path.join(s!.runDir!, "run.json")));
  assert.match(agent.calls[1].prompt, /plan\.md/);
});

test("reviewer FAIL → geri bildirim developer'a gider, ders kaydedilir, 2. turda PASS", async () => {
  const { root, s, agent } = await run({
    reviewer: (_r, n) => (n === 1 ? "❌ AK-1 testi yok: test/ekspres.test.js eksik\nVERDICT: FAIL" : "VERDICT: PASS"),
  });
  assert.equal(s!.status, "success");
  assert.equal(s!.iterations, 2);
  const dev2 = agent.calls.filter((c) => c.role === "developer")[1];
  assert.match(dev2.prompt, /REDDEDİLDİ[\s\S]*AK-1 testi yok/);
  assert.match(fs.readFileSync(path.join(root, ".flowloop/lessons.md"), "utf8"), /AK-1 testi yok/);
});

test("reviewer hiç onay vermezse durur", async () => {
  const { err, agent } = await run({ reviewer: () => "❌ olmadı\nVERDICT: FAIL" });
  assert.match(err!, /3 turda onay alınamadı/);
  assert.equal(agent.calls.filter((c) => c.role === "committer").length, 0, "committer çalışmamalı");
});

test("VERDICT satırı yoksa FAIL sayılır", async () => {
  const { err } = await run({ reviewer: () => "bence iyi" });
  assert.match(err!, /onay alınamadı/);
});

const violations: [string, Partial<Record<RoleName, Script>>, RegExp][] = [
  ["analist kod değiştirir", { analist: (r) => { fs.writeFileSync(planFile(r), "p"); W(r, "src/x.js", "1"); } }, /Analist kod değiştirdi/],
  ["analist plan yazmaz", { analist: () => {} }, /plan yazmadı/],
  ["developer commit atar", { developer: (r) => { good.developer!(r, 1); GIT(r, "add", "-A"); GIT(r, "commit", "-qm", "feat: x"); } }, /Developer commit attı/],
  ["developer izinsiz yola yazar", { developer: (r) => { good.developer!(r, 1); W(r, "README.md", "x"); } }, /izinli yollar dışında.*README\.md/],
  ["reviewer gerçek dosyayı değiştirir", { reviewer: (r) => { W(r, "src/fiyat.js", "bozuk"); return "VERDICT: PASS"; } }, /Reviewer gerçek dosyaları değiştirdi/],
  ["committer içerik değiştirir", { committer: (r) => { W(r, "src/fiyat.js", "export const x=1;\n"); GIT(r, "add", "-A"); GIT(r, "commit", "-qm", "feat: x"); } }, /onayladığıyla AYNI DEĞİL/],
  ["committer eksik commit'ler", { committer: (r) => { GIT(r, "add", "src/fiyat.js"); GIT(r, "commit", "-qm", "feat: x"); } }, /Commit sonrası değişiklik kaldı/],
  ["committer kötü mesaj", { committer: (r) => { GIT(r, "add", "-A"); GIT(r, "commit", "-qm", "ekspres eklendi"); } }, /Conventional Commits/],
  ["committer iptal eder", { committer: () => "COMMIT İPTAL: debug dosyası var" }, /Committer iptal etti/],
  ["developer hiçbir şey yapmaz", { developer: () => {} }, /3 turda onay alınamadı/],
];
for (const [name, scripts, expected] of violations) {
  test(`ihlal yakalanır: ${name}`, async () => {
    const { err, root } = await run(scripts);
    assert.ok(err, "hata bekleniyordu");
    assert.match(err!, expected);
    assert.equal(gitOk(["log", "--oneline"], root).split("\n").length, 1, "main değişmemeli");
  });
}

test("bütçe aşılırsa durur", async () => {
  const { err } = await run({ reviewer: () => "VERDICT: FAIL" }, "", 1.2);
  assert.match(err!, /Bütçe bitti/);
});

test("kirli yerel çalışma alanı engel değil; iş temiz base'den başlar", async () => {
  const { s: sum, err, log, root } = await run({}, "", 0.1, {}, (root) => fs.writeFileSync(path.join(root, "README.md"), "YEREL DEĞİŞİKLİK\n"));
  assert.equal(err, undefined);
  assert.equal(sum!.status, "success");
  assert.ok(log.lines.some((l) => l.includes("commit'lenmemiş değişiklik var")));
  const committed = gitOk(["show", `${sum!.branch}:README.md`], root);
  assert.doesNotMatch(committed, /YEREL/);
});

test("base branch: production → main → master; branch adı Jira'dan", async () => {
  const { s: sum, root } = await run({}, "", 0.1, {}, (root) => {
    gitOk(["branch", "production"], root);
    gitOk(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "chore: main'de ileri commit"], root);
  });
  assert.equal(sum!.baseBranch, "production");
  assert.equal(sum!.branch, "KG-42-ekspres-teslimat");
  assert.equal(sum!.baseSha, gitOk(["rev-parse", "production"], root));
});

test("projenin CLAUDE.md ve .cursorrules dosyaları kurallara eklenir", async () => {
  const { s: sum, agent } = await run({}, "", 0.1, { files: { "CLAUDE.md": "# Kural: any kullanma\n", ".cursorrules": "- named export\n" } });
  assert.deepEqual(sum!.projectDocs, ["CLAUDE.md", ".cursorrules"]);
  const rules = fs.readFileSync(path.join(sum!.runDir!, "run", "rules.md"), "utf8");
  assert.match(rules, /any kullanma/);
  assert.match(rules, /named export/);
  assert.match(rules, /SÜREÇ kuralları/);
  assert.match(agent.calls[0].prompt, /rules\.md/);
});

test("kişisel CLAUDE.md ve kod hafızası (MCP) ajanlara verilir; committer'a verilmez", async () => {
  const { fakeHome } = await import("./helpers.js");
  const { s: sum, agent } = await run({}, 'mcp: { servers: ["kgs-app-memory"] }', 0.1, {}, undefined, (root) => fakeHome(root));
  assert.equal(sum!.status, "success");
  assert.ok(sum!.projectDocs.includes("~/.claude/CLAUDE.md"));
  assert.match(fs.readFileSync(path.join(sum!.runDir!, "run", "rules.md"), "utf8"), /Türkçe yorum yaz[\s\S]*|Proje kuralıyla çelişirse PROJE/);
  const byRole = Object.fromEntries(agent.calls.map((c) => [c.role, c.mcp]));
  assert.deepEqual(byRole.analist, ["kgs-app-memory"]);
  assert.deepEqual(byRole.developer, ["kgs-app-memory"]);
  assert.deepEqual(byRole.reviewer, ["kgs-app-memory"]);
  assert.deepEqual(byRole.committer, []);
  assert.match(agent.calls[0].prompt, /mcp__kgs-app-memory__search_similar[\s\S]*güncel olmayabilir/);
});

test("userClaudeMd: false ise kişisel kurallar eklenmez", async () => {
  const { fakeHome } = await import("./helpers.js");
  const { s: sum } = await run({}, "userClaudeMd: false", 0.1, {}, undefined, (root) => fakeHome(root));
  assert.ok(!sum!.projectDocs.includes("~/.claude/CLAUDE.md"));
});

test("otomatik kontrol başarısızsa reviewer'a gitmeden developer'a döner", async () => {
  const typecheck = `  typecheck: "grep -rn BOZUK src | sed 's/$/ error TS1/'; ! grep -rq BOZUK src"`;
  const { s: sum, agent } = await run(
    {
      developer: (req, n) => {
        good.developer!(req, n);
        if (n === 1) W(req, "src/fiyat.js", "export function fiyat(kg, ekspres = false) { return 1; } // BOZUK\n");
      },
    },
    "",
    0.1,
    { commands: `  testRelated: "node --test {{testFiles}}"\n${typecheck}` },
  );
  assert.equal(sum!.status, "success");
  assert.deepEqual(agent.calls.map((c) => c.role), ["analist", "developer", "developer", "reviewer", "committer"]);
  assert.match(agent.calls[2].prompt, /OTOMATİK KONTROLLER[\s\S]*YENİ tip hatası[\s\S]*BOZUK/);
  assert.match(agent.calls[3].prompt, /✅ tip: yeni tip hatası yok/);
});

test("projede önceden var olan tip hatası bloklamaz", async () => {
  const typecheck = `  typecheck: "grep -rn ESKI src | sed 's/$/ error TS1/'; ! grep -rq ESKI src"`;
  const { s: sum, err } = await run({}, "", 0.1, {
    commands: `  testRelated: "node --test {{testFiles}}"\n${typecheck}`,
    files: { "src/eski.js": "// ESKI hata\n" },
  });
  assert.equal(err, undefined);
  assert.equal(sum!.status, "success");
});

test("formatter onaydan önce çalışır; commit'lenen = formatlanmış hâl", async () => {
  const fmt = `  format: "sed -i 's/ekspres = false/ekspres=false/' {{files}}"`;
  const { s: sum, root } = await run({}, "", 0.1, { commands: `  testRelated: "node --test {{testFiles}}"\n${fmt}` });
  assert.equal(sum!.status, "success");
  assert.match(gitOk(["show", `${sum!.branch}:src/fiyat.js`], root), /ekspres=false/);
});

test("linkDirs: node_modules bağlanır, değişiklik sayılmaz", async () => {
  const { s: sum, err } = await run({}, 'linkDirs: ["node_modules"]', 0.1, {}, (root) => {
    fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true });
  });
  assert.equal(err, undefined);
  assert.ok(!fs.existsSync(sum!.worktree!), "başarıdan sonra worktree kaldırılır");
  assert.equal(sum!.commits.length, 2);
});

test("mutant kum havuzu: kopyayı bozmak gerçek kodu etkilemez, testler kırılır", () => {
  const root = makeRepo();
  const dir = path.join(os.tmpdir(), `flowloop-mut-${Date.now()}`);
  const m = new MutantSandbox(root, dir, () => "npm test --silent", [], 60);
  m.reset();
  assert.equal(m.test().code, 0);
  fs.writeFileSync(path.join(dir, "src/fiyat.js"), "export function fiyat(){ return 1; }\n");
  assert.notEqual(m.test().code, 0, "mutasyon testleri kırmalı");
  assert.match(fs.readFileSync(path.join(root, "src/fiyat.js"), "utf8"), /kg <= 5/, "gerçek kod değişmemeli");
  m.reset();
  assert.equal(m.test().code, 0);
});

test("dry-run hiçbir şey çalıştırmaz", async () => {
  const root = makeRepo();
  const agent = new FakeAgent(good);
  const log = silentLogger();
  const s = await runTask({ root, taskFile: ".flowloop/tasks/ekspres.md", agent, log, dryRun: true, noFetch: true });
  assert.equal(s.status, "dry-run");
  assert.equal(agent.calls.length, 0);
  assert.ok(log.lines.some((l) => l.includes("reviewer")));
  assert.equal(sh("git", ["worktree", "list"], root).stdout.trim().split("\n").length, 1);
});

test("başarıdan sonra branch kullanıcının repo'sunda checkout edilebilir", async () => {
  const { s: sum, root } = await run({});
  assert.equal(sum!.status, "success");
  gitOk(["checkout", "-q", sum!.branch!], root);
  assert.match(fs.readFileSync(path.join(root, "src/fiyat.js"), "utf8"), /ekspres/);
});

test("önceki başarısız çalıştırmadan kalan boş branch temizlenir, -2 eklenmez", async () => {
  const first = await run({ reviewer: () => "VERDICT: FAIL" });
  assert.ok(first.err);
  const agent = new FakeAgent(good);
  const s2 = await runTask({ root: first.root, taskFile: ".flowloop/tasks/ekspres.md", agent, log: silentLogger(), noFetch: true, now: () => new Date(2026, 9, 3, 13, 0, 0) });
  assert.equal(s2.branch, "KG-42-ekspres-teslimat");
});

test("push + Jira yorumu: branch origin'e gider, yoruma özet + teslim bilgisi eklenir", async () => {
  let posted: { url: string; body: any } | undefined;
  const fetchFn = async (url: string, init: any) => {
    posted = { url, body: JSON.parse(init.body) };
    return { ok: true, status: 201, json: async () => ({ id: "777" }), text: async () => "" };
  };
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-origin-"));
  gitOk(["init", "-q", "--bare"], bare);
  const root = makeRepo('push: true\njira: { baseUrl: "https://kg.atlassian.net", comment: true }');
  gitOk(["remote", "add", "origin", bare], root);
  gitOk(["push", "-q", "origin", "main"], root);
  const agent = new FakeAgent({
    ...good,
    committer: (req, n) => {
      good.committer!(req, n);
      fs.writeFileSync(path.join(req.runRoot, "summary.md"), "## Sorun\nPin rengi yanlış.\n## Yapılan\n- Durum önceliği eklendi.");
    },
  });
  const s = await runTask({ root, taskFile: ".flowloop/tasks/ekspres.md", agent, log: silentLogger(), noFetch: true, jira: { fetchFn, email: "a", token: "t" } });
  assert.equal(s.pushed, true);
  assert.equal(gitOk(["rev-parse", s.branch!], bare), gitOk(["rev-parse", s.branch!], root));
  assert.equal(posted!.url, "https://kg.atlassian.net/rest/api/2/issue/KG-42/comment");
  const body: string = posted!.body.body;
  assert.match(body, /^h3\. Sorun\nPin rengi yanlış\./);
  assert.match(body, /h3\. Teslim/);
  assert.match(body, /KG-42-ekspres-teslimat/);
  assert.match(body, /feat\(fiyat\): ekspres teslimat/);
  assert.match(body, /insan incelemesi/);
  assert.match(body, /Claude ile hazırlandı\* — flowloop \d+\.\d+\.\d+ \(Claude Agent SDK 0\.3\.\d+\)/);
  assert.match(body, /Modeller:\* analist: claude-sonnet-4-test · developer: claude-sonnet-4-test · reviewer: claude-opus-4-test · committer: claude-sonnet-4-test/);
  assert.match(body, /Başlatan:\*/);
  assert.equal(s.jiraCommentUrl, "https://kg.atlassian.net/browse/KG-42?focusedCommentId=777");
});

test("push ya da Jira başarısız olursa iş kaybolmaz, uyarı verilir", async () => {
  const fetchFn = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" });
  const root = makeRepo('push: true\njira: { baseUrl: "https://kg.atlassian.net" }');
  gitOk(["remote", "add", "origin", "/yok/olan/remote"], root);
  const s = await runTask({ root, taskFile: ".flowloop/tasks/ekspres.md", agent: new FakeAgent(good), log: silentLogger(), noFetch: true, jira: { fetchFn, email: "a", token: "t" } });
  assert.equal(s.status, "success");
  assert.equal(s.pushed, undefined);
  assert.ok(s.warnings.some((w) => /Push başarısız/.test(w)));
  assert.ok(s.warnings.some((w) => /Jira yorumu eklenemedi/.test(w)));
  assert.equal(gitOk(["rev-parse", "--verify", s.branch!], root).length, 40);
});

import { ensureExcluded, resumeRun } from "../src/orchestrator.js";

test("node_modules bağlantısı ajanların git status'unda görünmez ve okunamaz", async () => {
  let committerStatus = "x";
  let readDeny: string[] = [];
  const { s: sum, err } = await run(
    {
      committer: (req, n) => {
        committerStatus = gitOk(["status", "--porcelain", "--", "node_modules"], req.cwd);
        readDeny = req.policy.readDeny;
        good.committer!(req, n);
      },
    },
    'linkDirs: ["node_modules"]',
    0.1,
    {},
    (root) => fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true }),
  );
  assert.equal(err, undefined);
  assert.equal(sum!.status, "success");
  assert.equal(committerStatus, "", "committer node_modules'u takip edilmeyen dosya olarak görmemeli");
  assert.ok(readDeny.includes("node_modules/**"));
});

test("ensureExcluded idempotent", () => {
  const root = makeRepo();
  ensureExcluded(root, ["node_modules"]);
  ensureExcluded(root, ["node_modules"]);
  const ex = fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8");
  assert.equal(ex.split("\n").filter((l) => l === "/node_modules").length, 1);
});

test("resume: commit aşamasında kalan iş, analist/developer/reviewer tekrar çalışmadan tamamlanır", async () => {
  const first = await run({ committer: () => "COMMIT İPTAL: deneme" });
  assert.match(first.err!, /Committer iptal etti/);
  const runsDir = path.join(first.root, "..", path.basename(first.root) + "-work", path.basename(first.root));
  const id = fs.readdirSync(runsDir)[0];
  const agent = new FakeAgent(good);
  const s = await resumeRun({ root: first.root, resume: id, taskFile: "", agent, log: silentLogger(), noPush: true });
  assert.equal(s.status, "success");
  assert.deepEqual(agent.calls.map((c) => c.role), ["committer"]);
  assert.equal(s.commits.length, 2);
  assert.equal(gitOk(["rev-parse", "--verify", s.branch!], first.root).length, 40);
});

test("resume: onay alınamamış iş, analist/developer tekrar çalışmadan reviewer → committer ile tamamlanır", async () => {
  const first = await run({ reviewer: () => "eksik var\nVERDICT: FAIL" });
  assert.match(first.err!, /onay alınamadı/);
  const runsDir = path.join(first.root, "..", path.basename(first.root) + "-work", path.basename(first.root));
  const id = fs.readdirSync(runsDir)[0];
  const agent = new FakeAgent(good);
  const s = await resumeRun({ root: first.root, resume: id, taskFile: "", agent, log: silentLogger(), noPush: true });
  assert.equal(s.status, "success");
  assert.deepEqual(agent.calls.map((c) => c.role), ["reviewer", "committer"]);
});

test("plan onayı: yorum analiste gider, plan güncellenir, onaydan sonra geliştirme devam eder", async () => {
  const root = makeRepo("");
  const agent = new FakeAgent({
    ...good,
    analist: (req) => {
      if (/BU BİR PLAN REVİZYONU/.test(req.prompt)) {
        assert.match(req.prompt, /indirim de olsun/, "yorum analistin prompt'unda");
        assert.match(fs.readFileSync(planFile(req), "utf8"), /sürüm 1/, "analist önceki planı görüyor");
        fs.writeFileSync(planFile(req), "# Plan sürüm 2\nAK-1: ekspres +50\nAK-2: indirim\n");
        return "AK-2 eklendi";
      }
      fs.writeFileSync(planFile(req), "# Plan sürüm 1\nAK-1: ekspres +50\n");
    },
  });
  const seen: string[] = [];
  const decisions: PlanDecision[] = [{ action: "revise", comment: "indirim de olsun" }, { action: "approve" }];
  const s = await runTask({
    root, taskFile: ".flowloop/tasks/ekspres.md", agent, log: silentLogger(), noFetch: true, planApproval: true,
    reviewPlan: async (plan) => (seen.push(plan), decisions.shift()!),
  });
  assert.equal(s.status, "success");
  assert.deepEqual(agent.calls.map((c) => c.role).slice(0, 3), ["analist", "analist", "developer"]);
  assert.match(seen[1], /sürüm 2/);
  assert.deepEqual(s.planFeedback, [{ round: 1, comment: "indirim de olsun" }]);
  assert.match(fs.readFileSync(path.join(s.runDir!, "run", "plan-feedback.md"), "utf8"), /indirim de olsun/);
});

test("plan iptal edilirse saklanır; görev yeniden çalışınca analiz tekrarlanmadan aynı plan sunulur", async () => {
  const root = makeRepo("");
  const a1 = new FakeAgent({ ...good, analist: (req) => void fs.writeFileSync(planFile(req), "# Önceki plan\nAK-1: ekspres\n") });
  await assert.rejects(
    runTask({ root, taskFile: ".flowloop/tasks/ekspres.md", agent: a1, log: silentLogger(), noFetch: true, planApproval: true, reviewPlan: async () => ({ action: "cancel" }), now: () => new Date(2026, 9, 3, 12, 0, 0) }),
    /Plan onaylanmadı. Plan saklandı/,
  );
  const a2 = new FakeAgent(good);
  let ctxSeen: { reused: boolean } | undefined;
  const s = await runTask({
    root, taskFile: ".flowloop/tasks/ekspres.md", agent: a2, log: silentLogger(), noFetch: true, planApproval: true,
    reviewPlan: async (plan, ctx) => {
      ctxSeen = ctx;
      assert.match(plan, /Önceki plan/);
      return { action: "approve" };
    },
    now: () => new Date(2026, 9, 3, 13, 0, 0),
  });
  assert.equal(s.status, "success");
  assert.equal(ctxSeen?.reused, true);
  assert.ok(!a2.calls.some((c) => c.role === "analist"), "analist tekrar çalışmadı");
  assert.ok(s.planFrom);
});

test("önceki plan istenmezse baştan analiz edilir", async () => {
  const root = makeRepo("");
  const a1 = new FakeAgent({ ...good, analist: (req) => void fs.writeFileSync(planFile(req), "# Eski\n") });
  await assert.rejects(runTask({ root, taskFile: ".flowloop/tasks/ekspres.md", agent: a1, log: silentLogger(), noFetch: true, planApproval: true, reviewPlan: async () => ({ action: "cancel" }), now: () => new Date(2026, 9, 3, 12, 0, 0) }));
  const a2 = new FakeAgent({ ...good, analist: (req) => void fs.writeFileSync(planFile(req), "# Yeni\nAK-1\n") });
  const decisions: PlanDecision[] = [{ action: "restart" }, { action: "approve" }];
  const plans: string[] = [];
  const s = await runTask({
    root, taskFile: ".flowloop/tasks/ekspres.md", agent: a2, log: silentLogger(), noFetch: true, planApproval: true,
    reviewPlan: async (p) => (plans.push(p), decisions.shift()!), now: () => new Date(2026, 9, 3, 13, 0, 0),
  });
  assert.equal(s.status, "success");
  assert.match(plans[0], /Eski/);
  assert.match(plans[1], /Yeni/);
  assert.equal(a2.calls.filter((c) => c.role === "analist").length, 1);
});

test("iş bitince kullanıcı değişiklik ister: yorum developer'a ve reviewer'a gider, onaydan sonra commit", async () => {
  const root = makeRepo("");
  const agent = new FakeAgent({
    ...good,
    developer: (req, n) => {
      good.developer!(req, n);
      if (/KULLANICININ DEĞİŞİKLİK İSTEĞİ/.test(req.prompt)) {
        assert.match(req.prompt, /ekspres ücreti 60 olsun/);
        W(req, "src/fiyat.js", 'export function fiyat(kg, ekspres = false) {\n  const n = kg <= 5 ? 90 : 140;\n  return ekspres ? n + 60 : n;\n}\n');
        W(req, "test/ekspres.test.js", 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { fiyat } from "../src/fiyat.js";\ntest("ekspres", () => assert.equal(fiyat(3, true), 150));\n');
      }
    },
    reviewer: (req) => {
      if (/KULLANICININ DEĞİŞİKLİK İSTEĞİ/.test(req.prompt)) assert.match(req.prompt, /karşılanmadıysa FAIL/);
      return "VERDICT: PASS";
    },
  });
  const infos: (ChangeReviewInfo & { fullDiff: string })[] = [];
  const decisions: ChangeDecision[] = [{ action: "revise", comment: "ekspres ücreti 60 olsun" }, { action: "approve" }];
  const s = await runTask({
    root, taskFile: ".flowloop/tasks/ekspres.md", agent, log: silentLogger(), noFetch: true,
    reviewChanges: async (info) => (infos.push({ ...info, fullDiff: info.diff() }), decisions.shift()!),
  });
  assert.equal(s.status, "success");
  assert.equal(s.userApproved, true);
  assert.deepEqual(s.changeRequests, [{ round: 1, comment: "ekspres ücreti 60 olsun" }]);
  assert.deepEqual(agent.calls.map((c) => c.role), ["analist", "developer", "reviewer", "developer", "reviewer", "committer"]);
  assert.match(infos[0].diffStat, /src\/fiyat\.js/);
  assert.match(infos[0].diffStat, /test\/ekspres\.test\.js/, "yeni dosyalar da farkta görünür");
  assert.match(infos[1].fullDiff, /n \+ 60/);
  assert.equal(gitOk(["show", `${s.branch}:src/fiyat.js`], root).includes("n + 60"), true, "commit'lenen içerik isteği içeriyor");
});

test("kullanıcı onaylamazsa commit yapılmaz; resume ile onaylanıp tamamlanır", async () => {
  const root = makeRepo("");
  const a1 = new FakeAgent(good);
  let err = "";
  try {
    await runTask({ root, taskFile: ".flowloop/tasks/ekspres.md", agent: a1, log: silentLogger(), noFetch: true, reviewChanges: async () => ({ action: "cancel" }) });
  } catch (e) {
    err = (e as Error).message;
  }
  assert.match(err, /Değişiklikler onaylanmadı; commit yapılmadı/);
  assert.ok(!a1.calls.some((c) => c.role === "committer"), "committer çalışmadı");
  const id = /flowloop resume (\S+)/.exec(err)![1];
  const a2 = new FakeAgent(good);
  let asked = 0;
  const s = await resumeRun({ root, resume: id, taskFile: "", agent: a2, log: silentLogger(), noPush: true, reviewChanges: async (i) => (asked++, assert.equal(i.canRevise, false), { action: "approve" }) });
  assert.equal(asked, 1);
  assert.equal(s.status, "success");
  assert.deepEqual(a2.calls.map((c) => c.role), ["committer"]);
});
