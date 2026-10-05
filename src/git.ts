import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  return sh("bash", ["-lc", command], cwd, { timeoutMs, env });
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
 * Çalışma ağacının (gitignore hariç, untracked dahil) içerik hash'i.
 * Gerçek index'e dokunmadan geçici bir index ile hesaplanır.
 */
export function workingTreeHash(cwd: string, exclude: string[] = []): string {
  const gitDir = gitOk(["rev-parse", "--absolute-git-dir"], cwd);
  const tmp = path.join(os.tmpdir(), `flowloop-index-${process.pid}-${Date.now()}`);
  try {
    const realIndex = path.join(gitDir, "index");
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmp);
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
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmp);
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
export function fillFiles(command: string, files: string[]): string {
  const quote = (f: string) => `'${f.replace(/'/g, "'\\''")}'`;
  const tests = files.filter((f) => TEST_FILE.test(f));
  return command
    .replace(/\{\{files\}\}/g, files.map(quote).join(" "))
    .replace(/\{\{testFiles\}\}/g, tests.map(quote).join(" "));
}
