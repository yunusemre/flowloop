import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PROJECT_DOCS } from "./config.js";
import { git } from "./git.js";

/**
 * Projenin teknolojilerini algılar ve ona uygun komutları önerir.
 * Amaç: her projede o projenin kendi araçlarıyla (test koşucusu, tip
 * kontrolü, linter, formatter) ve sadece bu işin dosyalarıyla çalışmak.
 */
export interface Detected {
  stack: string;
  tech: string[];
  commands: { install: string; testRelated: string; typecheck: string; lint: string; format: string; commitCheck: string };
  linkDirs: string[];
  edit: string[];
  readDeny: string[];
  notes: string[];
}

const COMMON_DENY = [".env", ".env.*", "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/*.keystore", "**/*.jks", "**/secrets/**"];

function readJson(file: string): Record<string, any> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const ver = (v: string | undefined) => (v ? v.replace(/^[\^~>=<\s]+/, "") : "");

function detectNode(root: string, pkg: Record<string, any>): Detected {
  const deps: Record<string, string> = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const has = (d: string) => d in deps;
  const file = (f: string) => fs.existsSync(path.join(root, f));
  const tech: string[] = [];
  const notes: string[] = [];
  const rn = has("react-native");
  const stack = rn ? "react-native" : has("next") ? "nextjs" : has("react") ? "react" : "node";

  if (rn) tech.push(`React Native ${ver(deps["react-native"])}${has("expo") ? ` · Expo SDK ${ver(deps.expo).split(".")[0]}` : ""}`);
  else if (has("next")) tech.push(`Next.js ${ver(deps.next)}`);
  else if (has("react")) tech.push(`React ${ver(deps.react)}`);
  if (has("@nestjs/core")) tech.push(`NestJS ${ver(deps["@nestjs/core"])}`);
  if (has("express")) tech.push(`Express ${ver(deps.express)}`);
  if (has("typescript")) tech.push(`TypeScript ${ver(deps.typescript)}${file("tsconfig.json") ? " (tsconfig.json)" : ""}`);

  // test koşucusu
  let testRelated = "";
  const testScript = String(pkg.scripts?.test ?? "");
  if (has("jest") || has("jest-expo") || /\bjest\b/.test(testScript)) {
    const extras = ["jest-expo", "ts-jest", "@testing-library/react-native", "@testing-library/react", "@testing-library/jest-native"].filter(has);
    tech.push(`Test: Jest ${ver(deps.jest ?? deps["jest-expo"])}${extras.length ? " · " + extras.map((e) => `${e} ${ver(deps[e])}`).join(", ") : ""}`);
    testRelated = "npx jest --findRelatedTests {{files}} --passWithNoTests";
  } else if (has("vitest")) {
    tech.push(`Test: Vitest ${ver(deps.vitest)}`);
    testRelated = "npx vitest related {{files}} --run --passWithNoTests";
  } else if (has("mocha")) {
    tech.push(`Test: Mocha ${ver(deps.mocha)}`);
    testRelated = "npx mocha {{testFiles}}";
  } else {
    tech.push("Test: node:test");
    testRelated = "node --test {{testFiles}}";
  }

  // diğer önemli kütüphaneler (rollerin doğru API'yi kullanması için)
  const notable: [string, string][] = [
    ["@shopify/flash-list", "Liste: FlashList"],
    ["@react-navigation/native", "Navigasyon: React Navigation"],
    ["expo-router", "Navigasyon: Expo Router"],
    ["@reduxjs/toolkit", "State: Redux Toolkit"],
    ["zustand", "State: Zustand"],
    ["@tanstack/react-query", "Veri: TanStack Query"],
    ["react-native-paper", "UI: React Native Paper"],
    ["react-native-reanimated", "Animasyon: Reanimated"],
    ["axios", "HTTP: axios"],
    ["zod", "Doğrulama: zod"],
  ];
  for (const [d, label] of notable) if (has(d)) tech.push(`${label} ${ver(deps[d])}`);

  const typecheck = has("typescript") && file("tsconfig.json") ? "npx tsc --noEmit -p ." : "";
  const lint = has("eslint") ? "npx eslint --quiet {{files}}" : "";
  if (has("eslint")) tech.push(`Lint: ESLint ${ver(deps.eslint)}`);
  const format = has("prettier") ? "npx prettier --write {{files}}" : "";
  if (has("prettier")) tech.push(`Format: Prettier ${ver(deps.prettier)}`);

  const commitCheck = has("@commitlint/cli") ? "npx commitlint --from {{base}} --to HEAD" : "";
  if (fs.existsSync(path.join(root, ".husky"))) notes.push("Husky hook'ları var: committer'ın commit'i sırasında çalışır. Hook dosya değiştirirse flowloop bunu yakalar ve durur.");

  const install = file("pnpm-lock.yaml") ? "pnpm install --frozen-lockfile" : file("yarn.lock") ? "yarn install --frozen-lockfile" : file("package-lock.json") ? "npm ci" : "npm install";
  const deny = rn ? ["google-services.json", "GoogleService-Info.plist", "**/*.p8", "android/app/*.keystore"] : [];
  return {
    stack,
    tech,
    commands: { install, testRelated, typecheck, lint, format, commitCheck },
    linkDirs: ["node_modules"],
    edit: ["**"],
    readDeny: [...COMMON_DENY, ...deny],
    notes,
  };
}

