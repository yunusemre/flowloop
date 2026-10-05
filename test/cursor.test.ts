import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideCursor, mapCursorEvent } from "../src/cursorhook.js";
import { CursorAgentRunner, CURSOR_CO_AUTHOR, type HookContext } from "../src/cursor.js";
import { claudeAvailable } from "../src/backend.js";
import { DEFAULT_FORBIDDEN_FLAGS } from "../src/policy.js";
import { silentLogger } from "../src/log.js";

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kgflow-cur-"));
  const wt = path.join(base, "wt");
  const run = path.join(base, "run");
  fs.mkdirSync(path.join(wt, "src"), { recursive: true });
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(wt, "src/a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(wt, ".env"), "SECRET=1\n");
  return { base, wt, run };
}

const devPerms = { tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"], read: ["**", "run:**"], edit: ["src/**"], bash: ["npx jest --findRelatedTests", "git status"] };

function ctxFor(wt: string, run: string, perms = devPerms): HookContext {
  return { role: "developer", perms, policy: { repoRoot: wt, runRoot: run, readDeny: [".env"], forbiddenFlags: DEFAULT_FORBIDDEN_FLAGS }, denialsFile: path.join(run, "d.ndjson") };
}

test("cursor hook: Cursor araçları kgflow politikasına çevrilir", () => {
  const { wt, run } = sandbox();
  const ctx = ctxFor(wt, run);
  const ev = (o: Record<string, unknown>) => decideCursor(ctx, { cwd: wt, ...o });
  assert.equal(ev({ hook_event_name: "preToolUse", tool_name: "Write", tool_input: { path: "src/b.ts" } }).allow, true);
  assert.equal(ev({ hook_event_name: "preToolUse", tool_name: "Write", tool_input: { path: "package.json" } }).allow, false);
  assert.equal(ev({ hook_event_name: "preToolUse", tool_name: "Delete", tool_input: { path: ".git/config" } }).allow, false);
  assert.equal(ev({ hook_event_name: "preToolUse", tool_name: "Write", tool_input: { path: ".cursor/hooks.json" } }).allow, false, "yetki dosyası değiştirilemez");
  assert.equal(ev({ hook_event_name: "preToolUse", tool_name: "Read", tool_input: { path: ".env" } }).allow, false);
  assert.equal(ev({ hook_event_name: "beforeReadFile", file_path: path.join(wt, ".env") }).allow, false);
  assert.equal(ev({ hook_event_name: "preToolUse", tool_name: "Shell", tool_input: { command: "npx jest --findRelatedTests src/a.ts" } }).allow, true);
  assert.equal(ev({ hook_event_name: "beforeShellExecution", command: "git commit -m x" }).allow, false);
  assert.equal(ev({ hook_event_name: "beforeShellExecution", command: "git status && rm -rf /" }).allow, false);
  assert.equal(ev({ hook_event_name: "preToolUse", tool_name: "Task", tool_input: {} }).allow, false, "alt ajan yok");
  assert.equal(ev({ hook_event_name: "preToolUse", tool_name: "MCP:anything", tool_input: {} }).allow, false);
  assert.equal(ev({ hook_event_name: "beforeMCPExecution", tool_name: "x" }).allow, false);
  assert.equal(ev({ hook_event_name: "preToolUse", tool_name: "Write", tool_input: {} }).allow, false, "yolu olmayan yazma reddedilir");
  assert.equal(ev({ hook_event_name: "somethingNew" }).allow, false, "bilinmeyen olay reddedilir");
  assert.deepEqual(mapCursorEvent({ hook_event_name: "preToolUse", tool_name: "Grep", tool_input: { path: "src" }, cwd: wt }), { tool: "Grep", input: { path: path.join(wt, "src") } });
});

test("cursor hook: reviewer'ın yazma aracı Edit olarak değerlendirilir (sadece mutant kopyası)", () => {
  const { wt, run } = sandbox();
  const ctx = ctxFor(wt, run, { tools: ["Read", "Glob", "Grep", "Bash", "Edit"], read: ["**", "run:**"], edit: ["run:mutant/**"], bash: [] });
  assert.equal(decideCursor(ctx, { hook_event_name: "preToolUse", tool_name: "Write", tool_input: { path: path.join(run, "mutant/src/a.ts") } }).allow, true);
  assert.equal(decideCursor(ctx, { hook_event_name: "preToolUse", tool_name: "Write", tool_input: { path: "src/a.ts" }, cwd: wt }).allow, false);
});

/**
 * Sahte Cursor CLI: çalışma klasöründeki .cursor/hooks.json'u okur, FAKE_ACTIONS'daki her işlem
 * için gerçek Cursor gibi hook'u çağırır, izin çıkarsa dosyayı yazar ve stream-json üretir.
 */
const FAKE_CURSOR = `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const args = process.argv.slice(2);
const ws = args[args.indexOf("--workspace") + 1];
fs.writeFileSync(path.join(ws, "..", "args.json"), JSON.stringify(args));
const hooks = JSON.parse(fs.readFileSync(path.join(ws, ".cursor/hooks.json"), "utf8")).hooks;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", model: "fake-model", session_id: "s-1", cwd: ws });
for (const a of JSON.parse(process.env.FAKE_ACTIONS || "[]")) {
  const h = hooks.preToolUse[0];
  const r = spawnSync("bash", ["-c", h.command], { input: JSON.stringify({ hook_event_name: "preToolUse", tool_name: a.tool, tool_input: a.input, cwd: ws, workspace_roots: [ws] }), encoding: "utf8" });
  const allowed = r.status === 0 && JSON.parse(r.stdout).permission === "allow";
  out({ type: "tool_call", subtype: "started", call_id: "c", tool_call: { writeToolCall: { args: { path: a.input.path } } } });
  if (allowed && a.tool === "Write") fs.writeFileSync(path.resolve(ws, a.input.path), a.input.content);
}
out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ara mesaj" }] }, session_id: "s-1" });
out({ type: "result", subtype: "success", is_error: false, result: "bitti\\nVERDICT: PASS", session_id: "s-1", duration_ms: 5 });
`;

test("CursorAgentRunner: hook'larla yetki zorlanır, çıktı okunur, geçici dosyalar temizlenir", async () => {
  const { base, wt, run } = sandbox();
  const bin = path.join(base, "fake-cursor");
  fs.writeFileSync(bin, FAKE_CURSOR, { mode: 0o755 });
  process.env.FAKE_ACTIONS = JSON.stringify([
    { tool: "Write", input: { path: "src/b.ts", content: "export const b = 2;\n" } },
    { tool: "Write", input: { path: "package.json", content: "{}" } },
  ]);
  const runner = new CursorAgentRunner({ bin, model: "", timeoutMin: 1, extraArgs: [] });
  const ctx = ctxFor(wt, run);
  const res = await runner.run({
    role: "committer", persona: "p", prompt: "görev", cwd: wt, runRoot: run, perms: devPerms, policy: ctx.policy,
    budgetUsd: 1, isolation: true, claudeMd: false, log: silentLogger(),
  });
  delete process.env.FAKE_ACTIONS;
  assert.equal(res.ok, true, res.error);
  assert.equal(res.text, "bitti\nVERDICT: PASS");
  assert.equal(res.sessionId, "s-1");
  assert.deepEqual(res.models, ["cursor:fake-model"]);
  assert.equal(res.costUsd, 0);
  assert.ok(fs.existsSync(path.join(wt, "src/b.ts")), "izinli yazma yapıldı");
  assert.ok(!fs.existsSync(path.join(wt, "package.json")), "izinsiz yazma engellendi");
  assert.equal(res.denials.length, 1);
  assert.match(res.denials[0].reason, /yazamaz/);
  assert.ok(!fs.existsSync(path.join(wt, ".cursor")), "geçici .cursor klasörü silindi");
  const args = JSON.parse(fs.readFileSync(path.join(base, "args.json"), "utf8")) as string[];
  assert.ok(args.includes("-p") && args.includes("--trust") && args.includes("stream-json"));
  assert.ok(args.at(-1)!.includes(CURSOR_CO_AUTHOR), "committer'a Co-Authored-By satırı istenir");
});

test("CursorAgentRunner: projenin kendi .cursor/hooks.json dosyası geri yüklenir", async () => {
  const { base, wt, run } = sandbox();
  fs.mkdirSync(path.join(wt, ".cursor/rules"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".cursor/hooks.json"), '{"version":1,"hooks":{}}');
  const bin = path.join(base, "fake-cursor");
  fs.writeFileSync(bin, FAKE_CURSOR, { mode: 0o755 });
  const res = await new CursorAgentRunner({ bin, timeoutMin: 1, extraArgs: [] }).run({
    role: "developer", persona: "p", prompt: "x", cwd: wt, runRoot: run, perms: devPerms, policy: ctxFor(wt, run).policy,
    budgetUsd: 1, isolation: true, claudeMd: false, log: silentLogger(),
  });
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(path.join(wt, ".cursor/hooks.json"), "utf8"), '{"version":1,"hooks":{}}');
  assert.ok(!fs.existsSync(path.join(wt, ".cursor/cli.json")));
  assert.ok(fs.existsSync(path.join(wt, ".cursor/rules")));
});

