import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellCommand } from "./platform.js";
import { scrubEnv } from "./secrets.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function sh(cmd: string, args: string[], cwd: string, opts: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): ExecResult {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    input: opts.input,
    env: opts.env ?? process.env,
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.error ? String(r.error) : "") };
}

/**
 * Yapılandırmadaki bir komut satırını (ör. "npm test") kabukta çalıştırır. Komut insan tarafından
 * yazıldı ama çalıştırdığı kod (testler) ajanın yazdığı kod olabilir; bu yüzden gizli bilgiler
 * varsayılan olarak ortamdan çıkarılır. Sadece bağımlılık kurulumu tam ortamla çalışır.
 */
export function runConfigured(command: string, cwd: string, timeoutMs = 15 * 60_000, opts: { fullEnv?: boolean } = {}): ExecResult {
  const env = opts.fullEnv ? { ...process.env } : scrubEnv(process.env);
  delete env.NODE_TEST_CONTEXT; // node --test içinden çağrıldığında iç içe test raporlamasını kapat
  // kontroller ve kurulum git hook'u kurmasın/çalıştırmasın (husky, Husky.Net): kopyalar git reposu olmayabilir
  env.HUSKY = "0";
  let shell: [string, string[]];
  try {
    shell = shellCommand(command);
  } catch (e) {
    return { code: 127, stdout: "", stderr: (e as Error).message };
  }
  return sh(shell[0], shell[1], cwd, { timeoutMs, env });
}

export function git(args: string[], cwd: string): ExecResult {
  return sh("git", args, cwd);
}

export function gitOk(args: string[], cwd: string): string {
  const r = git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} başarısız: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export function headSha(cwd: string): string {
  return gitOk(["rev-parse", "HEAD"], cwd);
}

/** linkDirs gibi symlink'leri git işlemlerinin dışında tutmak için pathspec */
export function excludeSpec(exclude: string[] = []): string[] {
  return exclude.length ? ["--", ".", ...exclude.map((e) => `:(exclude)${e}`)] : [];
}

export function statusPorcelain(cwd: string, exclude: string[] = []): string[] {
  const r = git(["status", "--porcelain", "--untracked-files=all", ...excludeSpec(exclude)], cwd);
  if (r.code !== 0) throw new Error(`git status başarısız: ${r.stderr.trim()}`);
  return r.stdout
    .split("\n")
    .filter(Boolean);
}

/** Durum satırlarından dosya yollarını çıkarır (rename'de hedef yol). */
export function changedPaths(cwd: string, exclude: string[] = []): string[] {
  return statusPorcelain(cwd, exclude).map((l) => {
    const p = l.slice(3);
    const arrow = p.indexOf(" -> ");
    return (arrow >= 0 ? p.slice(arrow + 4) : p).replace(/^"|"$/g, "");
  });
}

/**
 * Index'i geçici dosyaya kopyalar ve DEĞİŞTİRİLME ZAMANINI KORUR. Git, index'le aynı saniyede
 * değişen dosyaları ("racy") içeriğine bakarak kontrol eder; kopyanın zamanı yeni olursa bu
 * kontrol atlanır ve aynı boyutta değişen bir dosya (ör. 10 → 20) değişmemiş sanılır.
 */
function copyIndex(src: string, dst: string): void {
  fs.copyFileSync(src, dst);
  const st = fs.statSync(src);
  fs.utimesSync(dst, st.atime, st.mtime);
}

/**
 * Çalışma ağacının (gitignore hariç, untracked dahil) içerik hash'i.
 * Gerçek index'e dokunmadan geçici bir index ile hesaplanır.
 */
