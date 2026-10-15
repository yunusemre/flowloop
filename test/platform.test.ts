import { test } from "node:test";
import assert from "node:assert/strict";
import { bashPath, dirLinkType, gitBashCandidates, nativePath, openerCommand, pickWhere, shellCommand, slashPath } from "../src/platform.js";
import { DpapiStore } from "../src/secrets.js";

// Not: Windows yolları burada platform parametresiyle sınanır; gerçek Windows'ta çalıştırılmadı.

test("platform: kabuk komutu", () => {
  assert.deepEqual(shellCommand("npm test", "linux"), ["bash", ["-lc", "npm test"]]);
  assert.deepEqual(shellCommand("npm test", "darwin"), ["bash", ["-lc", "npm test"]]);
  assert.equal(bashPath("darwin"), "bash");
});

test("platform: Git Bash adayları git.exe'nin yerinden bulunur", () => {
  const c = gitBashCandidates({ ProgramFiles: "C:\\Program Files" }, "C:\\Tools\\Git\\cmd\\git.exe");
  assert.ok(c.includes("C:\\Tools\\Git\\bin\\bash.exe"));
  assert.ok(c.includes("C:\\Program Files\\Git\\bin\\bash.exe"));
  const own = gitBashCandidates({ FLOWLOOP_BASH: "D:\\git\\bin\\bash.exe" });
  assert.equal(own[0], "D:\\git\\bin\\bash.exe");
});

test("platform: Git Bash yolu Windows yoluna çevrilir", () => {
  assert.equal(nativePath("/c/Users/ali/proj/src/a.ts", "win32"), "C:/Users/ali/proj/src/a.ts");
  assert.equal(nativePath("/d", "win32"), "D:/");
  assert.equal(nativePath("/cygdrive/e/x", "win32"), "E:/x");
  assert.equal(nativePath("src/a.ts", "win32"), "src/a.ts");
  assert.equal(nativePath("/tmp/x", "win32"), "/tmp/x");
  // diğer sistemlerde dokunulmaz
  assert.equal(nativePath("/c/Users", "linux"), "/c/Users");
});

test("platform: bağlantı türü, açıcı, where seçimi, bölüler", () => {
  assert.equal(dirLinkType("win32"), "junction");
  assert.equal(dirLinkType("darwin"), "dir");
  assert.deepEqual(openerCommand("https://x/a?b=1&c=2", "win32"), ["cmd", ["/c", "start", '""', "https://x/a?b=1^&c=2"]]);
  assert.deepEqual(openerCommand("https://x", "darwin"), ["open", ["https://x"]]);
  assert.deepEqual(openerCommand("https://x", "linux"), ["xdg-open", ["https://x"]]);
  assert.equal(pickWhere("C:\\npm\\agent\r\nC:\\npm\\agent.cmd\r\n"), "C:\\npm\\agent.cmd");
  assert.equal(pickWhere("C:\\a\\git.cmd\r\nC:\\b\\git.exe\r\n"), "C:\\b\\git.exe");
  assert.equal(slashPath("C:\\Users\\ali\\run\\mutant"), "C:/Users/ali/run/mutant");
});

test("platform: DPAPI deposu PowerShell yokken hata verir, değer sızdırmaz", () => {
  const s = new DpapiStore("/nonexistent/flowloop-dpapi.json", "flowloop-olmayan-powershell");
  assert.equal(s.get("JIRA_API_TOKEN"), undefined); // dosya yok → çağrı yapılmaz
  assert.throws(() => s.set("JIRA_API_TOKEN", "gizli-deger"), (e: Error) => !e.message.includes("gizli-deger"));
});
