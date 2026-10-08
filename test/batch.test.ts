import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRequest, AgentResult, AgentRunner } from "../src/agent.js";
import { runBatch, parseBatchOrder, findUnfinishedBatch } from "../src/batch.js";
import { gitOk } from "../src/git.js";
import { silentLogger } from "../src/log.js";
import { FlowloopError } from "../src/orchestrator.js";
import type { RoleName } from "../src/roles.js";

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-batch-"));
  const w = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  w("package.json", JSON.stringify({ name: "demo", type: "module" }));
  w("src/index.js", "export const x = 1;\n");
  w(".gitignore", "node_modules/\n");
  for (const [k, t] of [["KG-1", "Fiyat ekranı"], ["KG-2", "Fiyat API'si"], ["KG-3", "Fiyat raporu"]]) {
    w(`.flowloop/tasks/${k}.md`, `# Görev: ${t}\n\nJira: ${k}\n\n${t} yapılacak.\n`);
  }
  w(
    ".flowloop/flowloop.yaml",
    `version: 2
stack: node
baseBranch: ""
branchName: "{{jira}}-{{slug}}"
commands:
  testRelated: "node --test {{testFiles}}"
paths: { edit: ["src/**", "test/**"], readDeny: [".env"] }
mutation: { enabled: false }
budgets: { analist: 1, gelistir: 3, commit: 0.5, total: 5 }
maxIterations: 2
workDir: ${JSON.stringify(path.join(root, "..", path.basename(root) + "-work"))}
`,
  );
  const g = (...a: string[]) => gitOk(a, root);
  g("init", "-q", "-b", "main");
  g("config", "user.name", "Test Kişi");
  g("config", "user.email", "test@sirket.com");
  g("add", "-A");
  g("commit", "-qm", "chore: init");
  return root;
}

type Script = (req: AgentRequest, n: number) => string | void;
class FakeAgent implements AgentRunner {
  calls: { role: RoleName; prompt: string; cwd: string }[] = [];
  constructor(public scripts: Partial<Record<RoleName, Script>>) {}
  async run(req: AgentRequest): Promise<AgentResult> {
    const n = this.calls.filter((c) => c.role === req.role).length + 1;
    this.calls.push({ role: req.role, prompt: req.prompt, cwd: req.cwd });
    const text = this.scripts[req.role]?.(req, n) ?? "tamam";
    return { ok: true, text, costUsd: 0.1, denials: [], models: ["test-model"] };
  }
}
const W = (req: AgentRequest, rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(req.cwd, rel)), { recursive: true });
  fs.writeFileSync(path.join(req.cwd, rel), body);
};
const G = (req: AgentRequest, ...a: string[]) => gitOk(["-c", "user.name=ai", "-c", "user.email=ai@x", ...a], req.cwd);
const keyOf = (req: AgentRequest) => /^# Görev (KG-\d+)/.exec(req.prompt)?.[1] ?? "?";
const files = [".flowloop/tasks/KG-1.md", ".flowloop/tasks/KG-2.md", ".flowloop/tasks/KG-3.md"];

const BATCH_PLAN_Q = `# Toplu plan
## Sıra
1. KG-2 — API önce
2. KG-1 — ekran API'yi kullanır
3. KG-3 — rapor en son

## Bağımlılıklar
KG-1 ve KG-3, KG-2'ye bağlı.

## Açık sorular
- S-1 (KG-1): Fiyat TL mi kuruş mu gösterilsin?
  Cevap gelmezse: TL
`;

