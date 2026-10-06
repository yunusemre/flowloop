import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { findForbiddenFlag, matchesPrefix, parseSimpleCommand } from "./shell.js";

/**
 * Bir rolün yetkileri. Bütün kararlar bu saf fonksiyonlarla verilir; Claude
 * Code'un kendi izin sistemine güvenilmez, her araç çağrısı (okuma dahil)
 * PreToolUse hook'u üzerinden buradan geçer.
 *
 * Desen sözdizimi:
 *   "src/**"      → çalışma kopyasına (worktree) göre
 *   "run:plan.md" → bu çalıştırmanın run klasörüne göre (plan, görev, mutant)
 */
export interface RolePermissions {
  tools: string[];
  read: string[];
  edit: string[];
  bash: string[];
}

export interface PolicyContext {
  repoRoot: string;
  runRoot: string;
  /** Hiçbir rolün okuyamayacağı/düzenleyemeyeceği dosyalar (repo'ya göre). */
  readDeny: string[];
  /** Komut bazında yasak bayraklar, ör. { "git commit": ["--no-verify", "-n"] } */
  forbiddenFlags: Record<string, string[]>;
  /**
   * Kullanıcının asıl repo klasörü. Kod hafızası (ör. claude-code-memory) bu
   * yolları döndürür; bu yollar çalışma kopyasındaki karşılığına çevrilir.
   * Asıl repoya hiçbir rol doğrudan erişemez.
   */
  aliasRoot?: string;
  /**
   * Bağımlı (ilgili) repoların çalışma kopyaları. Desen sözdizimi: "@ad:src/**".
   * readDeny ve aliasRoot her repo için ayrıdır.
   */
  extraRoots?: { name: string; root: string; readDeny: string[]; aliasRoot?: string }[];
}

const PATH_FIELDS = ["file_path", "path", "notebook_path"];

/** Asıl repo yollarını çalışma kopyası yollarına çevirir; değişiklik yoksa undefined. */
export function rewriteAliasPaths(ctx: PolicyContext, input: Record<string, unknown>): Record<string, unknown> | undefined {
  const pairs: { alias: string; target: string }[] = [];
  if (ctx.aliasRoot) pairs.push({ alias: realish(ctx.aliasRoot), target: ctx.repoRoot });
  for (const e of ctx.extraRoots ?? []) if (e.aliasRoot) pairs.push({ alias: realish(e.aliasRoot), target: e.root });
  if (!pairs.length) return undefined;
  let changed = false;
  const out = { ...input };
  for (const f of PATH_FIELDS) {
    const v = input[f];
    if (typeof v !== "string" || !path.isAbsolute(v)) continue;
    for (const { alias, target } of pairs) {
      const rel = within(alias, realish(v));
      if (rel === undefined) continue;
      out[f] = rel === "." ? target : path.join(target, rel);
      changed = true;
      break;
    }
  }
  return changed ? out : undefined;
}

export type Decision = { allow: true } | { allow: false; reason: string };

// .cursor/hooks.json ve .cursor/cli.json: Cursor kullanılırken yetki kurallarını taşır; ajan değiştiremez
const ALWAYS_EDIT_DENY = [".git/**", ".git", ".flowloop/**", ".cursor/hooks.json", ".cursor/cli.json"];
const FILE_TOOLS_EDIT = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function realish(p: string): string {
  // Var olan en yakın üst klasörün gerçek yolunu bul (symlink hilelerine karşı)
  let cur = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  let base: string;
  try {
    base = fs.realpathSync(cur);
  } catch {
    base = cur;
  }
  return path.join(base, ...rest);
}

function within(root: string, p: string): string | undefined {
  const rel = path.relative(root, p);
  if (rel === "") return ".";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join("/");
}

/** Bir yolu "repo-göreli" ya da "run:göreli" anahtara çevirir; dışarıdaysa undefined. */
export function locate(ctx: PolicyContext, p: string): string | undefined {
  const abs = realish(path.isAbsolute(p) ? p : path.join(ctx.repoRoot, p));
  const runRoot = realish(ctx.runRoot);
  const repoRoot = realish(ctx.repoRoot);
  const inRun = within(runRoot, abs);
  if (inRun !== undefined) return "run:" + inRun;
  for (const e of ctx.extraRoots ?? []) {
    const r = within(realish(e.root), abs);
    if (r !== undefined) return `@${e.name}:${r}`;
  }
  const inRepo = within(repoRoot, abs);
  if (inRepo !== undefined) return inRepo;
  return undefined;
}

/** "@ad:src/x.ts" → "src/x.ts"; diğerleri aynen */
function innerPath(key: string): string {
  const m = /^@[^:]+:(.*)$/.exec(key);
  return m ? m[1] : key;
}

/** Ana repoda readDeny, ilgili repolarda kendi readDeny listeleri */
function isSecret(ctx: PolicyContext, key: string): boolean {
  if (key.startsWith("run:")) return false;
  const m = /^@([^:]+):(.*)$/.exec(key);
  if (!m) return match(key, ctx.readDeny);
  const e = ctx.extraRoots?.find((x) => x.name === m[1]);
  return match(m[2], e?.readDeny ?? ctx.readDeny);
}

