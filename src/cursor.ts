import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROLE_GUARDRAIL, type AgentRequest, type AgentResult, type AgentRunner, type Denial } from "./agent.js";
import type { PolicyContext, RolePermissions } from "./policy.js";
import { PACKAGE_ROOT, type RoleName } from "./roles.js";

/**
 * Cursor CLI ile ajan çalıştırıcı.
 *
 * Yetkiler, Claude'daki gibi kodla zorlanır: çalışma kopyasına geçici bir
 * `.cursor/hooks.json` yazılır; Cursor her araç çağrısından (kabuk komutu,
 * dosya okuma/yazma, MCP) önce `cursorhook.js`'i çalıştırır ve aynı
 * `evaluate()` politikası karar verir. Hook hata verirse işlem engellenir
 * (failClosed). Çalıştırma bitince dosyalar eski hâline döner.
 *
 * Farklar: Cursor maliyet bildirmez (bütçe yerine süre sınırı), kullanıcının
 * Claude MCP sunucuları Cursor'a aktarılmaz, mutasyon araçları kabuk komutu
 * olarak verilir.
 */
export interface CursorOptions {
  bin: string;
  model?: string;
  timeoutMin: number;
  extraArgs: string[];
}

/** Hook sürecine verilen bağlam (run klasöründe JSON olarak durur). */
export interface HookContext {
  role: RoleName;
  perms: RolePermissions;
  policy: PolicyContext;
  denialsFile: string;
  /** Hook'un her çağrıda bir satır yazdığı dosya (hook'ların gerçekten çalıştığının kanıtı) */
  callsFile?: string;
}

/** Mutasyon komutunun bağlamı (cli `__mutant` okur). */
export interface MutantContext {
  repoRoot: string;
  dir: string;
  testCmd: string;
  linkDirs: string[];
  timeoutSec: number;
}

export const CURSOR_CO_AUTHOR = "Co-Authored-By: Cursor Agent <cursoragent@cursor.com>";
const HOOK_FILES = [".cursor/hooks.json", ".cursor/cli.json"];
const HOOK_EVENTS = ["preToolUse", "beforeShellExecution", "beforeReadFile", "beforeMCPExecution"];

export class CursorAgentRunner implements AgentRunner {
  constructor(private opts: CursorOptions) {}

  async run(req: AgentRequest): Promise<AgentResult> {
    const ctlDir = path.join(req.runRoot, ".cursor-ctl");
    fs.mkdirSync(ctlDir, { recursive: true });
    const denialsFile = path.join(ctlDir, `${req.role}-denials.ndjson`);
    fs.rmSync(denialsFile, { force: true });

    let perms = req.perms;
    let prompt = req.prompt;
    if (req.mutant) {
      // MCP yerine kabuk komutu: run klasöründeki küçük betik, kgflow'un mutasyon kum havuzunu çağırır
      const m = req.mutant;
      const ctxFile = path.join(ctlDir, "mutant.json");
      const ctx: MutantContext = { repoRoot: m.repoRoot, dir: m.dir, testCmd: m.testCmd(), linkDirs: m.linkDirs, timeoutSec: m.timeoutSec };
      fs.writeFileSync(ctxFile, JSON.stringify(ctx));
      const script = path.join(ctlDir, "mutant");
      fs.writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" "${path.join(PACKAGE_ROOT, "dist", "src", "cli.js")}" __mutant "$1" "${ctxFile}"\n`, { mode: 0o755 });
      perms = { ...perms, bash: [...perms.bash, `${script} reset`, `${script} test`] };
      prompt +=
        `\n\nNOT (bu ortam): \`mutant_reset\` ve \`mutant_test\` araçları kabuk komutu olarak verilmiştir:\n` +
        `- mutant_reset → \`${script} reset\`\n- mutant_test  → \`${script} test\``;
    }

    if (req.role === "committer") {
      // Claude Code bu satırı kendisi ekler; Cursor'da açıkça istenir (işi kimin yaptığı görünsün)
      prompt += `\n\nHer commit mesajının en sonuna boş bir satırdan sonra şu satırı ekle:\n${CURSOR_CO_AUTHOR}`;
    }

    const hookCtxFile = path.join(ctlDir, `${req.role}-hook.json`);
    const callsFile = path.join(ctlDir, `${req.role}-calls.log`);
    fs.rmSync(callsFile, { force: true });
    const hookCtx: HookContext = { role: req.role, perms, policy: req.policy, denialsFile, callsFile };
    fs.writeFileSync(hookCtxFile, JSON.stringify(hookCtx));

    const restore = installHookFiles(req.cwd, hookCtxFile, req.runRoot);
    const model = req.model || this.opts.model;
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--trust",
      "--force",
      "--workspace", req.cwd,
      ...(model ? ["--model", model] : []),
      ...this.opts.extraArgs,
      `${req.persona}\n${ROLE_GUARDRAIL}\n\n${prompt}`,
    ];