/**
 * Kökteki solution'lardan kurulum/derleme için kullanılacak olanı seçer:
 * .NET Framework projesi içermeyen (her işletim sisteminde derlenen) ve en çok proje içeren;
 * eşitlikte CI dosyalarında adı geçen.
 */
export function pickSolution(root: string, slns: string[], classic: Set<string>): { sln?: string; notes: string[] } {
  if (slns.length <= 1) return { sln: slns[0], notes: [] };
  const ci = ["bitbucket-pipelines.yml", "azure-pipelines.yml", ".gitlab-ci.yml", "Jenkinsfile"]
    .map((f) => path.join(root, f))
    .concat(fs.existsSync(path.join(root, ".github", "workflows")) ? fs.readdirSync(path.join(root, ".github", "workflows")).map((f) => path.join(root, ".github", "workflows", f)) : [])
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n");
  const info = slns.map((sln) => {
    const text = fs.readFileSync(path.join(root, sln), "utf8");
    const projs = [...text.matchAll(/"([^"]+\.(?:cs|fs|vb)proj)"/g)].map((m) => m[1].replace(/\\/g, "/"));
    return { sln, count: projs.length, classic: projs.filter((p) => classic.has(p)).length, ci: ci.split(sln).length - 1 };
  });
  info.sort((x, y) => (x.classic > 0 ? 1 : 0) - (y.classic > 0 ? 1 : 0) || y.ci - x.ci || y.count - x.count);
  const pick = info[0];
  const others = info.slice(1).map((i) => `${i.sln} (${i.count} proje${i.classic ? `, ${i.classic} .NET Framework` : ""})`);
  return {
    sln: pick.sln,
    notes: [`Birden fazla solution var; komutlar ${pick.sln} ile çalışır. Diğerleri: ${others.join(", ")}. Gerekirse commands altında değiştir.`],
  };
}

/**
 * CSharpier'ın formatlayacağı uzantılar: commit hook'u (Husky.Net task-runner.json) hangi dosyalara
 * uyguluyorsa sadece onlar; böylece flowloop hook'un dokunmadığı dosyaları (ör. eski biçim .csproj)
 * baştan biçimlendirip farkı şişirmez. Hook tanımı yoksa sadece C#.
 */
export function csharpierExtensions(taskRunner: string): string[] {
  const supported = ["cs", "csx", "xml", "xaml", "csproj", "props", "targets", "slnx", "config"];
  let includes: string[] = [];
  try {
    // task-runner.json yorum içerebilir
    const j = JSON.parse(taskRunner.replace(/^\s*\/\/.*$/gm, "")) as { tasks?: { args?: string[]; include?: string[] }[] };
    for (const t of j.tasks ?? []) if ((t.args ?? []).some((a) => /csharpier/i.test(a))) includes.push(...(t.include ?? []));
  } catch {
    includes = [...taskRunner.matchAll(/"\*\*\/\*\.([a-z0-9]+)"/gi)].map((m) => `**/*.${m[1]}`);
  }
  const exts = [...new Set(includes.map((g) => /\*\.([a-z0-9]+)$/i.exec(g)?.[1]?.toLowerCase()).filter((e): e is string => !!e && supported.includes(e)))];
  return exts.length ? exts : ["cs", "csx"];
}