function match(key: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  return picomatch(patterns, { dot: true })(key);
}

function checkPath(ctx: PolicyContext, p: unknown, allowed: string[], kind: "okuma" | "yazma"): Decision {
  if (typeof p !== "string" || !p) return { allow: false, reason: `${kind}: yol belirtilmemiş` };
  const key = locate(ctx, p);
  if (key === undefined) return { allow: false, reason: `${kind}: ${p} çalışma alanı dışında` };
  if (isSecret(ctx, key)) {
    return { allow: false, reason: `${kind}: ${key} gizli dosya listesinde (readDeny)` };
  }
  if (kind === "yazma" && match(innerPath(key), ALWAYS_EDIT_DENY)) {
    return { allow: false, reason: `yazma: ${key} korumalı` };
  }
  if (key === "." && kind === "okuma") return { allow: true };
  if (!match(key, allowed)) {
    return { allow: false, reason: `${kind}: bu rol ${key} yoluna ${kind === "okuma" ? "erişemez" : "yazamaz"} (izinli: ${allowed.join(", ") || "yok"})` };
  }
  return { allow: true };
}

function checkDir(ctx: PolicyContext, p: unknown, allowedRead: string[]): Decision {
  if (p === undefined || p === null || p === "") return { allow: true }; // varsayılan: cwd (repo)
  if (typeof p !== "string") return { allow: false, reason: "geçersiz yol" };
  const key = locate(ctx, p);
  if (key === undefined) return { allow: false, reason: `arama: ${p} çalışma alanı dışında` };
  if (key === "." || key === "run:." || /^@[^:]+:\.$/.test(key)) return { allow: true };
  // klasör ya da dosya: klasörün altındaki bir şey okunabiliyorsa izin ver
  const isFile = fs.existsSync(path.isAbsolute(p) ? p : path.join(ctx.repoRoot, p)) &&
    fs.statSync(path.isAbsolute(p) ? p : path.join(ctx.repoRoot, p)).isFile();
  if (isFile) return checkPath(ctx, p, allowedRead, "okuma");
  if (isSecret(ctx, key)) return { allow: false, reason: `arama: ${key} gizli` };
  if (match(key, allowedRead) || match(key + "/x", allowedRead)) return { allow: true };
  return { allow: false, reason: `arama: bu rol ${key} klasöründe arama yapamaz` };
}

export function evaluate(perms: RolePermissions, ctx: PolicyContext, toolName: string, input: Record<string, unknown>): Decision {
  if (!perms.tools.includes(toolName)) {
    return { allow: false, reason: `${toolName} aracı bu rol için kapalı (izinli: ${perms.tools.join(", ")})` };
  }
  switch (toolName) {
    case "Read":
      return checkPath(ctx, input.file_path, perms.read, "okuma");
    case "Glob":
    case "Grep":
      return checkDir(ctx, input.path, perms.read);
    case "NotebookEdit":
      return checkPath(ctx, input.notebook_path, perms.edit, "yazma");
    case "Bash": {
      const cmd = input.command;
      if (typeof cmd !== "string") return { allow: false, reason: "Bash: komut yok" };
      const parsed = parseSimpleCommand(cmd);
      if (!parsed.ok) return { allow: false, reason: `Bash: ${parsed.reason}` };
      const prefix = matchesPrefix(parsed.tokens, perms.bash);
      if (!prefix) {
        return { allow: false, reason: `Bash: "${cmd}" bu rol için izinli değil (izinli: ${perms.bash.join(" | ") || "yok"})` };
      }
      for (const [p, flags] of Object.entries(ctx.forbiddenFlags)) {
        const pt = parseSimpleCommand(p);
        if (pt.ok && pt.tokens.every((t, i) => parsed.tokens[i] === t)) {
          const bad = findForbiddenFlag(parsed.tokens, flags);
          if (bad) return { allow: false, reason: `Bash: ${bad} bayrağı yasak` };
        }
      }
      return { allow: true };
    }
    default:
      if (FILE_TOOLS_EDIT.has(toolName)) return checkPath(ctx, input.file_path, perms.edit, "yazma");
      // TodoWrite, mcp__flowloop__* gibi yan etkisi bizim kontrolümüzde olan araçlar
      return { allow: true };
  }
}

export const DEFAULT_FORBIDDEN_FLAGS: Record<string, string[]> = {
  "git commit": ["--no-verify", "-n", "--amend", "--no-gpg-sign"],
  "git diff": ["--output", "--ext-diff"],
  "git log": ["--output"],
  "git show": ["--output", "--ext-diff"],
  "git add": ["--force", "-f"],
  "git status": [],
  "npx jest": ["-u", "--updateSnapshot", "--config", "-c", "--watch", "--watchAll"],
  "npx vitest": ["-u", "--update", "--config", "-c", "--watch"],
  "npx eslint": ["--fix", "--fix-type", "-o", "--output-file", "-c", "--config", "--rulesdir", "--plugin"],
  "npx prettier": ["--config", "--plugin"],
  "npx tsc": ["--outDir", "--outFile", "--build", "-b", "--declarationDir"],
};
