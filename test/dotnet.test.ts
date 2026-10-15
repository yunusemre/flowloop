import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fillFiles, unrunnableTestProjects } from "../src/git.js";
import { pickSolution } from "../src/tech.js";

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-dotnet-"));
  for (const [k, v] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, k)), { recursive: true });
    fs.writeFileSync(path.join(root, k), v);
  }
  return root;
}
const SDK = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>';
const CLASSIC = '<Project ToolsVersion="15.0"><PropertyGroup><TargetFrameworkVersion>v4.8</TargetFrameworkVersion></PropertyGroup></Project>';

test("{{testProject}}: her test projesi için ayrı komut, filtre o projenin test sınıflarından", () => {
  const root = repo({
    "A.Tests/A.Tests.csproj": SDK,
    "A.Tests/Geo/GeocodeTests.cs": "",
    "A.Tests/RouteTests.cs": "",
    "B.Tests/B.Tests.csproj": SDK,
    "B.Tests/SmsTests.cs": "",
    "A/Geo.cs": "",
  });
  const cmd = 'dotnet test {{testProject}} --no-restore --filter "{{testFilter}}"';
  const out = fillFiles(cmd, ["A/Geo.cs", "A.Tests/Geo/GeocodeTests.cs", "A.Tests/RouteTests.cs", "B.Tests/SmsTests.cs"], root);
  assert.equal(
    out,
    `dotnet test 'A.Tests/A.Tests.csproj' --no-restore --filter "FullyQualifiedName~GeocodeTests|FullyQualifiedName~RouteTests" && dotnet test 'B.Tests/B.Tests.csproj' --no-restore --filter "FullyQualifiedName~SmsTests"`,
  );
  assert.equal(fillFiles(cmd, ["A/Geo.cs"], root), "", "test dosyası yoksa komut boş");
  assert.equal(fillFiles("x {{testProjects}}", ["A.Tests/RouteTests.cs", "B.Tests/SmsTests.cs"], root), "x 'A.Tests/A.Tests.csproj' 'B.Tests/B.Tests.csproj'");
});

test(".NET Framework test projeleri Windows dışında çalıştırılmaz ve ayrıca bildirilir", () => {
  const root = repo({ "Old.Test/Old.Test.csproj": CLASSIC, "Old.Test/OldTests.cs": "", "New.Tests/New.Tests.csproj": SDK, "New.Tests/NewTests.cs": "" });
  const files = ["Old.Test/OldTests.cs", "New.Tests/NewTests.cs"];
  if (process.platform !== "win32") {
    assert.equal(fillFiles("dotnet test {{testProject}}", files, root), "dotnet test 'New.Tests/New.Tests.csproj'");
    assert.deepEqual(unrunnableTestProjects(files, root), ["Old.Test/Old.Test.csproj"]);
  }
  assert.deepEqual(unrunnableTestProjects(files, root, "win32"), []);
});

test("birden fazla solution: .NET Framework içermeyen, CI'da geçen ve en çok projeli seçilir", () => {
  const root = repo({
    "Old.sln": '"Old\\Old.csproj"\n"Old2\\Old2.csproj"\n"Old3\\Old3.csproj"',
    "New.sln": '"New\\New.csproj"\n"New2\\New2.csproj"',
    "bitbucket-pipelines.yml": "- dotnet build New.sln",
  });
  const r = pickSolution(root, ["New.sln", "Old.sln"], new Set(["Old/Old.csproj"]));
  assert.equal(r.sln, "New.sln");
  assert.match(r.notes[0], /komutlar New\.sln ile çalışır.*Old\.sln \(3 proje, 1 \.NET Framework\)/);
  assert.deepEqual(pickSolution(root, ["Tek.sln"], new Set()), { sln: "Tek.sln", notes: [] });
});

test("tip kontrolü sadece hataları sayar; NuGet uyarıları ve 'Error occurred' metni bloklamaz", async () => {
  const { ScopedChecks } = await import("../src/checks.js");
  const base = "x.cs(1,1): error CS0103: eski hata\nA.csproj : warning NU1900: Error occurred while getting package vulnerability data";
  const after = base + "\nB.csproj : warning NU1903: Package 'Snappier' has a known high severity vulnerability\n    0 Error(s)\ny.cs(5,9): error CS0246: yeni hata";
  const runner = { run: (_c: string, cwd: string) => ({ code: 1, stdout: cwd === "/wt" ? after : base, stderr: "" }) };
  const c = new ScopedChecks({ commands: { typecheck: "dotnet build" } } as any, "/wt", "/base", runner);
  const r = c.typecheck(["y.cs"]);
  assert.equal(r.status, "fail");
  assert.equal(r.summary, "1 YENİ tip hatası");
  assert.match(r.details!, /CS0246/);
});

