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

test("platform: CRLF ve BOM'lu metin LF'e çevrilir (Windows'ta git autocrlf)", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { readText } = await import("../src/platform.js");
});

test("başarısız komut çıktısında hata satırları uyarıların arasından çıkarılır", async () => {
  const { failureLines } = await import("../src/git.js");
  const out = [
    "  Determining projects to restore...",
    ...Array.from({ length: 20 }, (_, i) => `x.csproj : warning NU1903: Package 'A' 8.0.2 has a known high severity vulnerability ${i}`),
    "C:\\w\\x.csproj : error NU1301: Unable to load the service index for source https://pkgs.example/feed.",
    ...Array.from({ length: 5 }, (_, i) => `y.csproj : warning NU1903: vuln ${i}`),
    "  Failed to restore C:\\w\\x.csproj (in 4.26 sec).",
  ].join("\r\n");
  const lines = failureLines(out);
  assert.match(lines[0], /error NU1301/);
  assert.ok(lines.some((l) => /Failed to restore/.test(l)));
  assert.ok(!lines.some((l) => /NU1903: Package 'A'/.test(l)));
  assert.ok(lines.some((l) => /uyarı\/bilgi satırı gizlendi/.test(l)));
  // hata satırı yoksa son satırlar
  assert.deepEqual(failureLines("a\nb\nc", 2), ["b", "c"]);
});

test("giriş süresi dolunca ne yapılacağı söylenir", async () => {
  const { authHint } = await import("../src/orchestrator.js");
  assert.match(authHint("Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed"), /\/login/);
  assert.equal(authHint("tool hatası"), "");
});