    let text = "";
    let lastAssistant = "";
    let sessionId: string | undefined;
    let error: string | undefined;
    let ok = false;
    const models = new Set<string>();
    let toolCalls = 0;
    try {
      const r = await runStreaming(this.opts.bin, args, req.cwd, this.opts.timeoutMin * 60_000, (ev) => {
        switch (ev.type) {
          case "system":
            if (typeof ev.model === "string" && ev.model) models.add(`cursor:${ev.model}`);
            if (typeof ev.session_id === "string") sessionId = ev.session_id;
            break;
          case "assistant": {
            const t = contentText(ev.message);
            if (t) {
              lastAssistant = t;
              req.log.detail(`  │ ${t.replace(/\n/g, "\n  │ ")}`);
            }
            break;
          }
          case "tool_call":
            if (ev.subtype === "started") {
              toolCalls++;
              req.log.detail(`  │ → ${describeToolCall(ev.tool_call)}`);
            }
            break;
          case "result":
            sessionId = (ev.session_id as string) ?? sessionId;
            if (ev.is_error) error = String(ev.result ?? ev.subtype ?? "Cursor hata bildirdi");
            else {
              ok = true;
              text = typeof ev.result === "string" && ev.result ? ev.result : lastAssistant;
            }
            break;
        }
      });
      if (r.timedOut) {
        ok = false;
        error = `süre sınırı aşıldı (${this.opts.timeoutMin} dk)`;
      } else if (!ok && !error) {
        error = `Cursor CLI çıkış kodu ${r.code}${r.stderr.trim() ? ": " + r.stderr.trim().split("\n").slice(-3).join(" / ") : ""}`;
      }
    } finally {
      restore();
    }
    // Güvenlik ağı: araç çağrıldı ama hook hiç çalışmadıysa yetkiler zorlanmamış demektir
    const hookCalls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean).length : 0;
    if (toolCalls > 0 && hookCalls === 0) {
      ok = false;
      error = "Cursor hook'ları çalışmadı; rol yetkileri zorlanamadığı için sonuç kabul edilmedi (Cursor CLI'yi güncelle: cursor-agent update)";
    }

    const denials = readDenials(denialsFile);
    for (const d of denials) req.log.warn(`[${req.role}] reddedildi → ${d.tool}: ${d.input} (${d.reason})`);
    return { ok, text, costUsd: 0, sessionId, error, denials, models: [...models] };
  }
}

/** Hook dosyalarını yazar; dönen fonksiyon önceki hâli geri yükler. */
export function installHookFiles(wt: string, hookCtxFile: string, runRoot: string): () => void {
  const saved = HOOK_FILES.map((rel) => {
    const f = path.join(wt, rel);
    return { f, content: fs.existsSync(f) ? fs.readFileSync(f) : undefined };
  });
  const cursorDirExisted = fs.existsSync(path.join(wt, ".cursor"));
  fs.mkdirSync(path.join(wt, ".cursor"), { recursive: true });
  const hookScript = path.join(PACKAGE_ROOT, "dist", "src", "cursorhook.js");
  const command = `"${process.execPath}" "${hookScript}" "${hookCtxFile}"`;
  const hooks = Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ command, type: "command", timeout: 30, failClosed: true }]]));
  fs.writeFileSync(path.join(wt, ".cursor/hooks.json"), JSON.stringify({ version: 1, hooks }, null, 2));
  // Cursor'un kendi izin katmanı: web erişimi kapalı, run klasörü (plan, mutant) erişilebilir; asıl karar hook'ta
  fs.writeFileSync(
    path.join(wt, ".cursor/cli.json"),
    JSON.stringify({ permissions: { allow: [`Read(${runRoot}/**)`, `Write(${runRoot}/**)`], deny: ["WebFetch(*)"] } }, null, 2),
  );
  return () => {
    for (const s of saved) {
      if (s.content === undefined) fs.rmSync(s.f, { force: true });
      else fs.writeFileSync(s.f, s.content);
    }
    if (!cursorDirExisted) fs.rmSync(path.join(wt, ".cursor"), { recursive: true, force: true });
  };
}

function readDenials(file: string): Denial[] {
  if (!fs.existsSync(file)) return [];
  const seen = new Set<string>();
  const out: Denial[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line) as Denial;
      // aynı işlem hem preToolUse hem beforeShellExecution'da reddedilir; tek say
      const k = `${d.tool}\0${d.input}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(d);
    } catch {
      /* bozuk satır */
    }
  }
  return out;
}

function contentText(message: unknown): string {
  const m = message as { content?: unknown } | undefined;
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((b: { type?: string; text?: string }) => (b && b.type === "text" && b.text ? b.text : ""))
      .join("")
      .trim();
  }
  return "";
}

function describeToolCall(tc: unknown): string {
  if (!tc || typeof tc !== "object") return "araç";
  const [kind, body] = Object.entries(tc as Record<string, { args?: Record<string, unknown> }>)[0] ?? ["araç", {}];
  const a = body?.args ?? {};
  const detail = a.command ?? a.path ?? a.file_path ?? a.pattern ?? "";
  return `${kind.replace(/ToolCall$/, "")}${detail ? ": " + String(detail).slice(0, 120) : ""}`;
}

function runStreaming(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  onEvent: (ev: Record<string, unknown> & { type?: string; subtype?: string }) => void,
): Promise<{ code: number; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          onEvent(JSON.parse(line));
        } catch {
          /* JSON olmayan satır */
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr = (stderr + c).slice(-8000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stderr: String(e), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buf.trim()) {
        try {
          onEvent(JSON.parse(buf.trim()));
        } catch {
          /* yok say */
        }
      }
      resolve({ code: code ?? 1, stderr, timedOut });
    });
  });
}
