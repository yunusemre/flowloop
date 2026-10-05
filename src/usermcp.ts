import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Kullanıcının Claude Code'da tanımlı MCP sunucularını bulur (sadece kgflow.yaml'da
 * adı verilenler). Kaynaklar: ~/.claude.json (kullanıcı ve proje kapsamı) ve repodaki .mcp.json.
 */
export type McpConfig = Record<string, unknown>;

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function allUserMcpServers(repoRoot: string, home = os.homedir()): Record<string, McpConfig> {
  const out: Record<string, McpConfig> = {};
  const user = readJson(path.join(home, ".claude.json")) ?? {};
  Object.assign(out, user.mcpServers ?? {});
  const projects = user.projects ?? {};
  for (const key of [repoRoot, fs.existsSync(repoRoot) ? fs.realpathSync(repoRoot) : repoRoot]) {
    Object.assign(out, projects[key]?.mcpServers ?? {});
  }
  Object.assign(out, readJson(path.join(repoRoot, ".mcp.json"))?.mcpServers ?? {});
  return out;
}

/** "auto" → bu repo için tanımlı kod hafızası sunucuları */
export function expandServerNames(names: string[], repoRoot: string, home = os.homedir()): string[] {
  const out = names.flatMap((n) => (n === "auto" ? detectMemoryServers(repoRoot, home) : [n]));
  return [...new Set(out)];
}

export function loadMcpServers(names: string[], repoRoot: string, home = os.homedir()): { servers: Record<string, McpConfig>; missing: string[] } {
  names = expandServerNames(names, repoRoot, home);
  const all = allUserMcpServers(repoRoot, home);
  const servers: Record<string, McpConfig> = {};
  const missing: string[] = [];
  for (const n of names) {
    if (all[n]) servers[n] = all[n];
    else missing.push(n);
  }
  return { servers, missing };
}

/** Kod hafızası gibi görünen sunucular (claude-code-memory, qdrant memory vb.) */
export function detectMemoryServers(repoRoot: string, home = os.homedir()): string[] {
  const all = allUserMcpServers(repoRoot, home);
  return Object.entries(all)
    .filter(([name, cfg]) => /memory|qdrant/i.test(name + " " + JSON.stringify(cfg)))
    .map(([name]) => name);
}

export function userClaudeMdPath(home = os.homedir()): string {
  return path.join(home, ".claude", "CLAUDE.md");
}
