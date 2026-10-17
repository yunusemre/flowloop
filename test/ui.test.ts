import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRequest, AgentResult, AgentRunner } from "../src/agent.js";
import { gitOk, sh } from "../src/git.js";
import { addProject, readProjects, startUi, validateAnswer } from "../src/ui.js";

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-ui-"));
  const w = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  w("package.json", JSON.stringify({ name: "demo", type: "module" }));
  w("src/fiyat.js", "export function fiyat(kg) {\n  return kg <= 5 ? 90 : 140;\n}\n");
  w(".gitignore", "node_modules/\n");
  w(".flowloop/tasks/ekspres.md", "# Görev: Ekspres teslimat\n\nJira: KG-42\n\n1. ekspres +50 TL\n");
  w(
    ".flowloop/flowloop.yaml",
    `version: 2
stack: node
branchName: "{{jira}}-{{slug}}"
commands:
  testRelated: "node --test {{testFiles}}"
paths: { edit: ["src/**", "test/**"], readDeny: [".env"] }
mutation: { enabled: false }
workDir: ${JSON.stringify(path.join(root, "..", path.basename(root) + "-work"))}
`,
  );
  const g = (...a: string[]) => gitOk(["-c", "user.name=t", "-c", "user.email=t@t", ...a], root);
  g("init", "-q", "-b", "main");
  g("add", "-A");
  g("commit", "-qm", "chore: init");
  return root;
}

class FakeAgent implements AgentRunner {
  async run(req: AgentRequest): Promise<AgentResult> {
    const W = (rel: string, body: string) => {
      fs.mkdirSync(path.dirname(path.join(req.cwd, rel)), { recursive: true });
      fs.writeFileSync(path.join(req.cwd, rel), body);
    };
    const G = (...a: string[]) => gitOk(["-c", "user.name=ai", "-c", "user.email=ai@x", ...a], req.cwd);
    let text = "tamam";
    if (req.role === "analist") fs.writeFileSync(path.join(req.runRoot, "plan.md"), "# Plan\n\n- AK-1: ekspres +50\n");
    if (req.role === "developer") {
      W("src/fiyat.js", "export function fiyat(kg, e = false) {\n  const n = kg <= 5 ? 90 : 140;\n  return e ? n + 50 : n;\n}\n");
      W("test/ekspres.test.js", 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { fiyat } from "../src/fiyat.js";\ntest("e", () => assert.equal(fiyat(3, true), 140));\n');
    }
    if (req.role === "reviewer") text = "✅ iyi\nVERDICT: PASS";
    if (req.role === "committer") {
      G("add", "-A");
      G("commit", "-qm", "feat(fiyat): ekspres");
    }
    return { ok: true, text, costUsd: 0.1, denials: [], models: [] };
  }
}

test("ui: cevaplar kartın beklediği biçime zorlanır", () => {
  assert.deepEqual(validateAnswer("plan", { action: "approve", extra: 1 }, {}), { action: "approve" });
  assert.throws(() => validateAnswer("plan", { action: "revise", comment: "  " }, {}));
  assert.throws(() => validateAnswer("plan", { action: "restart" }, { reused: false }));
  assert.deepEqual(validateAnswer("questions", { action: "answer", answers: { "S-1": "evet", "X-9": "sızma" } }, { questions: [{ id: "S-1", text: "?" }] }), { action: "answer", answers: { "S-1": "evet" } });
  assert.throws(() => validateAnswer("questions", { action: "jira" }, { canPostToJira: false }));
  assert.deepEqual(validateAnswer("triage", { choices: [{ choice: "fix", note: "şunu yap" }, { choice: "hack" }] }, { items: [{ suggest: "manual" }, { suggest: "followup" }] }), [{ choice: "fix", note: "şunu yap" }, { choice: "followup" }]);
  assert.throws(() => validateAnswer("triage", { choices: [] }, { items: [{ suggest: "manual" }] }));
  assert.deepEqual(validateAnswer("scope", { action: "expand", repos: ["a", "kotu"] }, { expandable: ["a", "b"] }), { action: "expand", repos: ["a"] });
  assert.throws(() => validateAnswer("budget", { amount: 500 }, {}));
  assert.equal(validateAnswer("budget", { amount: 0 }, {}), 0);
  assert.throws(() => validateAnswer("changes", { action: "revise", comment: "x" }, { canRevise: false }));
});

test("ui: proje kaydı sadece flowloop kurulu git repolarını kabul eder", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-uih-"));
  assert.throws(() => addProject(os.tmpdir(), home), /Git reposu değil|flowloop kurulu değil/);
  const root = makeRepo();
  const p = addProject(root, home);
  assert.equal(addProject(root, home).name, p.name, "aynı klasör iki kez eklenmez");
  assert.equal(readProjects(home).length, 1);
});

