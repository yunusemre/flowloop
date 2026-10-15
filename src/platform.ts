import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * İşletim sistemine göre değişen küçük işler tek yerde.
 *
 * Windows'ta flowloop'un yapılandırma komutları (testler, derleme...) Git Bash ile çalışır:
 * Claude Code da Windows'ta Git for Windows'u (bash.exe) gerektirir ve ajanların Bash aracı
 * aynı kabuğu kullanır. Böylece flowloop.yaml'daki komutlar her sistemde aynı sözdizimiyle yazılır.
 */
export const isWindows = (platform: NodeJS.Platform = process.platform) => platform === "win32";

/** Git Bash'in olası yerleri (bash.exe) */
export function gitBashCandidates(env: NodeJS.ProcessEnv = process.env, gitExe?: string): string[] {
  const out: string[] = [];
  for (const v of [env.FLOWLOOP_BASH, env.CLAUDE_CODE_GIT_BASH_PATH]) if (v) out.push(v);
  if (gitExe) {
    // ...\Git\cmd\git.exe ya da ...\Git\bin\git.exe ya da ...\Git\mingw64\bin\git.exe → ...\Git\bin\bash.exe
    let dir = path.win32.dirname(gitExe);
    for (let i = 0; i < 3; i++) {
      out.push(path.win32.join(dir, "bin", "bash.exe"));
      dir = path.win32.dirname(dir);
    }
  }
  for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs")]) {
    if (base) out.push(path.win32.join(base, "Git", "bin", "bash.exe"));
  }
  out.push("C:\\Program Files\\Git\\bin\\bash.exe");
  return [...new Set(out)];
}

let cachedBash: string | null | undefined;
/** Komutları çalıştıracak bash: Windows'ta Git Bash (bulunamazsa undefined), diğerlerinde "bash" */
export function bashPath(platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  if (!isWindows(platform)) return "bash";
  if (cachedBash !== undefined) return cachedBash ?? undefined;
  const gitExe = whereFirst("git");
  // WSL'in C:\Windows\System32\bash.exe'si bilinçli olarak atlanır: o, Linux tarafında çalışır
  const found = gitBashCandidates(process.env, gitExe).find((p) => exists(p) && !/\\system32\\/i.test(p));
  cachedBash = found ?? null;
  return found;
}

export const GIT_BASH_HINT =
  "Git Bash bulunamadı. Git for Windows'u kur (https://git-scm.com/download/win) ya da bash.exe'nin yolunu FLOWLOOP_BASH ortam değişkeniyle ver.";

/** Kabukta çalışacak bir komut satırı için [program, argümanlar]. Windows'ta giriş kabuğu (-l) kullanılmaz: PATH Windows'tan gelir. */
export function shellCommand(command: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (!isWindows(platform)) return ["bash", ["-lc", command]];
  const bash = bashPath(platform);
  if (!bash) throw new Error(GIT_BASH_HINT);
  return [bash, ["-c", command]];
}

function whereFirst(bin: string): string | undefined {
  const r = spawnSync("where", [bin], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return undefined;
  return pickWhere(r.stdout);
}

/** `where` çıktısından çalıştırılabilir olanı seçer: uzantısız betik (npm'in sh kopyası) yerine .exe, sonra .cmd/.bat */
export function pickWhere(out: string): string | undefined {
  const all = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return all.find((p) => /\.exe$/i.test(p)) ?? all.find((p) => /\.(cmd|bat)$/i.test(p)) ?? all[0];
}

/** Bir programın PATH'teki yolu (yoksa undefined). Windows'ta `where`, diğerlerinde giriş kabuğunda `command -v`. */
export function which(bin: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!/^[\w.+-]+$/.test(bin)) return undefined; // kabuğa ham metin geçmesin
  if (isWindows(platform)) return whereFirst(bin);
  const r = spawnSync("bash", ["-lc", `command -v ${bin}`], { encoding: "utf8" });
  const p = r.stdout?.trim();
  return r.status === 0 && p ? p : undefined;
}

/** Klasör bağlantısı türü: Windows'ta "junction" (yönetici izni ya da Geliştirici Modu gerektirmez) */
export function dirLinkType(platform: NodeJS.Platform = process.platform): "junction" | "dir" {
  return isWindows(platform) ? "junction" : "dir";
}

/** Klasöre bağlantı oluşturur (node_modules gibi büyük klasörleri kopyalamamak için) */
export function linkDir(target: string, link: string, platform: NodeJS.Platform = process.platform): void {
  fs.symlinkSync(target, link, dirLinkType(platform));
}

/**
 * Git Bash tarzı yolu Windows yoluna çevirir: "/c/Users/x" → "C:/Users/x".
 * Ajanların Bash aracı Windows'ta bu biçimi kullanabilir; yetki kontrolü gerçek yol üzerinden yapılır.
 */
export function nativePath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (!isWindows(platform)) return p;
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p) ?? /^\/cygdrive\/([a-zA-Z])(\/.*)?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:${m[2] ?? "/"}` : p;
}

/** Windows yolundaki ters bölüleri düz bölüye çevirir (kabuk komutlarında ve glob kurallarında güvenli) */
export function slashPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Adresi varsayılan tarayıcıda açan komut */
export function openerCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  // start'ın ilk tırnaklı argümanı pencere başlığıdır; boş başlık verilir
  if (isWindows(platform)) return ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]];
  return ["xdg-open", [url]];
}

/** Metni panoya kopyalayan komut (yoksa undefined) */
export function clipboardCommand(platform: NodeJS.Platform = process.platform): [string, string[]] | undefined {
  if (platform === "darwin") return ["pbcopy", []];
  if (isWindows(platform)) return ["clip", []];
  if (which("wl-copy", platform)) return ["wl-copy", []];
  if (which("xclip", platform)) return ["xclip", ["-selection", "clipboard"]];
  return undefined;
}
