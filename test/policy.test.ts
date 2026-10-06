import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_FORBIDDEN_FLAGS, evaluate, type PolicyContext } from "../src/policy.js";
import { permissionsFor } from "../src/roles.js";
import { configSchema } from "../src/config.js";

let ctx: PolicyContext;
const cfg = configSchema.parse({
  version: 2,
  commands: {
    testRelated: "npx jest --findRelatedTests {{files}} --passWithNoTests",
    typecheck: "npx tsc --noEmit -p .",
    lint: "npx eslint {{files}}",
    format: "npx prettier --write {{files}}",
  },
  paths: { edit: ["src/**", "test/**"], readDeny: [".env", "**/*.pem"] },
});
const P = (r: "analist" | "developer" | "reviewer" | "committer") => permissionsFor(r, cfg);

before(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-pol-"));
  const repo = path.join(base, "wt");
  const run = path.join(base, "run");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(run);
  fs.writeFileSync(path.join(repo, "src", "a.js"), "x");
  fs.writeFileSync(path.join(repo, ".env"), "SECRET=1");
  fs.symlinkSync(path.join(repo, ".env"), path.join(repo, "src", "link.js"));
  fs.symlinkSync("/etc", path.join(repo, "src", "etc"));
  ctx = { repoRoot: repo, runRoot: run, readDeny: cfg.paths.readDeny, forbiddenFlags: DEFAULT_FORBIDDEN_FLAGS };
});

const allow = (r: Parameters<typeof P>[0], tool: string, input: Record<string, unknown>) =>
  assert.equal(evaluate(P(r), ctx, tool, input).allow, true, `${r} ${tool} ${JSON.stringify(input)} izinli olmalıydı`);
const deny = (r: Parameters<typeof P>[0], tool: string, input: Record<string, unknown>) =>
  assert.equal(evaluate(P(r), ctx, tool, input).allow, false, `${r} ${tool} ${JSON.stringify(input)} reddedilmeliydi`);

test("analist: okur, sadece plan.md yazar", () => {
  allow("analist", "Read", { file_path: path.join(ctx.repoRoot, "src/a.js") });
  allow("analist", "Write", { file_path: path.join(ctx.runRoot, "plan.md") });
  deny("analist", "Write", { file_path: path.join(ctx.runRoot, "baska.md") });
  deny("analist", "Edit", { file_path: path.join(ctx.repoRoot, "src/a.js") });
  deny("analist", "Bash", { command: "ls" });
});

test("developer: sadece edit yolları, commit yok", () => {
  allow("developer", "Edit", { file_path: path.join(ctx.repoRoot, "src/a.js") });
  allow("developer", "Write", { file_path: "test/yeni.test.js" });
  deny("developer", "Edit", { file_path: path.join(ctx.repoRoot, "package.json") });
  deny("developer", "Edit", { file_path: path.join(ctx.repoRoot, ".git/config") });
  deny("developer", "Write", { file_path: path.join(ctx.repoRoot, "src/../../dışarı.js") });
  deny("developer", "Write", { file_path: path.join(ctx.repoRoot, "src/etc/passwd") });
  allow("developer", "Bash", { command: "npx jest --findRelatedTests src/a.ts" });
  deny("developer", "Bash", { command: "npx tsc --noEmit -p ." });
  allow("reviewer", "Bash", { command: "npx tsc --noEmit -p ." });
  allow("developer", "Bash", { command: "npx eslint src/a.ts" });
  allow("developer", "Bash", { command: "npx prettier --write src/a.ts" });
  deny("developer", "Bash", { command: "npx jest" });
  deny("developer", "Bash", { command: "npx jest --findRelatedTests -u src/a.ts" });
  deny("developer", "Bash", { command: "npx eslint --fix src/a.ts" });
  deny("developer", "Bash", { command: "git commit -m x" });
  deny("developer", "Bash", { command: "npm test && git commit -m x" });
  deny("developer", "Bash", { command: "node -e \"require('fs').writeFileSync('x','y')\"" });
  deny("developer", "WebFetch", { url: "https://example.com" });
  deny("developer", "Task", { prompt: "x" });
});

test("gizli dosyalar hiçbir rol tarafından okunamaz (symlink dahil)", () => {
  for (const r of ["analist", "developer", "reviewer", "committer"] as const) {
    deny(r, "Read", { file_path: path.join(ctx.repoRoot, ".env") });
    deny(r, "Read", { file_path: path.join(ctx.repoRoot, "src/link.js") });
    deny(r, "Read", { file_path: "/etc/passwd" });
  }
});

test("reviewer: gerçek dosyaya yazamaz, sadece mutant kopyaya", () => {
  allow("reviewer", "Edit", { file_path: path.join(ctx.runRoot, "mutant/src/a.js") });
  deny("reviewer", "Edit", { file_path: path.join(ctx.repoRoot, "src/a.js") });
  allow("reviewer", "mcp__flowloop__mutant_test", {});
  allow("reviewer", "Bash", { command: "git diff -- test/" });
  allow("reviewer", "Bash", { command: "npx jest --findRelatedTests src/a.ts" });
  deny("reviewer", "Bash", { command: "npx prettier --write src/a.ts" });
  deny("reviewer", "Bash", { command: "git diff --output=src/a.js" });
  deny("reviewer", "Bash", { command: "git commit -m x" });
});

test("committer: add/commit var, push/no-verify/amend yok, dosya yazamaz", () => {
  allow("committer", "Bash", { command: "git add src/a.js test/a.test.js" });
  allow("committer", "Bash", { command: `git commit -m "feat(x): y" -m "AK-1"` });
  deny("committer", "Bash", { command: "git commit --no-verify -m x" });
  deny("committer", "Bash", { command: "git commit --amend -m x" });
  deny("committer", "Bash", { command: "git push" });
  deny("committer", "Bash", { command: "git add -f .env" });
  deny("committer", "Edit", { file_path: path.join(ctx.repoRoot, "src/a.js") });
  deny("committer", "Bash", { command: "npx jest --findRelatedTests src/a.ts" });
});

test("arama araçları çalışma alanı dışına çıkamaz", () => {
  allow("developer", "Grep", { pattern: "x" });
  allow("developer", "Glob", { pattern: "**/*.js", path: path.join(ctx.repoRoot, "src") });
  deny("developer", "Grep", { pattern: "x", path: "/etc" });
  deny("developer", "Glob", { pattern: "*", path: os.homedir() });
});

test("edit \"**\" (bütün repo) olsa da gizli dosyalara, .git'e, .flowloop'a ve bağlı klasörlere yazılamaz", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-all-"));
  fs.mkdirSync(path.join(base, "wt"), { recursive: true });
  fs.mkdirSync(path.join(base, "run"), { recursive: true });
  const c = { repoRoot: path.join(base, "wt"), runRoot: path.join(base, "run"), readDeny: [".env", "node_modules", "node_modules/**"], forbiddenFlags: {} };
  const perms = { tools: ["Write"], read: ["**"], edit: ["**"], bash: [] };
  const W = (p: string) => evaluate(perms, c, "Write", { file_path: path.join(c.repoRoot, p) }).allow;
  assert.equal(W("src/a.ts"), true);
  assert.equal(W("package.json"), true);
  assert.equal(W(".env"), false);
  assert.equal(W(".git/config"), false);
  assert.equal(W(".flowloop/flowloop.yaml"), false);
  assert.equal(W("node_modules/x/index.js"), false);
  assert.equal(W("../dışarı.ts"), false);
});
