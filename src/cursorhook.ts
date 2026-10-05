#!/usr/bin/env node
/**
 * Cursor hook'u: Cursor her araç çağrısından önce bu betiği çalıştırır.
 * Girdi (stdin) Cursor'un hook JSON'u, argüman kgflow'un rol bağlamıdır.
 * Karar kgflow'un politikasıyla (evaluate) verilir. Bilinmeyen her şey reddedilir.
 *
 * Çıktı: {"permission":"allow"|"deny", ...}; red için çıkış kodu 2.
 */
import fs from "node:fs";
import path from "node:path";
import type { HookContext } from "./cursor.js";
import { evaluate, rewriteAliasPaths } from "./policy.js";

type Json = Record<string, unknown>;

/** Cursor hook olayını kgflow'un araç adına ve girdisine çevirir. */
export function mapCursorEvent(ev: Json): { tool: string; input: Json } | { deny: string } {
  const event = String(ev.hook_event_name ?? "");
  const cwd = typeof ev.cwd === "string" ? ev.cwd : Array.isArray(ev.workspace_roots) ? String(ev.workspace_roots[0] ?? "") : "";
  const abs = (p: unknown) => (typeof p === "string" && p ? (path.isAbsolute(p) || !cwd ? p : path.join(cwd, p)) : undefined);
  const pathOf = (o: Json) => abs(o.path ?? o.file_path ?? o.target_file ?? o.filePath ?? o.targetFile);

  if (event === "beforeShellExecution") return { tool: "Bash", input: { command: ev.command } };
  if (event === "beforeReadFile") return { tool: "Read", input: { file_path: abs(ev.file_path) } };
  if (event === "beforeMCPExecution") return { deny: `MCP aracı kapalı: ${String(ev.tool_name ?? "")}` };
  if (event !== "preToolUse") return { deny: `bilinmeyen hook olayı: ${event || "(yok)"}` };

  const name = String(ev.tool_name ?? "");
  const input = (ev.tool_input && typeof ev.tool_input === "object" ? ev.tool_input : {}) as Json;
  switch (name) {
    case "Shell":
      return { tool: "Bash", input: { command: input.command } };
    case "Read":
      return { tool: "Read", input: { file_path: pathOf(input) } };
    case "Write":
    case "Edit":
    case "StrReplace":
    case "Delete":
      return { tool: "Write", input: { file_path: pathOf(input) } };
    case "Grep":
    case "Glob":
    case "LS":
      return { tool: name === "Grep" ? "Grep" : "Glob", input: { path: pathOf(input) } };
    default:
      return { deny: `${name || "(adsız)"} aracı kgflow rollerinde kapalı` };
  }
}

export function decideCursor(ctx: HookContext, ev: Json): { allow: boolean; reason: string; tool: string; input: string } {
  const m = mapCursorEvent(ev);
  if ("deny" in m) return { allow: false, reason: m.deny, tool: String(ev.tool_name ?? ev.hook_event_name ?? "?"), input: "" };
  const input = rewriteAliasPaths(ctx.policy, m.input) ?? m.input;
  // Cursor'da tek yazma aracı var; rolün yazma aracı Edit ise (reviewer) onunla değerlendir
  const tool = m.tool === "Write" && !ctx.perms.tools.includes("Write") && ctx.perms.tools.includes("Edit") ? "Edit" : m.tool;
  const d = evaluate(ctx.perms, ctx.policy, tool, input);
  const shown = String(input.command ?? input.file_path ?? input.path ?? "");
  return { allow: d.allow, reason: d.allow ? "kgflow policy" : d.reason, tool, input: shown };
}

function main(): void {
  const ctxFile = process.argv[2];
  let ev: Json = {};
  try {
    ev = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    /* boş */
  }
  let out: { allow: boolean; reason: string; tool: string; input: string };
  let ctx: HookContext | undefined;
  try {
    ctx = JSON.parse(fs.readFileSync(ctxFile, "utf8")) as HookContext;
    out = decideCursor(ctx, ev);
    if (ctx.callsFile) fs.appendFileSync(ctx.callsFile, `${out.allow ? "allow" : "deny"} ${out.tool}\n`);
  } catch (e) {
    out = { allow: false, reason: `kgflow hook hatası: ${(e as Error).message}`, tool: "?", input: "" };
  }
  if (!out.allow) {
    if (ctx) {
      try {
        fs.appendFileSync(ctx.denialsFile, JSON.stringify({ role: ctx.role, tool: out.tool, input: out.input, reason: out.reason }) + "\n");
      } catch {
        /* kayıt yazılamadı; yine de reddet */
      }
    }
    process.stdout.write(JSON.stringify({ permission: "deny", user_message: out.reason, agent_message: `Reddedildi: ${out.reason}. Başka bir yoldan deneme.` }));
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ permission: "allow" }));
}

// sadece doğrudan çalıştırıldığında (testlerde import edilince değil)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main();
