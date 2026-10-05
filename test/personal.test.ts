import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configSchema } from "../src/config.js";
import { DEFAULT_FORBIDDEN_FLAGS, evaluate, rewriteAliasPaths, type PolicyContext } from "../src/policy.js";
import { permissionsFor } from "../src/roles.js";
import { detectMemoryServers, loadMcpServers } from "../src/usermcp.js";
import { fakeHome } from "./helpers.js";

test("~/.claude.json'dan MCP sunucuları; hafıza sunucusu tespiti", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-repo-"));
  const home = fakeHome(repo);
  assert.deepEqual(detectMemoryServers(repo, home), ["kgs-app-memory"]);
  const { servers, missing } = loadMcpServers(["kgs-app-memory", "yok"], repo, home);
  assert.deepEqual(Object.keys(servers), ["kgs-app-memory"]);
  assert.deepEqual(missing, ["yok"]);
  assert.deepEqual(Object.keys(loadMcpServers(["auto"], repo, home).servers), ["kgs-app-memory"]);
});

const cfg = configSchema.parse({
  version: 2,
  commands: { testRelated: "npx jest --findRelatedTests {{files}}" },
  paths: { edit: ["src/**"] },
  mcp: { servers: ["kgs-app-memory"] },
});

test("hafıza araçları: sadece salt okuma ve sadece seçili roller", () => {
  const ctx: PolicyContext = { repoRoot: "/w/wt", runRoot: "/w/run", readDeny: [], forbiddenFlags: DEFAULT_FORBIDDEN_FLAGS };
  for (const r of ["analist", "developer", "reviewer"] as const) {
    assert.equal(evaluate(permissionsFor(r, cfg), ctx, "mcp__kgs-app-memory__search_similar", { query: "UIFlatList" }).allow, true);
    assert.equal(evaluate(permissionsFor(r, cfg), ctx, "mcp__kgs-app-memory__create_entities", {}).allow, false);
    assert.equal(evaluate(permissionsFor(r, cfg), ctx, "mcp__kgs-app-memory__delete_entities", {}).allow, false);
  }
  assert.equal(evaluate(permissionsFor("committer", cfg), ctx, "mcp__kgs-app-memory__search_similar", {}).allow, false);
});

test("hafızanın döndürdüğü asıl repo yolları çalışma kopyasına çevrilir", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-alias-"));
  const repo = path.join(base, "kgs-app");
  const wt = path.join(base, "wt");
  for (const d of [repo, wt]) fs.mkdirSync(path.join(d, "src"), { recursive: true });
  fs.writeFileSync(path.join(wt, "src", "a.ts"), "x");
  const ctx: PolicyContext = { repoRoot: wt, runRoot: path.join(base, "run"), readDeny: [], forbiddenFlags: {}, aliasRoot: repo };
  assert.deepEqual(rewriteAliasPaths(ctx, { file_path: path.join(repo, "src", "a.ts") }), { file_path: path.join(wt, "src", "a.ts") });
  assert.deepEqual(rewriteAliasPaths(ctx, { pattern: "x", path: repo }), { pattern: "x", path: wt });
  assert.equal(rewriteAliasPaths(ctx, { file_path: path.join(wt, "src", "a.ts") }), undefined);
  // çevrilmeden önce asıl repo yolu reddedilir (asıl repoya erişim yok)
  assert.equal(evaluate(permissionsFor("developer", cfg), ctx, "Edit", { file_path: path.join(repo, "src", "a.ts") }).allow, false);
  const fixed = rewriteAliasPaths(ctx, { file_path: path.join(repo, "src", "a.ts") })!;
  assert.equal(evaluate(permissionsFor("developer", cfg), ctx, "Edit", fixed).allow, true);
});

