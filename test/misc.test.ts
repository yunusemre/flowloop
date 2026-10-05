import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLessons, parseVerdict } from "../src/verdict.js";
import { render } from "../src/roles.js";

test("verdict: son satır", () => {
  assert.equal(parseVerdict("iyi\nVERDICT: PASS").verdict, "PASS");
  assert.equal(parseVerdict("sorun var\n**VERDICT: FAIL**\n").verdict, "FAIL");
  assert.equal(parseVerdict("sorun var\nVERDICT: FAIL").feedback, "sorun var");
  const none = parseVerdict("VERDICT: PASS\nama bir şey daha");
  assert.equal(none.verdict, "FAIL");
  assert.equal(none.explicit, false);
});

test("dersler: ❌ ve hayatta kalan mutantlar", () => {
  const l = extractLessons("✅ testler yeşil\n❌ AK-3 yuvarlama testi yok\n| AK-3 | yuvarla silindi | HAYATTA KALDI |\n");
  assert.equal(l.length, 2);
});

test("şablon blokları", () => {
  const t = "a {{x}}\n{{#y}}Y={{y}}\n{{/y}}{{#z}}Z\n{{/z}}son";
  assert.equal(render(t, { x: "1", y: "2", z: "" }), "a 1\nY=2\nson");
});

import { slugify } from "../src/orchestrator.js";
import { isTemplateText } from "../src/jira.js";
test("slug kelime ortasından kesilmez", () => {
  const sl = slugify("Haritada task içerisinde birden fazla gönderi olduğu zaman haritada birisi teslim edildiğinde");
  assert.equal(sl, "haritada-task-icerisinde-birden-fazla-gonderi");
  assert.ok(sl.length <= 50);
});
test("Jira şablon metni kabul kriteri sayılmaz", () => {
  assert.equal(isTemplateText("User Story'nin kabul kriterlerini ve test senaryolarını buraya yazabilirsin (Acceptance Criteria)"), true);
  assert.equal(isTemplateText("1. Pin, tüm gönderiler teslim edilince yeşil olur"), false);
});

test("eski .kgflow ve .ekip klasörleri .flowloop'a taşınır", async () => {
  const { migrateLegacyProject } = await import("../src/config.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  for (const n of ["kgflow", "ekip"]) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-mig-"));
    fs.mkdirSync(path.join(d, `.${n}/tasks`), { recursive: true });
    fs.writeFileSync(path.join(d, `.${n}/${n}.yaml`), "version: 2\n");
    fs.writeFileSync(path.join(d, `.${n}/lessons.md`), "# dersler\n");
    assert.equal(migrateLegacyProject(d), n);
    assert.ok(fs.existsSync(path.join(d, ".flowloop/flowloop.yaml")));
    assert.ok(fs.existsSync(path.join(d, ".flowloop/lessons.md")));
    assert.ok(!fs.existsSync(path.join(d, `.${n}`)));
    assert.equal(migrateLegacyProject(d), undefined);
  }
});

test("eski adla saklanmış gizli bilgi okunur ve yeni yere taşınır", async () => {
  const { FileStore, getCredential } = await import("../src/secrets.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-leg-"));
  const oldS = new FileStore(path.join(d, "old.json"));
  const newS = new FileStore(path.join(d, "new.json"));
  oldS.set("JIRA_API_TOKEN", "eski");
  assert.equal(getCredential("JIRA_API_TOKEN", newS, {}, oldS), "eski");
  assert.equal(newS.get("JIRA_API_TOKEN"), "eski", "yeni yere taşındı");
});

test(".gitignore: yoksa oluşturur, varsa ekler, eski .ekip satırını günceller, tekrar eklemez", async () => {
  const { ensureGitignore } = await import("../src/config.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-gi-"));
  const gi = path.join(d, ".gitignore");
  assert.equal(ensureGitignore(d), "created");
  assert.match(fs.readFileSync(gi, "utf8"), /^\.flowloop\/$/m);
  assert.equal(ensureGitignore(d), "exists");
  fs.writeFileSync(gi, "node_modules/\ndist");
  assert.equal(ensureGitignore(d), "added");
  assert.equal(fs.readFileSync(gi, "utf8"), "node_modules/\ndist\n\n# flowloop (AI geliştirme akışı) yerel dosyaları\n.flowloop/\n");
  fs.writeFileSync(gi, "node_modules/\n.ekip\n.env\n");
  assert.equal(ensureGitignore(d), "renamed");
  assert.equal(fs.readFileSync(gi, "utf8"), "node_modules/\n.flowloop/\n.env\n");
  fs.writeFileSync(gi, "/.flowloop\n");
  assert.equal(ensureGitignore(d), "exists");
});

test("Jira adresi: yazım biçimleri ve kayıt bağlantısı ayrıştırılır", async () => {
  const { normalizeJiraBase, parseJiraLink } = await import("../src/config.js");
  assert.equal(normalizeJiraBase("sirket"), "https://sirket.atlassian.net");
  assert.equal(normalizeJiraBase("sirket.atlassian.net/"), "https://sirket.atlassian.net");
  assert.equal(normalizeJiraBase("https://sirket.atlassian.net/browse/PROJ-1"), "https://sirket.atlassian.net");
  assert.equal(normalizeJiraBase("https://jira.sirket.com.tr"), "https://jira.sirket.com.tr");
  assert.equal(normalizeJiraBase("bu bir adres değil!"), "");
  assert.deepEqual(parseJiraLink("https://sirket.atlassian.net/browse/PROJ-1234"), { base: "https://sirket.atlassian.net", key: "PROJ-1234" });
  assert.deepEqual(parseJiraLink("https://sirket.atlassian.net/jira/software/projects/PROJ/boards/1?selectedIssue=PROJ-7"), { base: "https://sirket.atlassian.net", key: "PROJ-7" });
  assert.equal(parseJiraLink("PROJ-1"), undefined);
});

test("Jira adresi önceliği: flowloop.yaml → JIRA_BASE_URL → flowloop setup ayarı", async () => {
  const { jiraBaseUrl, writeUserConfig } = await import("../src/config.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-uc-"));
  const saved = process.env.JIRA_BASE_URL;
  delete process.env.JIRA_BASE_URL;
  try {
    assert.equal(jiraBaseUrl({ jira: { baseUrl: "" } }, home), "", "hiçbiri yoksa boş: kodda sabit adres yok");
    writeUserConfig({ jiraBaseUrl: "https://a.atlassian.net" }, home);
    assert.equal(jiraBaseUrl({ jira: { baseUrl: "" } }, home), "https://a.atlassian.net");
    process.env.JIRA_BASE_URL = "https://b.atlassian.net";
    assert.equal(jiraBaseUrl({ jira: { baseUrl: "" } }, home), "https://b.atlassian.net");
    assert.equal(jiraBaseUrl({ jira: { baseUrl: "https://c.atlassian.net/" } }, home), "https://c.atlassian.net");
  } finally {
    if (saved === undefined) delete process.env.JIRA_BASE_URL;
    else process.env.JIRA_BASE_URL = saved;
  }
});