function detectDotnet(root: string): Detected {
  const tech: string[] = [];
  const notes: string[] = [];
  const files = gitLsFiles(root);
  const csprojs = files.filter((f) => /\.(cs|fs|vb)proj$/.test(f));
  const frameworks = new Set<string>();
  const testFw = new Set<string>();
  const classic = new Set<string>();
  for (const p of csprojs) {
    const x = fs.readFileSync(path.join(root, p), "utf8");
    for (const m of x.matchAll(/<TargetFrameworks?>([^<]+)</g)) m[1].split(";").forEach((f) => frameworks.add(f.trim()));
    const fwv = /<TargetFrameworkVersion>v?([^<]+)</.exec(x);
    if (fwv) {
      frameworks.add(`.NET Framework ${fwv[1]}`);
      classic.add(p);
    }
    if (/xunit/i.test(x)) testFw.add("xUnit");
    if (/NUnit/.test(x)) testFw.add("NUnit");
    if (/MSTest/.test(x)) testFw.add("MSTest");
    if (/FluentAssertions/.test(x)) testFw.add("FluentAssertions");
    if (/Moq\b/.test(x)) testFw.add("Moq");
    if (/EntityFrameworkCore/.test(x)) frameworks.add("EF Core");
  }
  tech.push(`.NET (${[...frameworks].join(", ") || "sürüm bilinmiyor"}) · ${csprojs.length} proje`);
  if (testFw.size) tech.push(`Test: ${[...testFw].join(", ")}`);
  const slns = fs.readdirSync(root).filter((f) => /\.slnx?$/.test(f)).sort();
  const { sln, notes: slnNotes } = pickSolution(root, slns, classic);
  notes.push(...slnNotes);
  if (classic.size) {
    tech.push(`${classic.size} proje .NET Framework (eski biçim): sadece Windows'ta derlenir ve test edilir; macOS/Linux'ta bu projelerdeki değişiklikler yerelde doğrulanamaz, CI'da doğrulanır`);
    notes.push(`${classic.size} .NET Framework projesi var; bu makinede derlenemez. Komutlar sadece ${sln ?? "SDK biçimli projeler"} üzerinde çalışır.`);
  }
  const target = sln ? ` ${JSON.stringify(sln).slice(1, -1)}` : "";
  // commit hook'u CSharpier çalıştırıyorsa flowloop da aynı formatter'ı kullanmalı; yoksa commit'lenen içerik onaylanandan farklı olur
  const read = (f: string) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), "utf8") : "");
  const csharpier = /csharpier/i.test(read(".config/dotnet-tools.json") + read(".husky/task-runner.json") + read(".pre-commit-config.yaml"));
  const csharpierExts = csharpier ? csharpierExtensions(read(".husky/task-runner.json")) : [];
  if (csharpier) notes.push(`CSharpier bulundu (commit hook'u ile aynı biçim için format: dotnet csharpier format, uzantılar: ${csharpierExts.join(", ")})`);
  return {
    stack: "dotnet",
    tech,
    commands: {
      install: `dotnet restore${target}`,
      // her değişen test dosyasının projesinde, sadece o test sınıfları
      testRelated: `dotnet test {{testProject}} --no-restore --filter "{{testFilter}}"`,
      typecheck: `dotnet build${target} --no-restore -nologo -clp:NoSummary`,
      // CSharpier varsa boşluk/girinti onun işi; lint sadece stil kurallarına bakar
      lint: csharpier
        ? `dotnet format style${target} --verify-no-changes --no-restore --include {{files}}`
        : `dotnet format${target} --verify-no-changes --no-restore --include {{files}}`,
      // sadece biçim: stil düzeltmeleri (ör. file-scoped namespace) dosyanın tamamını değiştirip PR'ı şişirir
      format: csharpier ? `dotnet csharpier format {{files:${csharpierExts.join(",")}}}` : `dotnet format whitespace${target} --include {{files}}`,
      commitCheck: "",
    },
    linkDirs: [],
    edit: ["**"],
    readDeny: [...COMMON_DENY, "**/appsettings.*.json", "**/secrets.json", "**/*.pfx"],
    notes,
  };
}

function gitLsFiles(root: string): string[] {
  const r = git(["ls-files"], root);
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

export function detectProject(root: string): Detected {
  return detectStack(root);
}

function detectStack(root: string): Detected {
  const ls = fs.readdirSync(root);
  if (ls.some((f) => f.endsWith(".sln") || f.endsWith(".csproj")) || gitLsFiles(root).some((f) => f.endsWith(".csproj"))) {
    return detectDotnet(root);
  }
  const pkg = readJson(path.join(root, "package.json"));
  if (pkg) return detectNode(root, pkg);
  return {
    stack: "other",
    tech: [],
    commands: { install: "", testRelated: "make test FILES='{{files}}'", typecheck: "", lint: "", format: "", commitCheck: "" },
    linkDirs: [],
    edit: ["**"],
    readDeny: COMMON_DENY,
    notes: ["Stack algılanamadı; komutları elle doldur."],
  };
}

/** production → main → master sırasıyla var olan ilk branch (önce origin/...). */
export function detectBaseBranch(root: string): string {
  for (const b of ["production", "main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`], root).code === 0) return b;
    if (git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], root).code === 0) return b;
  }
  return "";
}

const q = (s: string) => JSON.stringify(s);

