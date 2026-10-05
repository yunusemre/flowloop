import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PACKAGE_ROOT } from "./roles.js";

/**
 * Kurulum kaydı (~/.kgflow/install.json, install.sh yazar) ve güncelleme.
 *
 *   mode=local   → repo klasöründen kuruldu (npm link): güncelleme = git pull + install.sh
 *   mode=managed → git kaynağı ~/.kgflow/src'ye çekildi: güncelleme = aynı kaynaktan yeniden çek ve kur
 *   mode=remote  → .tgz paketinden kuruldu: güncelleme = aynı adresten yeniden kur
 */
export interface InstallInfo {
  /** local: repo klasöründen · managed: git kaynağından ~/.kgflow/src'ye çekildi · remote: .tgz */
  mode: "local" | "managed" | "remote";
  source: string;
  dir?: string;
  commit?: string;
  version?: string;
  installedAt?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function installFile(home = os.homedir()): string {
  return path.join(home, ".kgflow", "install.json");
}

export function readInstallInfo(home = os.homedir()): InstallInfo | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(installFile(home), "utf8")) as InstallInfo;
    return j.source ? j : undefined;
  } catch {
    return undefined;
  }
}

export function currentVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")).version;
  } catch {
    return "?";
  }
}

/** "git+ssh://host/x.git#dal" → { url: "ssh://host/x.git", ref: "dal" }; .tgz → undefined */
export function gitRemote(source: string): { url: string; ref: string } | undefined {
  if (/\.(tgz|tar\.gz)$/.test(source)) return undefined;
  const rest = source.startsWith("git+") ? source.slice(4) : source;
  const i = rest.indexOf("#");
  return i < 0 ? { url: rest, ref: "HEAD" } : { url: rest.slice(0, i), ref: rest.slice(i + 1) };
}

function git(args: string[], cwd?: string, timeoutMs = 8000) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

/** Kaynaktaki en son commit (bulunamazsa undefined). Ağ yoksa sessizce vazgeçer. */
export function latestCommit(info: InstallInfo): string | undefined {
  if (info.mode === "local") {
    const up = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], info.source);
    if (!up.ok || !up.out.includes("/")) return undefined;
    const [remote, ...branch] = up.out.split("/");
    const r = git(["ls-remote", remote, `refs/heads/${branch.join("/")}`], info.source);
    return r.ok ? r.out.split(/\s/)[0] || undefined : undefined;
  }
  const g = gitRemote(info.source);
  if (!g) return undefined;
  const ref = g.ref === "HEAD" ? "HEAD" : `refs/heads/${g.ref}`;
  const r = git(["ls-remote", g.url, ref]);
  return r.ok ? r.out.split(/\s/)[0] || undefined : undefined;
}

/** Kurulu commit: local'de çalışma kopyasının HEAD'i, remote'ta kurulum anındaki commit. */
export function installedCommit(info: InstallInfo): string | undefined {
  const dir = info.mode === "local" ? info.source : info.mode === "managed" ? info.dir : undefined;
  if (dir) {
    const r = git(["rev-parse", "HEAD"], dir);
    if (r.ok) return r.out;
  }
  return info.commit || undefined;
}

/**
 * Günde en fazla bir kez yeni sürüm olup olmadığına bakar; varsa kullanıcıya gösterilecek mesajı döner.
 * KGFLOW_NO_UPDATE_CHECK=1 ile kapatılır. Hata/ağ yokluğu sessizce yok sayılır.
 */
export function updateNotice(home = os.homedir(), now = Date.now(), check: (i: InstallInfo) => string | undefined = latestCommit): string | undefined {
  if (process.env.KGFLOW_NO_UPDATE_CHECK) return undefined;
  const info = readInstallInfo(home);
  if (!info) return undefined;
  const cacheFile = path.join(home, ".kgflow", "update-check.json");
  let cache: { checkedAt?: number; latest?: string } = {};
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  } catch {
    /* ilk kontrol */
  }
  let latest = cache.latest;
  if (!cache.checkedAt || now - cache.checkedAt > DAY_MS) {
    latest = check(info);
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ checkedAt: now, latest }));
    } catch {
      /* önemsiz */
    }
  }
  const mine = installedCommit(info);
  if (!latest || !mine || latest === mine) return undefined;
  if (info.mode === "local" && git(["merge-base", "--is-ancestor", latest, mine], info.source).ok) return undefined; // yerelde daha yeni
  return `kgflow'un yeni bir sürümü var (${latest.slice(0, 7)}). Güncellemek için: kgflow update`;
}

/** Güncellemeyi yapar; kullanıcıya akışı doğrudan gösterir. Dönüş: çıkış kodu. */
export function runUpdate(home = os.homedir(), log: (s: string) => void = console.log): number {
  const info = readInstallInfo(home);
  const before = currentVersion();
  if (!info) {
    log("Kurulum kaydı bulunamadı (~/.kgflow/install.json). kgflow'u install.sh ile bir kez yeniden kur:");
    log("  curl -fsSL <install.sh adresi> | bash      ya da repo klasöründe: ./install.sh");
    return 1;
  }
  const c0 = installedCommit(info)?.slice(0, 7);
  const env = { ...process.env, KGFLOW_UPDATING: "1" };
  let r;
  if (info.mode === "local") {
    log(`Kaynak: ${info.source} (yerel repo) → git pull`);
    const pull = spawnSync("git", ["pull", "--ff-only"], { cwd: info.source, stdio: "inherit" });
    if (pull.status !== 0) {
      log("git pull başarısız (yerelde commit'lenmemiş değişiklik ya da ayrışmış branch olabilir).");
      return 1;
    }
    r = spawnSync("bash", [path.join(info.source, "install.sh")], { stdio: "inherit", env });
  } else {
    log(`Kaynak: ${info.source}`);
    // install.sh'ı "curl | bash" gibi stdin'den çalıştır: kurulum sırasında dosyanın kendisi değişse de etkilenmez
    const script = fs.readFileSync(path.join(PACKAGE_ROOT, "install.sh"), "utf8");
    r = spawnSync("bash", ["-s"], { input: script, stdio: ["pipe", "inherit", "inherit"], env: { ...env, KGFLOW_SOURCE: info.source } });
  }
  if (r.status !== 0) return r.status ?? 1;
  fs.rmSync(path.join(home, ".kgflow", "update-check.json"), { force: true });
  const now = readInstallInfo(home);
  const after = now?.version ?? "?";
  const c1 = now ? installedCommit(now)?.slice(0, 7) : undefined;
  const changed = after !== before || (c0 && c1 && c0 !== c1);
  log(changed ? `Güncellendi: kgflow ${before}${c0 ? ` (${c0})` : ""} → ${after}${c1 ? ` (${c1})` : ""}` : `Zaten güncel: kgflow ${after}${c1 ? ` (${c1})` : ""}`);
  return 0;
}