test("CursorAgentRunner: hook'lar çalışmazsa sonuç kabul edilmez", async () => {
  const { base, wt, run } = sandbox();
  const bin = path.join(base, "no-hook-cursor");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const o = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
o({ type: "tool_call", subtype: "started", tool_call: { shellToolCall: { args: { command: "rm -rf src" } } } });
o({ type: "result", subtype: "success", is_error: false, result: "VERDICT: PASS", session_id: "s" });
`, { mode: 0o755 });
  const res = await new CursorAgentRunner({ bin, timeoutMin: 1, extraArgs: [] }).run({
    role: "reviewer", persona: "p", prompt: "x", cwd: wt, runRoot: run, perms: devPerms, policy: ctxFor(wt, run).policy,
    budgetUsd: 1, isolation: true, claudeMd: false, log: silentLogger(),
  });
  assert.equal(res.ok, false);
  assert.match(res.error!, /hook'ları çalışmadı/);
});

test("CursorAgentRunner: Cursor bulunamazsa anlaşılır hata", async () => {
  const { wt, run } = sandbox();
  const res = await new CursorAgentRunner({ bin: "/yok/cursor-agent", timeoutMin: 1, extraArgs: [] }).run({
    role: "developer", persona: "p", prompt: "x", cwd: wt, runRoot: run, perms: devPerms, policy: ctxFor(wt, run).policy,
    budgetUsd: 1, isolation: true, claudeMd: false, log: silentLogger(),
  });
  assert.equal(res.ok, false);
  assert.match(res.error!, /çıkış kodu 127/);
});

test("Claude erişimi tespiti", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kgflow-ch-"));
  assert.equal(claudeAvailable(home, {}), false);
  assert.equal(claudeAvailable(home, { ANTHROPIC_API_KEY: "x" }), true);
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ projects: {} }));
  assert.equal(claudeAvailable(home, {}), false, "giriş yapılmamış ~/.claude.json yetmez");
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@b" } }));
  assert.equal(claudeAvailable(home, {}), true);
});
