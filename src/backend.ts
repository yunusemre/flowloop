import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SdkAgentRunner, type AgentRunner } from "./agent.js";
import type { FlowloopConfig } from "./config.js";
import { CursorAgentRunner } from "./cursor.js";
import { getCredential } from "./secrets.js";

export type Backend = "claude" | "cursor";

function onPath(bin: string): string | undefined {
  const r = spawnSync("bash", ["-lc", `command -v ${bin}`], { encoding: "utf8" });
  const p = r.stdout.trim();
  return r.status === 0 && p ? p : undefined;
}

/** Claude Agent SDK'nın kullanabileceği bir kimlik var mı (API anahtarı ya da Claude Code girişi)? */
export function claudeAvailable(home = os.homedir(), env = process.env): boolean {
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN || env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX) return true;
  if (fs.existsSync(path.join(home, ".claude", ".credentials.json"))) return true;
  // macOS'ta Claude Code girişi anahtar zincirinde durur; ~/.claude.json girişin yapıldığını gösterir
  const cfg = path.join(home, ".claude.json");
  if (fs.existsSync(cfg)) {
    try {
      const j = JSON.parse(fs.readFileSync(cfg, "utf8")) as { oauthAccount?: unknown; primaryApiKey?: unknown };
      if (j.oauthAccount || j.primaryApiKey) return true;
    } catch {
      /* okunamadı */
    }
  }
  return false;
}

/** Cursor CLI'nin yolu: ayardaki bin → cursor-agent → agent (Cursor'a ait olduğu doğrulanır) */
export function findCursorBin(cfgBin = ""): string | undefined {
  if (cfgBin) return onPath(cfgBin) ?? (fs.existsSync(cfgBin) ? cfgBin : undefined);
  const ca = onPath("cursor-agent");
  if (ca) return ca;
  const a = onPath("agent");
  if (!a) return undefined;
  const h = spawnSync(a, ["--help"], { encoding: "utf8", timeout: 10_000 });
  return /cursor/i.test((h.stdout ?? "") + (h.stderr ?? "")) ? a : undefined;
}

export class BackendError extends Error {}

export function chooseBackend(cfg: FlowloopConfig, override?: string, home = os.homedir()): { backend: Backend; cursorBin?: string; reason: string } {
  const want = (override || cfg.agent) as "auto" | Backend;
  if (want === "claude") return { backend: "claude", reason: override ? "--agent claude" : "flowloop.yaml: agent: claude" };
  const cursorBin = findCursorBin(cfg.cursor.bin);
  if (want === "cursor") {
    if (!cursorBin) throw new BackendError("Cursor CLI bulunamadı. Kur: curl https://cursor.com/install -fsS | bash  (sonra: cursor-agent login)");
    return { backend: "cursor", cursorBin, reason: override ? "--agent cursor" : "flowloop.yaml: agent: cursor" };
  }
  if (claudeAvailable(home) || getCredential("ANTHROPIC_API_KEY") || getCredential("CLAUDE_CODE_OAUTH_TOKEN")) return { backend: "claude", reason: "Claude erişimi bulundu" };
  if (cursorBin) return { backend: "cursor", cursorBin, reason: "Claude erişimi yok, Cursor CLI bulundu" };
  throw new BackendError(
    "Ne Claude ne Cursor erişimi bulundu. Kurmak için: flowloop setup",
  );
}

export function createRunner(cfg: FlowloopConfig, override?: string): { runner: AgentRunner; backend: Backend; reason: string } {
  const c = chooseBackend(cfg, override);
  if (c.backend === "claude") return { runner: new SdkAgentRunner(), backend: "claude", reason: c.reason };
  return {
    runner: new CursorAgentRunner({ bin: c.cursorBin!, model: cfg.cursor.model, timeoutMin: cfg.cursor.timeoutMin, extraArgs: cfg.cursor.extraArgs }),
    backend: "cursor",
    reason: c.reason,
  };
}