function scripts(over: Partial<Record<RoleName, Script>> = {}): Partial<Record<RoleName, Script>> {
  return {
    analist: (req) => {
      const plan = path.join(req.runRoot, "plan.md");
      if (/TOPLU PLANLAMA/.test(req.prompt)) {
        if (/KULLANICI AÇIK SORULARI CEVAPLADI/.test(req.prompt)) fs.writeFileSync(plan, BATCH_PLAN_Q.replace(/## Açık sorular[\s\S]*$/, "## Açık sorular\nYok\n"));
        else fs.writeFileSync(plan, BATCH_PLAN_Q);
        return "toplu plan";
      }
      fs.writeFileSync(plan, `# Plan ${keyOf(req)}\nAK-1\n\n## Açık sorular\nYok\n`);
    },
    developer: (req) => {
      const k = keyOf(req).toLowerCase().replace("-", "");
      W(req, `src/${k}.js`, `export const ${k} = "${k}";\n`);
      W(req, `test/${k}.test.js`, `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { ${k} } from "../src/${k}.js";\ntest("${k}", () => assert.equal(${k}, "${k}"));\n`);
    },
    reviewer: () => "VERDICT: PASS",
    committer: (req) => {
      const k = keyOf(req);
      const f = k.toLowerCase().replace("-", "");
      G(req, "add", `src/${f}.js`, `test/${f}.test.js`);
      G(req, "commit", "-qm", `feat(fiyat): ${k} tamam`);
      fs.writeFileSync(path.join(req.runRoot, "summary.md"), `## Yapılan\n- ${k} yapıldı`);
    },
    ...over,
  };
}

test("toplu sıra: plandaki sıra, bilinmeyenler atlanır, eksikler sona eklenir", () => {
  assert.deepEqual(parseBatchOrder("## Sıra\n1. KG-3 — x\n2. KG-9 — yok\n3. KG-1\n", ["KG-1", "KG-2", "KG-3"]), {
    order: ["KG-3", "KG-1", "KG-2"],
    warnings: ["Toplu plandaki sırada olmayan görevler sona eklendi: KG-2"],
  });
  assert.deepEqual(parseBatchOrder("## Plan\n", ["A-1", "A-2"]).order, ["A-1", "A-2"]);
  // KG-1 ile KG-10 karışmaz
  assert.deepEqual(parseBatchOrder("## Sıra\n1. KG-10\n2. KG-1\n", ["KG-1", "KG-10"]).order, ["KG-10", "KG-1"]);
});

test("toplu çalışma: tek plan, sorular bir kez, görevler planlanan sırayla aynı branch'te", async () => {
  const root = makeRepo();
  const agent = new FakeAgent(scripts({
    analist: (req, n) => {
      if (!/TOPLU PLANLAMA/.test(req.prompt)) {
        // her görevin analisti toplu bağlamı görür
        assert.match(req.prompt, /## Toplu çalışma \(\d\/3\)/);
        assert.match(req.prompt, /Fiyat TL mi kuruş mu[\s\S]*Cevap: kuruş/);
        assert.match(req.prompt, /#### Sıra/, "toplu planın başlıkları görev başlığının altına iner");
      }
      return scripts().analist!(req, n);
    },
    developer: (req, n) => {
      const k = keyOf(req);
      if (k === "KG-1") {
        assert.ok(fs.existsSync(path.join(req.cwd, "src/kg2.js")), "önceki görevin commit'i çalışma kopyasında");
        assert.match(req.prompt, /Bu çalışmada tamamlanan görevler[\s\S]*KG-2 — Fiyat API'si[\s\S]*feat\(fiyat\): KG-2 tamam[\s\S]*Özet: ## Yapılan - KG-2 yapıldı/);
      }
      return scripts().developer!(req, n);
    },
  }));
  const asked: string[][] = [];
  const st = await runBatch({
    root, taskFiles: files, agent, log: silentLogger(), noFetch: true, planApproval: true,
    answerQuestions: async (qs) => (asked.push(qs.map((q) => `${q.id}:${q.key}`)), { action: "answer", answers: { "S-1": "kuruş" } }),
    reviewPlan: async () => ({ action: "approve" }),
    now: () => new Date(2026, 9, 8, 10, 0, 0),
  });
  assert.equal(st.status, "success");
  assert.deepEqual(asked, [["S-1:KG-1"]], "sorular toplu planda bir kez soruldu");
  assert.deepEqual(st.order, ["KG-2", "KG-1", "KG-3"]);
  assert.equal(st.branch, "KG-1-fiyat-ekrani");
  const log = gitOk(["log", "--format=%s", `main..${st.branch}`], root).split("\n");
  assert.deepEqual(log, ["feat(fiyat): KG-3 tamam", "feat(fiyat): KG-1 tamam", "feat(fiyat): KG-2 tamam"]);
  assert.equal(gitOk(["log", "--oneline", "main"], root).split("\n").length, 1, "main değişmedi");
  assert.deepEqual(agent.calls.filter((c) => c.role === "analist").length, 2 + 3, "toplu plan (2: soru + cevap) + görev başına 1");
  assert.ok(st.tasks.every((t) => t.status === "success" && t.commits?.length === 1));
  assert.equal(gitOk(["worktree", "list"], root).split("\n").length, 1, "çalışma kopyaları temizlendi");
  assert.equal(st.questions[0].answer, "kuruş");
});

test("toplu çalışma: bir görev durursa çalışma durur; aynı komut tamamlananları atlayıp devam eder", async () => {
  const root = makeRepo();
  let breakKG1 = true;
  const agent = new FakeAgent(scripts({
    reviewer: (req) => (breakKG1 && /KG-1/.test(/^# Görev (KG-\d+)/.exec(req.prompt)?.[1] ?? "") ? "❌ olmadı\nVERDICT: FAIL" : "VERDICT: PASS"),
  }));
  const base = { root, taskFiles: files, agent, log: silentLogger(), noFetch: true, questionsMode: "assume" as const, now: () => new Date(2026, 9, 8, 10, 0, 0) };
  await assert.rejects(runBatch(base), (e: Error) => e instanceof FlowloopError && /KG-1 tamamlanamadı \(2\/3\)[\s\S]*Sıradaki görevler bekliyor: KG-3[\s\S]*aynı komutu tekrar çalıştır/.test(e.message));
  const work = path.join(root, "..", path.basename(root) + "-work", path.basename(root));
  const saved = findUnfinishedBatch([work], ["KG-3", "KG-2", "KG-1"])!;
  assert.equal(saved.status, "failed");
  assert.equal(saved.planned, true);
  assert.deepEqual(saved.tasks.map((t) => [t.key, t.status]), [["KG-1", "failed"], ["KG-2", "success"], ["KG-3", "pending"]]);
  assert.match(saved.questions.map((q) => q.assumed).join(), /TL/, "assume: varsayılan kaydedildi");

  breakKG1 = false;
  base.now = () => new Date(2026, 9, 8, 11, 0, 0);
  const before = agent.calls.filter((c) => /TOPLU PLANLAMA/.test(c.prompt)).length;
  const st = await runBatch(base);
  assert.equal(st.status, "success");
  assert.equal(st.id, saved.id, "aynı toplu çalışma sürdürüldü");
  assert.equal(agent.calls.filter((c) => /TOPLU PLANLAMA/.test(c.prompt)).length, before, "toplu plan tekrar yapılmadı");
  const devKeys = agent.calls.filter((c) => c.role === "developer").map((c) => /^# Görev (KG-\d+)/.exec(c.prompt)![1]);
  assert.deepEqual([...new Set(devKeys)], ["KG-2", "KG-1", "KG-3"], "KG-2 ikinci çalıştırmada tekrar yapılmadı");
  assert.equal(devKeys.filter((k) => k === "KG-2").length, 1);
  assert.deepEqual(gitOk(["log", "--format=%s", `main..${st.branch}`], root).split("\n"), ["feat(fiyat): KG-3 tamam", "feat(fiyat): KG-1 tamam", "feat(fiyat): KG-2 tamam"]);
});

test("toplu çalışma: etkileşimsiz ve questions: ask ise toplu planda durur, hiçbir göreve geçmez", async () => {
  const root = makeRepo();
  const agent = new FakeAgent(scripts());
  await assert.rejects(
    runBatch({ root, taskFiles: files, agent, log: silentLogger(), noFetch: true }),
    (e: Error) => /Açık sorular cevaplanmadı[\s\S]*flowloop run KG-1 KG-2 KG-3/.test(e.message),
  );
  assert.deepEqual(agent.calls.map((c) => c.role), ["analist"]);
  assert.equal(gitOk(["branch", "--list", "KG-1-*"], root), "", "branch açılmadı");
});

test("toplu çalışma: başarısız denemenin branch'e eklediği commit arşivlenir, tekrar denemede branch temiz başlar", async () => {
  const root = makeRepo();
  let misbehave = true;
  const agent = new FakeAgent(scripts({
    developer: (req, n) => {
      scripts().developer!(req, n);
      if (misbehave && keyOf(req) === "KG-1") {
        G(req, "add", "-A");
        G(req, "commit", "-qm", "feat: izinsiz commit");
      }
    },
  }));
  const base = { root, taskFiles: files, agent, log: silentLogger(), noFetch: true, questionsMode: "assume" as const, now: () => new Date(2026, 9, 8, 10, 0, 0) };
  await assert.rejects(runBatch(base), /Developer commit attı/);
  misbehave = false;
  base.now = () => new Date(2026, 9, 8, 12, 0, 0);
  const st = await runBatch(base);
  assert.equal(st.status, "success");
  assert.deepEqual(gitOk(["log", "--format=%s", `main..${st.branch}`], root).split("\n"), ["feat(fiyat): KG-3 tamam", "feat(fiyat): KG-1 tamam", "feat(fiyat): KG-2 tamam"]);
  const archived = gitOk(["branch", "--list", "flowloop-arsiv/*", "--format=%(refname:short)"], root);
  assert.match(archived, /^flowloop-arsiv\/KG-1-fiyat-ekrani-kg-1-/);
  assert.match(gitOk(["log", "-1", "--format=%s", archived], root), /izinsiz commit/);
});
