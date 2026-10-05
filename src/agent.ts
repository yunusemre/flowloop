import type { Logger } from "./log.js";
import { createMutantServer, type MutantSandbox } from "./mutant.js";
import { evaluate, rewriteAliasPaths, type PolicyContext, type RolePermissions } from "./policy.js";
import type { RoleName } from "./roles.js";

export interface AgentRequest {
  role: RoleName;
  persona: string;
  prompt: string;
  cwd: string;
  runRoot: string;
  perms: RolePermissions;
  policy: PolicyContext;
  model?: string;
  budgetUsd: number;
  isolation: boolean;
  claudeMd: boolean;
  mutant?: MutantSandbox;
  /** Kullanıcının MCP sunucularından bu role açılanlar (ör. kod hafızası) */
  extraMcpServers?: Record<string, unknown>;
  log: Logger;
}

export interface Denial {
  role: RoleName;
  tool: string;
  input: string;
  reason: string;
}

export interface AgentResult {
  ok: boolean;
  text: string;
  costUsd: number;
  sessionId?: string;
  error?: string;
  denials: Denial[];
  /** Bu oturumda gerçekten kullanılan model kimlikleri (SDK'nın raporladığı) */
  models?: string[];
}

/** Ajan çalıştırıcı soyutlaması: gerçek hâli SDK, testlerde sahte ajan. */
export interface AgentRunner {
  run(req: AgentRequest): Promise<AgentResult>;
}

export const ROLE_GUARDRAIL = `
Bu oturum otomatik bir ekip akışının parçası; soru soracak bir insan yok.
Yetkilerin kodla sınırlandırıldı. Reddedilen bir işlemi başka bir yoldan
(farklı araç, farklı komut biçimi, dolaylı script) yapmaya ÇALIŞMA; reddi ve
nedenini çıktında belirt. Bash komutları tek ve basit olmalı: &&, |, ;, >, $()
kullanma.`;

function summarizeInput(tool: string, input: Record<string, unknown>): string {
  if (tool === "Bash") return String(input.command ?? "");
  const p = input.file_path ?? input.path ?? input.notebook_path ?? input.pattern;
  return p ? String(p) : JSON.stringify(input).slice(0, 120);
}

export class SdkAgentRunner implements AgentRunner {
  async run(req: AgentRequest): Promise<AgentResult> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const denials: Denial[] = [];
    const decide = (tool: string, input: Record<string, unknown>) => {
      const d = evaluate(req.perms, req.policy, tool, input);
      if (!d.allow) {
        denials.push({ role: req.role, tool, input: summarizeInput(tool, input), reason: d.reason });
        req.log.warn(`[${req.role}] reddedildi → ${tool}: ${summarizeInput(tool, input)} (${d.reason})`);
      }
      return d;
    };

    const builtinTools = req.perms.tools.filter((t) => !t.startsWith("mcp__"));
    const mcpServers: Record<string, any> = { ...(req.extraMcpServers ?? {}) };
    if (req.mutant) mcpServers.kgflow = await createMutantServer(req.mutant);
    const settingSources: ("user" | "project" | "local")[] = req.isolation
      ? req.claudeMd
        ? ["project"]
        : []
      : ["user", "project", "local"];

    const q = query({
      prompt: req.prompt,
      options: {
        cwd: req.cwd,
        additionalDirectories: [req.runRoot],
        model: req.model,
        maxBudgetUsd: req.budgetUsd,
        permissionMode: "default",
        tools: builtinTools,
        mcpServers,
        strictMcpConfig: true, // sadece bizim verdiğimiz MCP sunucuları (kullanıcının diğer MCP'leri yüklenmez)
        settingSources,
        systemPrompt: { type: "preset", preset: "claude_code", append: `${req.persona}\n${ROLE_GUARDRAIL}` },
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "kgflow/0.1.0" },
        // 1. katman: HER araç çağrısı (okuma dahil) buradan geçer
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (input) => {
                  if (input.hook_event_name !== "PreToolUse") return {};
                  const original = (input.tool_input ?? {}) as Record<string, unknown>;
                  // kod hafızasının döndürdüğü asıl repo yollarını çalışma kopyasına çevir
                  const rewritten = rewriteAliasPaths(req.policy, original);
                  const d = decide(input.tool_name, rewritten ?? original);
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse" as const,
                      permissionDecision: d.allow ? ("allow" as const) : ("deny" as const),
                      permissionDecisionReason: d.allow ? "kgflow policy" : d.reason,
                      ...(d.allow && rewritten ? { updatedInput: rewritten } : {}),
                    },
                  };
                },
              ],
            },
          ],
        },
        // 2. katman: izin isteyen her şey yine aynı politikadan geçer; varsayılan RED
        canUseTool: async (tool, input) => {
          const fixed = rewriteAliasPaths(req.policy, input) ?? input;
          const d = decide(tool, fixed);
          return d.allow ? { behavior: "allow", updatedInput: fixed } : { behavior: "deny", message: d.reason };
        },
      },
    });

    let text = "";
    let cost = 0;
    let sessionId: string | undefined;
    let error: string | undefined;
    let ok = false;
    const models = new Set<string>();
    for await (const msg of q) {
      if (msg.type === "assistant") {
        if (msg.message.model && !msg.parent_tool_use_id) models.add(msg.message.model);
        for (const block of msg.message.content as Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>) {
          if (block.type === "text" && block.text) req.log.detail(`  │ ${block.text.replace(/\n/g, "\n  │ ")}`);
          if (block.type === "tool_use" && block.name) req.log.detail(`  │ → ${block.name}: ${summarizeInput(block.name, block.input ?? {})}`);
        }
      } else if (msg.type === "result") {
        cost = msg.total_cost_usd ?? 0;
        sessionId = msg.session_id;
        for (const m of Object.keys(msg.modelUsage ?? {})) models.add(m);
        if (msg.subtype === "success") {
          ok = true;
          text = msg.result;
        } else {
          error = `${msg.subtype}${msg.errors?.length ? ": " + msg.errors.join("; ") : ""}`;
        }
      }
    }
    return { ok, text, costUsd: cost, sessionId, error, denials, models: [...models] };
  }
}
