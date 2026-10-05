import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { FlowloopConfig } from "./config.js";
import { FLOWLOOP_DIR } from "./config.js";
import type { RolePermissions } from "./policy.js";

export type RoleName = "analist" | "developer" | "reviewer" | "committer";
export const ROLE_NAMES: RoleName[] = ["analist", "developer", "reviewer", "committer"];

export const MCP_SERVER = "flowloop";
export const MUTANT_TOOLS = [`mcp__${MCP_SERVER}__mutant_reset`, `mcp__${MCP_SERVER}__mutant_test`];

export interface RoleSpec {
  name: RoleName;
  persona: string;
  promptTemplate: string;
  perms: RolePermissions;
  model?: string;
  /** Şablonun nereden geldiği (yerleşik ya da proje override'ı) */
  source: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/src/roles.js → paket kökü iki üstte
export const PACKAGE_ROOT = path.resolve(here, "..", "..");
const BUILTIN_ROLES_DIR = path.join(PACKAGE_ROOT, "templates", "roles");

/**
 * Yapılandırmadaki bir komuttan izinli Bash önekini çıkarır: ilk yer
 * tutucuya kadar olan kısım. "npx jest --findRelatedTests {{files}}" →
 * "npx jest --findRelatedTests" (ajan sadece ilgili testleri koşabilir).
 */
export function commandPrefix(command: string): string {
  const cmd = command.trim();
  if (!cmd) return "";
  const idx = cmd.search(/\{\{/);
  return (idx >= 0 ? cmd.slice(0, idx) : cmd).trim().replace(/['"]$/, "").trim();
}

function prefixes(xs: string[]): string[] {
  return [...new Set(xs.map(commandPrefix).filter(Boolean))];
}

export function mcpToolNames(name: RoleName, cfg: FlowloopConfig): string[] {
  if (!cfg.mcp.roles.includes(name)) return [];
  return cfg.mcp.servers.flatMap((srv) => cfg.mcp.tools.map((t) => `mcp__${srv}__${t}`));
}

export function permissionsFor(name: RoleName, cfg: FlowloopConfig): RolePermissions {
  const p = basePermissions(name, cfg);
  return { ...p, tools: [...p.tools, ...mcpToolNames(name, cfg)] };
}

function basePermissions(name: RoleName, cfg: FlowloopConfig): RolePermissions {
  const c = cfg.commands;
  const extra = cfg.roles[name]?.extraBash ?? [];
  const readAll = ["**", "run:**"];
  const gitRead = ["git status", "git diff", "git log", "git show"];
  switch (name) {
    case "analist":
      return { tools: ["Read", "Glob", "Grep", "Edit", "Write"], read: readAll, edit: ["run:plan.md"], bash: [] };
    case "developer":
      return {
        tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "TodoWrite"],
        read: readAll,
        edit: [...cfg.paths.edit],
        // tip kontrolü developer'a açık değil: tüm proje çıktısı çok büyük; flowloop her turdan sonra yeni hataları kendisi raporlar
        bash: prefixes([c.testRelated, c.lint, c.format, "git status", "git diff", ...extra]),
      };
    case "reviewer": {
      const mut = cfg.mutation.enabled;
      return {
        tools: ["Read", "Glob", "Grep", "Bash", ...(mut ? ["Edit", ...MUTANT_TOOLS] : [])],
        read: readAll,
        edit: mut ? ["run:mutant/**"] : [],
        bash: prefixes([c.testRelated, c.typecheck, c.lint, ...gitRead, ...extra]),
      };
    }
    case "committer":
      return {
        tools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit"],
        read: readAll,
        edit: ["run:summary.md"],
        bash: prefixes([...gitRead, "git add", "git commit", ...extra]),
      };
  }
}

function parseRoleFile(file: string): { persona: string; body: string } {
  const text = fs.readFileSync(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file}: '---' ile başlayan frontmatter bekleniyor`);
  const fm = (parseYaml(m[1]) ?? {}) as { persona?: string };
  if (!fm.persona) throw new Error(`${file}: frontmatter'da 'persona' zorunlu`);
  return { persona: String(fm.persona).trim(), body: m[2].trim() };
}

export function loadRoles(root: string, cfg: FlowloopConfig): Record<RoleName, RoleSpec> {
  const out = {} as Record<RoleName, RoleSpec>;
  for (const name of ROLE_NAMES) {
    const override = path.join(root, FLOWLOOP_DIR, "roles", `${name}.md`);
    const file = fs.existsSync(override) ? override : path.join(BUILTIN_ROLES_DIR, `${name}.md`);
    const { persona, body } = parseRoleFile(file);
    out[name] = {
      name,
      persona,
      promptTemplate: body,
      perms: permissionsFor(name, cfg),
      model: cfg.roles[name]?.model || cfg.model || undefined,
      source: file === override ? path.relative(root, override) : "yerleşik",
    };
  }
  return out;
}

/**
 * Basit şablon: {{anahtar}} ve {{#anahtar}}...{{/anahtar}} (değer boş değilse göster).
 */
export function render(template: string, vars: Record<string, string | boolean | undefined>): string {
  let s = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}\n?/g, (_m, key: string, inner: string) =>
    vars[key] ? inner : "",
  );
  s = s.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return v === undefined || v === false ? "" : String(v);
  });
  return s.replace(/\n{3,}/g, "\n\n").trim();
}
