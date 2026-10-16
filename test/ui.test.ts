import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRequest, AgentResult, AgentRunner } from "../src/agent.js";
import { gitOk } from "../src/git.js";
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
