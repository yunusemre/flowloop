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

test("init: .NET projesinde düzenlenebilir yol bütün repo; boş edit anlaşılır hata verir", async () => {
  const { detectProject } = await import("../src/tech.js");
  const { loadConfig } = await import("../src/config.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-net-"));
  for (const f of ["AyJob/AyJob.csproj", "AyJob/Program.cs", "AyJob.Tests/AyJob.Tests.csproj", "docs/readme.md"]) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), f.endsWith(".csproj") ? "<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>" : "x");
  }
  fs.writeFileSync(path.join(d, "AyJob.sln"), "");
  execFileSync("git", ["init", "-q"], { cwd: d });
  execFileSync("git", ["add", "-A"], { cwd: d });
  assert.deepEqual(detectProject(d).edit, ["**"], "varsayılan: bütün repo");

  fs.mkdirSync(path.join(d, ".flowloop"));
  fs.writeFileSync(path.join(d, ".flowloop/flowloop.yaml"), 'version: 2\ncommands:\n  testRelated: "dotnet test {{testFiles}}"\npaths:\n  edit:\n');
  assert.throws(() => loadConfig(d), /paths\.edit: boş olamaz[\s\S]*src\/\*\*/);
});


test("çalışma ağacı hash'i aynı saniyede aynı boyutta değişen dosyayı da görür (racy git)", async () => {
  const { workingTreeHash } = await import("../src/git.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-racy-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d });
  fs.writeFileSync(path.join(d, "a.js"), "export const LIMIT = 10;\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  for (let i = 0; i < 5; i++) {
    const v = i % 2 ? "10" : "20";
    const before = workingTreeHash(d);
    fs.writeFileSync(path.join(d, "a.js"), `export const LIMIT = ${v};\n`); // aynı boyut, aynı saniye
    const after = workingTreeHash(d);
    assert.notEqual(after, before, `değişiklik görülmeli (tur ${i})`);
  }
});

test("şablon: ters blok ve iç içe bloklar", () => {
  const t = "{{#a}}A{{#b}}+B{{/b}}{{/a}}{{^a}}yok-a{{/a}}|{{^c}}yok-c{{/c}}";
  assert.equal(render(t, { a: true, b: true }), "A+B|yok-c");
  assert.equal(render(t, { a: false, c: "x" }), "yok-a|");
});

test("sınırlar ajana söylenir: bütçe ve tur", async () => {
  const { limitsNote } = await import("../src/orchestrator.js");
  const d = limitsNote("developer", 2.5, 3, 3);
  assert.match(d, /bütçen: \$2\.50/);
  assert.match(d, /Tur 3\/3\. Son tur/);
  assert.doesNotMatch(limitsNote("analist", 1, undefined, 3), /Tur/);
  assert.doesNotMatch(limitsNote("developer", 1, 1, 3, "cursor"), /bütçe/, "Cursor maliyet bildirmez");
});

test("commit hook yardımcıları (.husky/_) worktree'ye kopyalanır, asıl repoda yoksa boş yardımcı yazılır", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { ensureHookHelpers } = await import("../src/git.js");
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "fl-husky-"));
  const main = mk();
  const wt = mk();
  for (const d of [main, wt]) {
    fs.mkdirSync(path.join(d, ".husky"), { recursive: true });
    fs.writeFileSync(path.join(d, ".husky", "pre-commit"), '#!/bin/sh\n. "$(dirname "$0")/_/husky.sh"\ndotnet husky run\n');
  }
  fs.mkdirSync(path.join(main, ".husky", "_"));
  fs.writeFileSync(path.join(main, ".husky", "_", "husky.sh"), "# asıl\n");
  assert.deepEqual(ensureHookHelpers(main, wt), [path.join(".husky", "_")]);
  assert.equal(fs.readFileSync(path.join(wt, ".husky", "_", "husky.sh"), "utf8"), "# asıl\n");
  assert.equal(fs.readFileSync(path.join(wt, ".husky", "_", ".gitignore"), "utf8"), "*\n");
  assert.deepEqual(ensureHookHelpers(main, wt), [], "varsa dokunulmaz");
  const wt2 = mk();
  fs.mkdirSync(path.join(wt2, ".husky"));
  fs.writeFileSync(path.join(wt2, ".husky", "pre-commit"), '. "$(dirname -- "$0")/_/husky.sh"\n');
  assert.equal(ensureHookHelpers(mk(), wt2).length, 1);
  assert.match(fs.readFileSync(path.join(wt2, ".husky", "_", "husky.sh"), "utf8"), /flowloop/);
  assert.deepEqual(ensureHookHelpers(main, mk()), [], ".husky yoksa bir şey yapılmaz");
});

test("ayar: lint/typecheck/format false ile kapatılır; init --force geri açmaz", async () => {
  const { configSchema } = await import("../src/config.js");
  const { mergeConfig } = await import("../src/configmerge.js");
  const c = configSchema.parse({ version: 2, commands: { testRelated: "x {{files}}", lint: false, typecheck: null }, paths: { edit: ["src/**"] } });
  assert.equal(c.commands.lint, "");
  assert.equal(c.commands.typecheck, "");
  assert.equal(c.commands.format, "");
  const merged = mergeConfig('version: 2\ncommands:\n  testRelated: "x {{files}}"\n  lint: "dotnet format style"\n', "version: 2\ncommands:\n  lint: false\n").text;
  assert.match(merged, /lint: false/);
});