test("Docker kapalıysa testler ortam hatası olarak raporlanır (developer'a gitmez)", async () => {
  const { ScopedChecks, envFailure } = await import("../src/checks.js");
  assert.match(envFailure("DotNet.Testcontainers.Builders.DockerUnavailableException : Failed to connect to Docker endpoint")!, /Docker çalışmıyor/);
  assert.equal(envFailure("Assert.Equal() Failure"), undefined);
  const runner = { run: () => ({ code: 1, stdout: "Failed X [1 ms]\nFailed to connect to Docker endpoint at 'unix:///var/run/docker.sock'.", stderr: "" }) };
  const c = new ScopedChecks({ commands: { testRelated: "dotnet test {{testFiles}}" } } as any, "/wt", "/base", runner);
  const r = c.tests(["T/XTests.cs"], []);
  assert.equal(r.status, "fail");
  assert.match(r.env!, /Docker/);
});

test("mutant kopyası: kurulum bir kez çalışır, çıktısı korunur; mutasyon ve silinen dosyalar her reset'te temizlenir", async () => {
  const { MutantSandbox } = await import("../src/mutant.js");
  const { gitOk } = await import("../src/git.js");
  const root = repo({ "a.cs": "A", "b.cs": "B" });
  gitOk(["init", "-q"], root);
  gitOk(["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], root);
  gitOk(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i"], root);
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mut-")), "m");
  const sb = new MutantSandbox(root, dir, () => "true", [], 60, "mkdir -p obj && echo x >> obj/restore.log");
  sb.reset();
  fs.writeFileSync(path.join(dir, "a.cs"), "MUTANT");
  fs.rmSync(path.join(root, "b.cs"));
  sb.reset();
  assert.equal(fs.readFileSync(path.join(dir, "a.cs"), "utf8"), "A", "mutasyon geri alındı");
  assert.equal(fs.existsSync(path.join(dir, "b.cs")), false, "silinen dosya kopyadan da silindi");
  assert.equal(fs.readFileSync(path.join(dir, "obj/restore.log"), "utf8"), "x\n", "kurulum bir kez çalıştı, çıktısı korundu");
});

test("{{files:cs,csproj}} sadece o uzantıları verir; eşleşen yoksa format atlanır", async () => {
  const { ScopedChecks } = await import("../src/checks.js");
  assert.equal(fillFiles("x {{files:cs,csproj}}", ["a.cs", "b.json", "c/D.CSPROJ"], "/"), "x 'a.cs' 'c/D.CSPROJ'");
  const runs: string[] = [];
  const c = new ScopedChecks({ commands: { format: "dotnet csharpier format {{files:cs}}" } } as any, "/wt", "/base", { run: (cmd: string) => (runs.push(cmd), { code: 0, stdout: "", stderr: "" }) });
  assert.equal(c.format(["appsettings.json"]).status, "skip");
  assert.equal(runs.length, 0);
  assert.equal(c.format(["a.cs"]).status, "ok");
  assert.deepEqual(runs, ["dotnet csharpier format 'a.cs'"]);
});

test("kontrol komutları HUSKY=0 ile çalışır (kopyalarda git hook'u kurulmaz)", async () => {
  const { runConfigured } = await import("../src/git.js");
  assert.equal(runConfigured('printf %s "$HUSKY"', os.tmpdir()).stdout, "0");
});

test("CSharpier uzantıları commit hook'unun (Husky.Net) include listesinden gelir; .csproj hook'ta yoksa formatlanmaz", async () => {
  const { csharpierExtensions } = await import("../src/tech.js");
  const runner = `{
    "tasks": [
      { "name": "commit-message", "group": "commit-msg", "command": "dotnet", "args": ["husky", "exec", "x.csx"] },
      { "name": "Run csharpier", "group": "pre-commit", "command": "dotnet", "args": [ "csharpier", "format", "\${staged}" ],
        "include": [ "**/*.cs", "**/*.csx", "**/*.json", "**/*.slnx", "**/*.xml", "**/*.xaml" ] }
      // .NET Core geçişi sonrası
      //{ "name": "format code" }
    ]
  }`;
  assert.deepEqual(csharpierExtensions(runner), ["cs", "csx", "slnx", "xml", "xaml"]);
  assert.deepEqual(csharpierExtensions(""), ["cs", "csx"]);
});