export function renderConfig(d: Detected, baseBranch: string, branchName: string, memoryServers: string[] = [], jiraBase = ""): string {
  const list = (xs: string[], indent = "    ") => xs.map((x) => `${indent}- ${q(x)}`).join("\n");
  return `# flowloop yapılandırması
version: 2
stack: ${d.stack}
baseBranch: ${q(baseBranch)}     # boş = otomatik (production → main → master)
branchName: ${q(branchName)}     # {{jira}} görev dosyasından okunur; yoksa flowloop/{{slug}}-{{date}}
fetch: true                      # başlamadan önce origin'den base'i çek
push: true                       # iş bitince branch origin'e push'lanır (force push asla yapılmaz)
jira:
  baseUrl: ${q(jiraBase)}                    # boş = flowloop setup'ta girilen adres (~/.flowloop/config.json) ya da JIRA_BASE_URL
  comment: true                  # iş bitince Jira'ya kısa özet yorumu (sorun / yapılan / neden + branch, PR)
                                 # kimlik: flowloop setup (anahtar zincirinde saklanır)
questions: ask                   # analistin açık soruları: ask (terminalde sor) | jira (Jira'ya yaz ve dur) | assume (varsayılanla devam)

# {{files}} = bu işte değişen dosyalar, {{testFiles}} = bunlardan test olanlar.
# typecheck ve lint için SADECE bu işin getirdiği YENİ hatalar sayılır.
commands:
  install: ${q(d.commands.install)}          # linkDirs yetmezse worktree'de kurulum
  testRelated: ${q(d.commands.testRelated)}
  typecheck: ${q(d.commands.typecheck)}
  lint: ${q(d.commands.lint)}
  format: ${q(d.commands.format)}            # her developer turundan sonra otomatik
  commitCheck: ${q(d.commands.commitCheck)}

linkDirs: [${d.linkDirs.map(q).join(", ")}]   # repodan worktree'ye bağlanır (kurulum gerekmez)

paths:
  edit:                          # developer'ın değiştirebileceği yollar; "**" = bütün repo
                                 # (readDeny'daki gizli dosyalara, .git'e ve .flowloop'a yine yazamaz).
                                 # Daraltmak için ör. - "src/**"
${list(d.edit)}
  readDeny:                      # hiçbir rol okuyamaz
${list(d.readDeny)}

# Projenin mevcut kuralları (bulunanlar otomatik dahil edilir)
projectDocs:
${list(DEFAULT_PROJECT_DOCS, "  ")}

userClaudeMd: true               # kişisel ~/.claude/CLAUDE.md de eklenir (proje kuralı önceliklidir)

# Claude Code'daki MCP sunucularından ajanlara açılacaklar (ör. claude-code-memory).
# Sadece aşağıdaki (salt okuma) araçlar açılır; hafızaya yazma araçları kapalıdır.
mcp:
  servers: [${(memoryServers.length ? memoryServers : ["auto"]).map(q).join(", ")}]   # "auto" = bu repo için tanımlı hafıza sunucuları
  tools: ["search_similar", "read_graph", "get_implementation"]
  roles: ["analist", "developer", "reviewer"]

rules: []                        # flowloop'e özel ek kural dosyaları (opsiyonel)

# Bu projenin bağımlı olduğu diğer repolar. Ajanlar hepsini okuyabilir; edit verilirse o yollarda
# değişiklik yapılabilir ve o repoda da aynı adlı branch açılıp commit/push/PR yapılır.
related: []
# related:
#   - name: backend
#     path: ../backend            # bilgisayardaki yol (bu projeye göre)
#     edit: ["**"]                # "**" = bütün repo; ör. "src/**" ile daralt; boş bırakılırsa sadece okunur

tech: |
${d.tech.map((t) => `  - ${t}`).join("\n") || "  - (doldur)"}

mutation: { enabled: true, testTimeoutSec: 300 }
budgets: { analist: 1.0, gelistir: 4.0, commit: 0.5, total: 6.0 }   # USD
maxIterations: 3
model: ""                        # boş = Claude Code varsayılanı
roles: {}                        # ör. reviewer: { model: opus }
isolation: true                  # kullanıcı plugin/skill/MCP'leri yüklenmez

# Ajan aracı: auto = Claude erişimi varsa Claude, yoksa Cursor CLI. claude | cursor ile sabitlenebilir.
# Tek seferlik: flowloop run PROJ-1234 --agent cursor
agent: auto
cursor:
  bin: ""                         # boş = cursor-agent, yoksa agent
  model: ""                       # boş = Cursor varsayılanı (cursor-agent --list-models)
  timeoutMin: 30                  # rol başına süre sınırı (Cursor maliyet bildirmez)
  extraArgs: []
`;
}
