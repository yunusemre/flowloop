import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { mergeConfig } from "../src/configmerge.js";
import { configSchema } from "../src/config.js";
import { jiraBaseFromTask } from "../src/orchestrator.js";
import { renderConfig, type Detected } from "../src/tech.js";

const d: Detected = {
  stack: "react-native",
  tech: ["React Native 0.84"],
  commands: { install: "npm ci", testRelated: "npx jest --findRelatedTests {{files}}", typecheck: "npx tsc --noEmit -p .", lint: "", format: "", commitCheck: "" },
  linkDirs: ["node_modules"],
  edit: ["src/**"],
  readDeny: [".env"],
  notes: [],
};

test("init --force: kullanıcı ayarları korunur, teknoloji yeniden algılanır, yeni alanlar eklenir", () => {
  const old = `version: 2
stack: node
tech: |
  - eski
baseBranch: "main"
jira:
  baseUrl: "https://kolaygelsin.atlassian.net"
budgets: { analist: 2, gelistir: 8, commit: 0.5, total: 12 }
model: "sonnet"
commands:
  testRelated: "npx jest --findRelatedTests {{files}} --passWithNoTests"
paths:
  edit: ["src/**", "__mocks__/**"]
`;
  const fresh = renderConfig(d, "main", "{{jira}}-{{slug}}", ["codebase-memory-mcp"]);
  const { text, kept } = mergeConfig(fresh, old);
  const cfg = configSchema.parse(parse(text));
  assert.equal(cfg.jira.baseUrl, "https://kolaygelsin.atlassian.net");
  assert.equal(cfg.jira.comment, true, "yeni alan şablondan gelir");
  assert.equal(cfg.push, true);
  assert.equal(cfg.budgets.gelistir, 8);
  assert.equal(cfg.model, "sonnet");
  assert.deepEqual(cfg.paths.edit, ["src/**", "__mocks__/**"]);
  assert.equal(cfg.commands.testRelated, "npx jest --findRelatedTests {{files}} --passWithNoTests");
  assert.equal(cfg.commands.typecheck, "npx tsc --noEmit -p .", "eskide olmayan komut yeni tespitten gelir");
  assert.equal(cfg.stack, "react-native");
  assert.match(cfg.tech, /React Native 0\.84/);
  assert.deepEqual(cfg.mcp.servers, ["codebase-memory-mcp"]);
  assert.ok(kept.includes("jira.baseUrl"));
  assert.match(text, /# iş bitince Jira'ya kısa özet yorumu/, "şablon yorumları kalır");
});

test("Jira adresi görev dosyasından bulunur", () => {
  assert.equal(jiraBaseFromTask("# Görev: x\n\nJira: IDT-1\nKaynak: https://kolaygelsin.atlassian.net/browse/IDT-1 (çekildi: …)\n"), "https://kolaygelsin.atlassian.net");
  assert.equal(jiraBaseFromTask("# Görev"), "");
});