test("ui: anahtarsız ya da başka adresten gelen istek reddedilir", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-uih-"));
  const ui = await startUi({ port: 0, home });
  try {
    const base = `http://127.0.0.1:${ui.port}`;
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers: { "x-flowloop-token": "yanlis" } })).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers: { "x-flowloop-token": ui.token, origin: "https://kotu.example" } })).status, 403);
    assert.equal((await fetch(`${base}/api/state`, { headers: { "x-flowloop-token": ui.token } })).status, 200);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.ok(ui.url.includes(`#t=${ui.token}`), "anahtar adresin # kısmında: sunucuya ve loglara gitmez");
  } finally {
    await ui.close();
  }
});

test("ui: görev sohbetten başlar; plan ve değişiklik onayı kart olarak gelir, cevapla iş tamamlanır", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-uih-"));
  const root = makeRepo();
  const p = addProject(root, home);
  const ui = await startUi({ port: 0, home, createAgent: () => ({ runner: new FakeAgent(), backend: "claude", reason: "test" }), runExtras: { noFetch: true, home } });
  const base = `http://127.0.0.1:${ui.port}`;
  const call = async (method: string, url: string, body?: unknown) => {
    const r = await fetch(base + url, { method, headers: { "x-flowloop-token": ui.token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    return j;
  };
  const waitFor = async (pred: (s: any) => boolean, ms = 30_000) => {
    const t0 = Date.now();
    for (;;) {
      const st = await call("GET", "/api/state");
      const s = st.sessions[0];
      if (s && pred(s)) return s;
      if (Date.now() - t0 > ms) throw new Error(`zaman aşımı: ${JSON.stringify(s?.messages?.slice(-5))}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  try {
    const { session } = await call("POST", "/api/run", { project: p.name, task: ".flowloop/tasks/ekspres.md", approvePlan: true });
    await assert.rejects(call("POST", "/api/run", { project: p.name, task: ".flowloop/tasks/ekspres.md" }), /süren bir çalıştırma var/);
    let s = await waitFor((x) => x.prompt?.kind === "plan");
    assert.match(s.prompt.payload.plan, /AK-1/);
    await assert.rejects(call("POST", `/api/sessions/${session}/answer`, { prompt: "eski", value: { action: "approve" } }), /artık beklenmiyor/);
    await call("POST", `/api/sessions/${session}/answer`, { prompt: s.prompt.id, value: { action: "approve" } });
    s = await waitFor((x) => x.prompt?.kind === "changes" || x.status === "failed");
    assert.equal(s.status, "waiting", JSON.stringify(s.messages.slice(-5)));
    assert.match(s.prompt.payload.diffStat, /fiyat\.js/);
    const { diff } = await call("GET", `/api/sessions/${session}/diff`);
    assert.match(diff, /\+  return e \? n \+ 50 : n;/);
    await call("POST", `/api/sessions/${session}/answer`, { prompt: s.prompt.id, value: { action: "approve" } });
    s = await waitFor((x) => x.status === "done" || x.status === "failed");
    assert.equal(s.status, "done", JSON.stringify(s.messages.slice(-5)));
    assert.ok(s.messages.some((m: any) => m.level === "user" && /Planı onayladım/.test(m.text)));
    assert.ok(s.messages.some((m: any) => m.level === "done" && /1 commit/.test(m.text)));
    const runs = await call("GET", `/api/projects/${encodeURIComponent(p.name)}/runs`);
    assert.equal(runs[0].status, "success");
  } finally {
    await ui.close();
  }
});

test("ui: projelerin olduğu üst klasör verilirse flowloop kurulu repoların hepsi eklenir", async () => {
  const { addProjectsFrom } = await import("../src/ui.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-uih-"));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-work-"));
  const a = makeRepo();
  fs.renameSync(a, path.join(parent, "a-repo"));
  fs.mkdirSync(path.join(parent, "grup"));
  const b = makeRepo();
  fs.renameSync(b, path.join(parent, "grup", "b-repo"));
  fs.mkdirSync(path.join(parent, "kurulu-degil", ".git"), { recursive: true });
  const r = addProjectsFrom(parent, home);
  assert.deepEqual(r.added.map((p) => p.name).sort(), ["a-repo", "b-repo"]);
  assert.deepEqual(r.notReady, ["kurulu-degil"]);
  assert.equal(addProjectsFrom(parent, home).added.length, 2, "tekrar eklemek çoğaltmaz");
  assert.equal(readProjects(home).length, 2);
});

test("ui: iki projeyi kapsayan iş — ikincisi 'değiştirir' seçilir, ikisinde de commit; o proje bu sırada meşgul", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-uih-"));
  const main = makeRepo();
  const backend = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-backend-"));
  const w = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(backend, rel)), { recursive: true });
    fs.writeFileSync(path.join(backend, rel), body);
  };
  w("package.json", JSON.stringify({ name: "backend", type: "module" }));
  w("src/api.js", "export const LIMIT = 10;\n");
  w("README.md", "# backend\n");
  w(".env", "SECRET=1\n");
  w(".gitignore", ".env\n");
  w(".flowloop/flowloop.yaml", 'version: 2\ncommands:\n  testRelated: "node --test {{testFiles}}"\npaths: { edit: ["src/**", "test/**"], readDeny: [".env"] }\n');
  gitOk(["-c", "user.name=t", "-c", "user.email=t@t", "init", "-q", "-b", "main"], backend);
  gitOk(["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], backend);
  gitOk(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "chore: init"], backend);
  const p = addProject(main, home);
  const b = addProject(backend, home);

  let backendWt = "";
  class TwoRepoAgent extends FakeAgent {
    async run(req: AgentRequest): Promise<AgentResult> {
      if (req.role === "analist") assert.match(req.prompt, new RegExp(`${b.name}: \`[^\`]+\` — değiştirilebilir yollar: src/\\*\\*`));
      if (req.role === "developer") {
        backendWt = req.extraDirs!.find((d) => d.includes(`wt-${b.name}`))!;
        fs.writeFileSync(path.join(backendWt, "src/api.js"), "export const LIMIT = 20;\n");
        fs.mkdirSync(path.join(backendWt, "test"), { recursive: true });
        fs.writeFileSync(path.join(backendWt, "test/api.test.js"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { LIMIT } from "../src/api.js";\ntest("l", () => assert.equal(LIMIT, 20));\n');
      }
      if (req.role === "committer") fs.writeFileSync(path.join(req.runRoot, `commit-msg-${b.name}.txt`), "feat(api): limit 20");
      return super.run(req);
    }
  }
  const ui = await startUi({ port: 0, home, createAgent: () => ({ runner: new TwoRepoAgent(), backend: "claude", reason: "test" }), runExtras: { noFetch: true, home } });
  const call = async (method: string, url: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${ui.port}${url}`, { method, headers: { "x-flowloop-token": ui.token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    return j;
  };
  const waitFor = async (pred: (s: any) => boolean) => {
    for (let t0 = Date.now(); ; ) {
      const s = (await call("GET", "/api/state")).sessions[0];
      if (s && pred(s)) return s;
      if (Date.now() - t0 > 30_000) throw new Error(JSON.stringify(s?.messages?.slice(-6)));
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  try {
    const { session } = await call("POST", "/api/run", { project: p.name, task: ".flowloop/tasks/ekspres.md", approvePlan: false, related: [{ name: b.name, edit: true }] });
    await assert.rejects(call("POST", "/api/run", { project: b.name, task: "x.md" }), /süren bir çalıştırma var/, "değiştirilen proje meşgul");
    let s = await waitFor((x) => x.prompt?.kind === "changes" || x.status === "failed");
    assert.equal(s.status, "waiting", JSON.stringify(s.messages.slice(-6)));
    assert.match(s.prompt.payload.diffStat, new RegExp(`━━ ${b.name} ━━[\\s\\S]*src/api\\.js`), "değişiklik onayında iki repo da görünür");
    assert.ok(s.messages.some((m: any) => /Birlikte çalışılan projeler: .*değiştirir/.test(m.text)));
    await call("POST", `/api/sessions/${session}/answer`, { prompt: s.prompt.id, value: { action: "approve" } });
    s = await waitFor((x) => x.status === "done" || x.status === "failed");
    assert.equal(s.status, "done", JSON.stringify(s.messages.slice(-6)));
    const done = s.messages.find((m: any) => m.level === "done").text;
    assert.match(done, new RegExp(`${b.name}: 1 commit`));
    assert.match(gitOk(["log", "--all", "--format=%s"], backend), /feat\(api\): limit 20/);
    assert.deepEqual(readProjects(home).find((x) => x.name === p.name)!.companions, [{ name: b.name, edit: true }], "seçim hatırlanır");
  } finally {
    await ui.close();
  }
});

test("ui: çalıştırma silinir — çalışma kopyaları ve klasör gider, commit'li branch kalır, boş branch silinir", async () => {
  const { deleteRun, projectRuns } = await import("../src/ui.js");
  const { runTask, FlowloopError } = await import("../src/orchestrator.js");
  const { silentLogger } = await import("../src/log.js");
  const root = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-uih-"));
  // 1) başarılı çalıştırma: branch'te commit var → korunur
  const ok = await runTask({ root, taskFile: ".flowloop/tasks/ekspres.md", agent: new FakeAgent(), log: silentLogger(), noFetch: true, home });
  // 2) reviewer hiç onaylamaz → çalışma kopyası kalır, branch boş
  class NeverPass extends FakeAgent {
    async run(req: AgentRequest): Promise<AgentResult> {
      const r = await super.run(req);
      return req.role === "reviewer" ? { ...r, text: "❌ olmadı\nVERDICT: FAIL" } : r;
    }
  }
  fs.writeFileSync(path.join(root, ".flowloop/tasks/ikinci.md"), "# Görev: İkinci\n\nJira: KG-43\n\n1. x\n");
  await assert.rejects(runTask({ root, taskFile: ".flowloop/tasks/ikinci.md", agent: new NeverPass(), log: silentLogger(), noFetch: true, home }), FlowloopError);
  const runs = projectRuns(root);
  const failed = runs.find((r) => r.status === "failed")!;
  const failedDir = path.join(path.dirname(ok.runDir!), failed.id);
  assert.ok(fs.existsSync(path.join(failedDir, "wt")));
  const failedBranch = JSON.parse(fs.readFileSync(path.join(failedDir, "run.json"), "utf8")).branch;

  const r1 = deleteRun(root, failed.id);
  assert.ok(!fs.existsSync(failedDir));
  assert.deepEqual(r1.keptBranches, []);
  assert.notEqual(gitOk(["worktree", "list"], root).includes(failedDir), true, "worktree kaydı da gider");
  assert.equal(sh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${failedBranch}`], root).code, 1, "boş branch silinir");

  const r2 = deleteRun(root, ok.id);
  assert.ok(!fs.existsSync(ok.runDir!));
  assert.match(r2.keptBranches.join(), new RegExp(ok.branch!));
  assert.equal(sh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${ok.branch}`], root).code, 0, "commit'li branch kalır");
  assert.throws(() => deleteRun(root, "../etc"), /Geçersiz/);
  assert.ok(fs.existsSync(path.join(root, ".flowloop/history.jsonl")), "ölçüm geçmişi kalır");
});

test("ui: anahtar saklanır, yeniden başlatmada adres değişmez; --new-token yeniler", async () => {
  const { uiToken, readUiState, uiAlive } = await import("../src/ui.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-uih-"));
  const t1 = uiToken(home);
  assert.equal(uiToken(home), t1);
  assert.notEqual(uiToken(home, true), t1);
  assert.equal(readUiState(home)!.token.length >= 16, true);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(home, ".flowloop", "ui.json")).mode & 0o777, 0o600);
  assert.equal(await uiAlive({ token: "x".repeat(20), pid: 999999, port: 1 }), false, "çalışmayan süreç");
  const ui = await startUi({ port: 0, home, token: readUiState(home)!.token });
  try {
    assert.equal(await uiAlive({ token: readUiState(home)!.token, pid: process.pid, port: ui.port }), true);
    assert.equal(await uiAlive({ token: "baska-anahtar-1234567", pid: process.pid, port: ui.port }), false);
  } finally {
    await ui.close();
  }
});

test("ui: tarayıcı kapanınca (canlı akış bağlantısı koparsa) sunucu ve süren çalıştırma devam eder", async () => {
  const http = await import("node:http");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-uih-"));
  const root = makeRepo();
  const p = addProject(root, home);
  const ui = await startUi({ port: 0, home, createAgent: () => ({ runner: new FakeAgent(), backend: "claude", reason: "test" }), runExtras: { noFetch: true, home } });
  const H = { "x-flowloop-token": ui.token, "content-type": "application/json" };
  try {
    // birkaç sekme açılıp kapanır
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => {
        const req = http.get({ host: "127.0.0.1", port: ui.port, path: `/api/events?t=${ui.token}` }, (res) => res.once("data", () => (req.destroy(), resolve())));
        req.on("error", () => resolve());
      });
    }
    const r = await fetch(`http://127.0.0.1:${ui.port}/api/run`, { method: "POST", headers: H, body: JSON.stringify({ project: p.name, task: ".flowloop/tasks/ekspres.md", approvePlan: false }) });
    assert.equal(r.status, 200);
    let s: any;
    for (const t0 = Date.now(); Date.now() - t0 < 30_000; ) {
      s = (await (await fetch(`http://127.0.0.1:${ui.port}/api/state`, { headers: H })).json()).sessions[0];
      if (s?.prompt?.kind === "changes") break;
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.equal(s.prompt?.kind, "changes", "çalıştırma kopan bağlantılara rağmen ilerledi");
  } finally {
    await ui.close();
  }
});

test("ui: serbest yazılan istek görev dosyası olur; anahtar/bağlantı/dosya ise olduğu gibi kullanılır", async () => {
  const { isTaskRef, writeRequestTask, taskTitle } = await import("../src/ui.js");
  assert.ok(isTaskRef("IDT-22685"));
  assert.ok(isTaskRef("https://x.atlassian.net/browse/IDT-1"));
  assert.ok(isTaskRef(".flowloop/tasks/a.md"));
  assert.ok(!isTaskRef("düzelt"));
  const root = makeRepo();
  const rel = writeRequestTask(root, "ShipmentService'te desiyi ÖT zorunlu gönderide de işle\nIDT-23001 ile ilgili.", "Cevap: desi ShipmentItemManager.cs:120'de", new Date("2026-10-16T10:00:00Z"));
  assert.match(rel, /^\.flowloop\/tasks\/istek-20261016-100000-shipmentservice-te-desiyi-ot-zorunlu-g\w*\.md$/);
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  assert.match(text, /^# ShipmentService'te desiyi ÖT zorunlu gönderide de işle/);
  assert.match(text, /İlgili Jira kayıtları: IDT-23001/);
  assert.match(text, /## Sohbetten notlar\n\nCevap: desi/);
  assert.equal(taskTitle(root, rel), "IDT-23001 · ShipmentService'te desiyi ÖT zorunlu gönderide de işle");
});

test("ui: soru modunda ajan sadece okur; takip sorusu aynı oturumla sürer; görev sayılmaz", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-uih-"));
  const root = makeRepo();
  const p = addProject(root, home);
  const seen: AgentRequest[] = [];
  const asker: AgentRunner = {
    async run(req) {
      seen.push(req);
      return { ok: true, text: `Cevap ${seen.length}: \`src/fiyat.js:2\` — token: ATATT1234567890abcdefghijklmnop`, costUsd: 0.05, denials: [], models: [], sessionId: "oturum-1" };
    },
  };
  const ui = await startUi({ port: 0, home, createAgent: () => ({ runner: asker, backend: "claude", reason: "test" }) });
  const call = async (method: string, url: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${ui.port}${url}`, { method, headers: { "x-flowloop-token": ui.token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    return j;
  };
  const waitDone = async (n: number) => {
    for (const t0 = Date.now(); Date.now() - t0 < 10_000; ) {
      const s = (await call("GET", "/api/state")).sessions[0];
      if (s && s.status !== "running" && s.messages.filter((m: any) => m.level === "answer").length >= n) return s;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error("cevap gelmedi");
  };
  try {
    const { session } = await call("POST", "/api/ask", { project: p.name, question: "Fiyat nerede hesaplanıyor?" });
    // soru sürerken aynı projede görev başlatılabilir (soru hiçbir şeyi değiştirmez)
    let s = await waitDone(1);
    assert.equal(s.kind, "ask");
    assert.deepEqual(seen[0].perms, { tools: ["Read", "Glob", "Grep"], read: ["**"], edit: [], bash: [] });
    assert.equal(seen[0].cwd, root);
    const answer = s.messages.find((m: any) => m.level === "answer").text;
    assert.match(answer, /src\/fiyat\.js:2/);
    assert.doesNotMatch(answer, /ATATT1234/, "cevapta gizli bilgi maskelenir");
    await call("POST", `/api/sessions/${session}/ask`, { question: "Ekspres için ne değişmeli?" });
    s = await waitDone(2);
    assert.equal(seen[1].resumeSessionId, "oturum-1", "takip sorusu aynı oturumdan");
    assert.equal(s.costUsd, 0.1);
    assert.equal((await call("GET", "/api/state")).projects[0].busy, false);
  } finally {
    await ui.close();
  }
});

test("ui: sohbetler kalıcı; yarım kalan iş yeniden başlatmadan sonra aynı sohbette kaldığı yerden sürer; geçmişten açılır", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-uih-"));
  const root = makeRepo();
  const p = addProject(root, home);
  const roles: string[] = [];
  let failDev = true;
  const agent: AgentRunner = {
    async run(req) {
      roles.push(req.role);
      if (req.role === "developer" && failDev) return { ok: false, text: "", error: "bağlantı koptu", costUsd: 0.1, denials: [], models: [] };
      return new FakeAgent().run(req);
    },
  };
  const open = () => startUi({ port: 0, home, createAgent: () => ({ runner: agent, backend: "claude", reason: "test" }), runExtras: { noFetch: true, home } });
  let ui = await open();
  const call = async (method: string, url: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${ui.port}${url}`, { method, headers: { "x-flowloop-token": ui.token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    return j;
  };
  const waitFor = async (id: string, pred: (s: any) => boolean) => {
    for (const t0 = Date.now(); Date.now() - t0 < 30_000; ) {
      const s = (await call("GET", "/api/state")).sessions.find((x: any) => x.id === id);
      if (s && pred(s)) return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("zaman aşımı");
  };
  try {
    const { session } = await call("POST", "/api/run", { project: p.name, task: ".flowloop/tasks/ekspres.md", approvePlan: false });
    let s = await waitFor(session, (x) => x.status === "failed");
    assert.ok(s.runId, "çalıştırma kimliği sohbete yazılır");
    assert.equal(s.canResume, true);
    const before = s.messages.length;
    await ui.close();

    // arayüz yeniden başlar: sohbet, mesajları ve devam imkânıyla geri gelir
    failDev = false;
    ui = await open();
    s = await waitFor(session, () => true);
    assert.equal(s.title, "KG-42 · Ekspres teslimat");
    assert.ok(s.messages.length >= before);
    assert.equal(s.canResume, true);
    const analistBefore = roles.filter((r) => r === "analist").length;
    await call("POST", `/api/sessions/${session}/resume`);
    s = await waitFor(session, (x) => x.prompt?.kind === "changes" || x.status === "failed");
    assert.equal(s.status, "waiting", JSON.stringify(s.messages.slice(-4)));
    await call("POST", `/api/sessions/${session}/answer`, { prompt: s.prompt.id, value: { action: "approve" } });
    s = await waitFor(session, (x) => x.status === "done" || x.status === "failed");
    assert.equal(s.status, "done", JSON.stringify(s.messages.slice(-4)));
    assert.equal(roles.filter((r) => r === "analist").length, analistBefore, "analist tekrar çalışmaz");
    assert.ok(s.messages.some((m: any) => m.text === "Kaldığı yerden devam"));
    assert.ok(s.messages.some((m: any) => /bağlantı koptu/.test(m.text)), "önceki mesajlar aynı sohbette");
    assert.equal(s.canResume, false);
    assert.equal((await call("GET", "/api/state")).sessions.length, 1, "yeni sohbet açılmaz");

    // geçmişten açma: sohbeti varsa o; sohbet kapatıldıysa kaydından özet
    assert.equal((await call("POST", "/api/runs/open", { project: p.name, id: s.runId })).session, session);
    await call("POST", `/api/sessions/${session}/dismiss`);
    assert.equal(fs.existsSync(path.join(home, ".flowloop", "ui", "chats", `${session}.json`)), false);
    const { session: imported } = await call("POST", "/api/runs/open", { project: p.name, id: s.runId });
    const im = await waitFor(imported, () => true);
    assert.equal(im.status, "done");
    assert.ok(im.messages.some((m: any) => /terminalde/.test(m.text)));
  } finally {
    await ui.close();
  }
});
