import type { FlowloopConfig } from "./config.js";
import { fillFiles, runConfigured, type ExecResult } from "./git.js";

/**
 * Deterministik, İŞE ODAKLI kontroller.
 *
 * - Testler: sadece değişen dosyalarla ilgili testler çalışır.
 * - Tip kontrolü ve lint: projede zaten var olan hatalar sayılmaz. Base
 *   (dokunulmamış) kopyada aynı komut çalıştırılır; sadece bu işle GELEN
 *   hatalar bloklar.
 *
 * Satır/sütun numaraları ve klasör yolları normalize edilir; böylece kod
 * kaydığında eski hatalar "yeni" görünmez.
 */
export interface CheckResult {
  name: "format" | "testler" | "tip" | "lint";
  status: "ok" | "fail" | "skip";
  summary: string;
  details?: string;
}

export interface CheckRunner {
  run(command: string, cwd: string): ExecResult;
}
export const shellRunner: CheckRunner = { run: (c, cwd) => runConfigured(c, cwd) };

const ISSUE = /\b(error|warning)\b/i;
/** Lint'te sadece HATA sayılır; uyarılar (ör. Prettier ile çakışan stil kuralları) bloklamaz. */
const LINT_ERROR = /\berror\b/i;
const LINT_SUMMARY = /^(✖|\d+ problems?\b)/;
const lintErrors = (lines: string[]) => lines.filter((l) => LINT_ERROR.test(l) && !LINT_SUMMARY.test(l));
const TEST_FAIL = /(✕|✗|×|●\s|\bFAIL\b|\bnot ok\b|\bFailed\b)/;