export function workingTreeHash(cwd: string, exclude: string[] = []): string {
  const gitDir = gitOk(["rev-parse", "--absolute-git-dir"], cwd);
  const tmp = path.join(os.tmpdir(), `flowloop-index-${process.pid}-${Date.now()}`);
  try {
    const realIndex = path.join(gitDir, "index");
    if (fs.existsSync(realIndex)) copyIndex(realIndex, tmp);
    const env = { ...process.env, GIT_INDEX_FILE: tmp };
    // zaten yok sayılan yollar pathspec'te adlandırılırsa "git add" hata verir; onları çıkar
    const ex = exclude.filter((d) => git(["check-ignore", "-q", d], cwd).code !== 0);
    const add = sh("git", ["add", "-A", ...excludeSpec(ex)], cwd, { env });
    if (add.code !== 0) throw new Error(`tree hash: ${add.stderr}`);
    const w = sh("git", ["write-tree"], cwd, { env });
    if (w.code !== 0) throw new Error(`tree hash: ${w.stderr}`);
    return w.stdout.trim();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Çalışma ağacının (untracked dahil) base'e göre farkı; gerçek index'e dokunmadan.
 * stat=true → dosya bazlı özet (git diff --stat)
 */
export function diffAgainst(cwd: string, base: string, exclude: string[] = [], opts: { stat?: boolean; color?: boolean } = {}): string {
  const gitDir = gitOk(["rev-parse", "--absolute-git-dir"], cwd);
  const tmp = path.join(os.tmpdir(), `flowloop-diff-${process.pid}-${Date.now()}`);
  try {
    const realIndex = path.join(gitDir, "index");
    if (fs.existsSync(realIndex)) copyIndex(realIndex, tmp);
    const env = { ...process.env, GIT_INDEX_FILE: tmp };
    const ex = exclude.filter((d) => git(["check-ignore", "-q", d], cwd).code !== 0);
    sh("git", ["add", "-A", ...excludeSpec(ex)], cwd, { env });
    const args = ["diff", "--cached", ...(opts.color ? ["--color=always"] : ["--no-color"]), ...(opts.stat ? ["--stat=100"] : []), base];
    return sh("git", args, cwd, { env }).stdout;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function isIgnored(cwd: string, rel: string): boolean {
  return git(["check-ignore", "-q", rel], cwd).code === 0;
}

/** Değişen ve hâlâ var olan dosyalar (silinenler hariç). */
export function changedExisting(cwd: string, exclude: string[] = []): string[] {
  return changedPaths(cwd, exclude).filter((p) => fs.existsSync(path.join(cwd, p)));
}

/** Komuttaki {{files}} / {{testFiles}} yer tutucularını tek tırnaklı dosya listesiyle doldurur. */
export const TEST_FILE = /(^|\/)(__tests__|tests?)\/|[._-](test|spec)s?\.[cm]?[jt]sx?$|Tests?\.cs$/i;
/** Komutun sadece bu işin testlerini çalıştırdığını gösteren yer tutucular */
export const TEST_PLACEHOLDER = /\{\{(testFiles|testProject|testProjects|testFilter)\}\}/;

/** Bir dosyanın ait olduğu proje dosyası (.csproj vb.): en yakın üst klasördeki */
export function nearestProject(file: string, cwd: string, ext = [".csproj", ".fsproj", ".vbproj"]): string | undefined {
  let dir = path.dirname(file);
  for (;;) {
    const abs = path.join(cwd, dir);
    if (fs.existsSync(abs)) {
      const p = fs.readdirSync(abs).find((f) => ext.some((e) => f.endsWith(e)));
      if (p) return dir === "." ? p : path.join(dir, p);
    }
    if (dir === "." || dir === "/" || !dir) return undefined;
    dir = path.dirname(dir);
  }
}

/** .NET Framework (eski biçim) projesi mi: sadece Windows'ta derlenir/test edilir */
export function isClassicDotnetProject(project: string, cwd: string): boolean {
  try {
    return /<TargetFrameworkVersion>/.test(fs.readFileSync(path.join(cwd, project), "utf8"));
  } catch {
    return false;
  }
}

/** Bu makinede çalıştırılamayan test projeleri (Windows dışında .NET Framework projeleri) */
export function unrunnableTestProjects(files: string[], cwd: string, platform = process.platform): string[] {
  if (platform === "win32") return [];
  const ps = new Set(files.filter((f) => TEST_FILE.test(f)).map((t) => nearestProject(t, cwd)).filter((p): p is string => !!p));
  return [...ps].filter((p) => isClassicDotnetProject(p, cwd));
}

/**
 * Komuttaki yer tutucuları doldurur:
 *   {{files}}        değişen dosyalar
 *   {{testFiles}}    bunlardan test olanlar
 *   {{testProjects}} test dosyalarının projeleri (.csproj), boşlukla
 *   {{testProject}}  komut her test projesi için ayrı çalışır (&& ile); {{testFilter}} o projedeki
 *                    test sınıflarına göre dotnet --filter ifadesi olur
 */
export function fillFiles(command: string, files: string[], cwd = process.cwd()): string {
  const quote = (f: string) => `'${f.replace(/'/g, "'\\''")}'`;
  const tests = files.filter((f) => TEST_FILE.test(f));
  const byProject = new Map<string, string[]>();
  if (/\{\{test(Project|Projects|Filter)\}\}/.test(command)) {
    for (const t of tests) {
      const p = nearestProject(t, cwd);
      // .NET Framework projeleri Windows dışında çalıştırılamaz (CI'da doğrulanır)
      if (p && process.platform !== "win32" && isClassicDotnetProject(p, cwd)) continue;
      if (p) byProject.set(p, [...(byProject.get(p) ?? []), t]);
    }
  }
  const filter = (fs_: string[]) => [...new Set(fs_.map((f) => path.basename(f).replace(/\.[^.]+$/, "")))].map((c) => `FullyQualifiedName~${c}`).join("|");
  const base = (cmd: string) =>
    cmd
      // {{files:cs,csproj}} → sadece bu uzantılardaki değişen dosyalar
      .replace(/\{\{files:([a-z0-9,]+)\}\}/gi, (_m, exts: string) => {
        const set = new Set(exts.toLowerCase().split(",").filter(Boolean));
        return files.filter((f) => set.has(path.extname(f).slice(1).toLowerCase())).map(quote).join(" ");
      })
      .replace(/\{\{files\}\}/g, files.map(quote).join(" "))
      .replace(/\{\{testFiles\}\}/g, tests.map(quote).join(" "))
      .replace(/\{\{testProjects\}\}/g, [...byProject.keys()].map(quote).join(" "));
  if (!/\{\{testProject\}\}/.test(command)) return base(command).replace(/\{\{testFilter\}\}/g, filter(tests));
  if (!byProject.size) return "";
  return [...byProject].map(([p, fs_]) => base(command).replace(/\{\{testProject\}\}/g, quote(p)).replace(/\{\{testFilter\}\}/g, filter(fs_))).join(" && ");
}