export function normalize(output: string, roots: string[]): string[] {
  let s = output.replace(/\x1b\[[0-9;]*m/g, "");
  for (const r of roots) s = s.split(r + "/").join("").split(r).join("");
  return s
    .split("\n")
    .map((l) =>
      l
        .replace(/\(\d+,\d+\)/g, "")
        .replace(/:\d+:\d+/g, "")
        .replace(/^\s*\d+:\d+\s+/, "")
        .replace(/\s+/g, " ")
        .replace(/\(\d+(\.\d+)?\s*m?s\)/g, "")
        .trim(),
    )
    .filter(Boolean);
}

/** after − base (çoklu küme farkı) */
export function newLines(after: string[], base: string[]): string[] {
  const counts = new Map<string, number>();
  for (const l of base) counts.set(l, (counts.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of after) {
    const c = counts.get(l) ?? 0;
    if (c > 0) counts.set(l, c - 1);
    else out.push(l);
  }
  return out;
}

const clip = (lines: string[], n = 40) => (lines.length > n ? [...lines.slice(0, n), `… (+${lines.length - n} satır)`] : lines).join("\n");

export class ScopedChecks {
  private typecheckBase?: string[];

  constructor(
    private cfg: FlowloopConfig,
    /** developer'ın çalıştığı kopya */
    private wt: string,
    /** dokunulmamış base kopya */
    private baseWt: string,
    private runner: CheckRunner = shellRunner,
  ) {}

  private roots() {
    return [this.wt, this.baseWt];
  }

  /** Developer turundan sonra formatter'ı sadece değişen dosyalarda çalıştırır. */
  format(files: string[]): CheckResult {
    const cmd = this.cfg.commands.format;
    if (!cmd || files.length === 0) return { name: "format", status: "skip", summary: "formatter yok" };
    const r = this.runner.run(fillFiles(cmd, files), this.wt);
    return r.code === 0
      ? { name: "format", status: "ok", summary: `${files.length} dosya formatlandı` }
      : { name: "format", status: "fail", summary: "formatter hata verdi", details: clip((r.stdout + r.stderr).split("\n")) };
  }

  tests(files: string[], baseFiles: string[]): CheckResult {
    const cmd = this.cfg.commands.testRelated;
    if (files.length === 0) return { name: "testler", status: "skip", summary: "değişen dosya yok" };
    if (/\{\{testFiles\}\}/.test(cmd) && fillFiles("{{testFiles}}", files) === "") {
      return { name: "testler", status: "fail", summary: "bu işte hiç test dosyası değişmedi/eklenmedi" };
    }
    const filled = fillFiles(cmd, files);
    const r = this.runner.run(filled, this.wt);
    if (r.code === 0) return { name: "testler", status: "ok", summary: `ilgili testler geçti (${filled})` };
    // Base'de de aynı testler kırmızı mıydı?
    const after = normalize(r.stdout + "\n" + r.stderr, this.roots()).filter((l) => TEST_FAIL.test(l));
    let base: string[] = [];
    if (baseFiles.length) {
      const b = this.runner.run(fillFiles(cmd, baseFiles), this.baseWt);
      if (b.code !== 0) base = normalize(b.stdout + "\n" + b.stderr, this.roots()).filter((l) => TEST_FAIL.test(l));
    }
    const fresh = newLines(after, base);
    if (fresh.length === 0 && after.length > 0) {
      return { name: "testler", status: "ok", summary: "kırmızı testler base'de de aynı şekilde kırmızı (bu işle gelmedi)" };
    }
    const tail = (r.stdout + "\n" + r.stderr).trim().split("\n").slice(-60);
    return { name: "testler", status: "fail", summary: `ilgili testler kırmızı (${filled})`, details: clip(fresh.length ? fresh : tail, 60) };
  }

  typecheck(files: string[]): CheckResult {
    const cmd = this.cfg.commands.typecheck;
    if (!cmd) return { name: "tip", status: "skip", summary: "tip kontrolü yok" };
    if (!this.typecheckBase) {
      const b = this.runner.run(cmd, this.baseWt);
      this.typecheckBase = normalize(b.stdout + "\n" + b.stderr, this.roots()).filter((l) => ISSUE.test(l));
    }
    const a = this.runner.run(cmd, this.wt);
    const after = normalize(a.stdout + "\n" + a.stderr, this.roots()).filter((l) => ISSUE.test(l));
    const fresh = newLines(after, this.typecheckBase);
    // Base'de olmayan her hata bu işle gelmiştir; değişen dosyanın kullanıldığı başka
    // dosyalarda çıkan kırılmalar da dahil (ör. bir tip imzası değiştiyse).
    const inScope = fresh;
    void files;
    const baseCount = this.typecheckBase.length;
    if (inScope.length === 0) {
      return { name: "tip", status: "ok", summary: `yeni tip hatası yok (projede önceden var olan ${baseCount} hata kapsam dışı)` };
    }
    return { name: "tip", status: "fail", summary: `${inScope.length} YENİ tip hatası`, details: clip(inScope) };
  }

  lint(files: string[], baseFiles: string[]): CheckResult {
    const cmd = this.cfg.commands.lint;
    if (!cmd || files.length === 0) return { name: "lint", status: "skip", summary: "lint yok" };
    const a = this.runner.run(fillFiles(cmd, files), this.wt);
    const after = lintErrors(normalize(a.stdout + "\n" + a.stderr, this.roots()));
    let base: string[] = [];
    if (baseFiles.length) {
      const b = this.runner.run(fillFiles(cmd, baseFiles), this.baseWt);
      base = lintErrors(normalize(b.stdout + "\n" + b.stderr, this.roots()));
    }
    const fresh = newLines(after, base);
    if (fresh.length === 0) return { name: "lint", status: "ok", summary: `yeni lint hatası yok (değişen ${files.length} dosyada)` };
    return { name: "lint", status: "fail", summary: `${fresh.length} YENİ lint hatası`, details: clip(fresh) };
  }
}

export function renderReport(results: CheckResult[]): string {
  const icon = { ok: "✅", fail: "❌", skip: "➖" } as const;
  return results
    .map((r) => `${icon[r.status]} ${r.name}: ${r.summary}${r.details ? "\n```\n" + r.details + "\n```" : ""}`)
    .join("\n");
}
