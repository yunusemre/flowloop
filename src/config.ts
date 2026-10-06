import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const FLOWLOOP_DIR = ".flowloop";

/** Kullanıcı ayarları (tüm projeler için): ~/.flowloop/config.json — flowloop setup yazar */
export interface UserConfig {
  jiraBaseUrl?: string;
}
export function userConfigFile(home = os.homedir()): string {
  return path.join(home, ".flowloop", "config.json");
}
export function readUserConfig(home = os.homedir()): UserConfig {
  // eski adla (kgflow) yazılmış ayar da okunur
  for (const f of [userConfigFile(home), path.join(home, ".kgflow", "config.json")]) {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8")) as UserConfig;
    } catch {
      /* sıradaki */
    }
  }
  return {};
}
export function writeUserConfig(patch: UserConfig, home = os.homedir()): void {
  const f = userConfigFile(home);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ...readUserConfig(home), ...patch }, null, 2) + "\n");
}

/**
 * Kullanıcının yazdığını Jira adresine çevirir:
 *   "sirket"                                   → https://sirket.atlassian.net
 *   "sirket.atlassian.net"                     → https://sirket.atlassian.net
 *   "https://sirket.atlassian.net/browse/X-1"  → https://sirket.atlassian.net
 * Geçersizse "" döner.
 */
export function normalizeJiraBase(input: string): string {
  let s = input.trim();
  if (!s) return "";
  if (/^[a-z0-9][a-z0-9-]*$/i.test(s)) s = `${s}.atlassian.net`;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return u.hostname.includes(".") ? `${u.protocol}//${u.host}` : "";
  } catch {
    return "";
  }
}

/** Jira kayıt bağlantısından adres ve anahtar: .../browse/PROJ-1, ...?selectedIssue=PROJ-1 */
export function parseJiraLink(s: string): { base: string; key: string } | undefined {
  if (!/^https?:\/\//i.test(s.trim())) return undefined;
  let u: URL;
  try {
    u = new URL(s.trim());
  } catch {
    return undefined;
  }
  const key = /\/browse\/([A-Z][A-Z0-9]+-\d+)/.exec(u.pathname)?.[1] ?? u.searchParams.get("selectedIssue") ?? /\/issues\/([A-Z][A-Z0-9]+-\d+)/.exec(u.pathname)?.[1];
  if (!key || !/^[A-Z][A-Z0-9]+-\d+$/.test(key)) return undefined;
  return { base: `${u.protocol}//${u.host}`, key };
}

/**
 * Kullanılacak Jira adresi: flowloop.yaml (jira.baseUrl) → JIRA_BASE_URL → flowloop setup'ta girilen adres.
 * Hiçbiri yoksa "" (flowloop setup ile girilmesi istenir).
 */
export function jiraBaseUrl(cfg: { jira: { baseUrl: string } }, home = os.homedir()): string {
  const v = cfg.jira.baseUrl || process.env.JIRA_BASE_URL || readUserConfig(home).jiraBaseUrl || "";
  return normalizeJiraBase(v) || v.trim().replace(/\/+$/, "");
}

/** Projeden bağımsız Jira adresi (setup için): JIRA_BASE_URL → kullanıcı ayarı */
export function globalJiraBase(home = os.homedir()): string {
  return normalizeJiraBase(process.env.JIRA_BASE_URL || readUserConfig(home).jiraBaseUrl || "");
}
export const DEFAULT_PROJECT_DOCS = ["CLAUDE.md", "AGENTS.md", ".cursorrules", ".cursor/rules/*.mdc", ".github/copilot-instructions.md", ".windsurfrules"];
export const CONFIG_FILE = path.join(FLOWLOOP_DIR, "flowloop.yaml");

const roleOverride = z
  .object({
    model: z.string().optional(),
    /** Ek bash komut önekleri (ör. developer için "npx expo-doctor") */
    extraBash: z.array(z.string()).default([]),
  })
  .strict();

/**
 * Komutlarda kullanılabilen yer tutucular:
 *   {{files}}     → bu işte değişen (silinmemiş) dosyalar
 *   {{testFiles}} → değişen dosyalardan test olanlar
 * Typecheck ve lint için SADECE bu işin getirdiği YENİ hatalar sayılır; projede
 * zaten var olan hatalar kimseyi bloklamaz.
 */
export const configSchema = z
  .object({
    version: z.literal(2),
    /** Bilgi amaçlı; teknoloji özeti `tech` alanındadır. */
    stack: z.string().default("other"),
    /** Boş = otomatik: production → main → master (önce origin/...) */
    baseBranch: z.string().default(""),
    /** {{jira}}, {{slug}}, {{date}}. {{jira}} bulunamazsa "flowloop/{{slug}}-{{date}}" kullanılır. */
    branchName: z.string().default("flowloop/{{slug}}-{{date}}"),
    /** Jira entegrasyonu: `flowloop run PROJ-1234` görev dosyasını Jira'dan üretir. */
    jira: z
      .object({
        /** Boş = JIRA_BASE_URL, o da yoksa flowloop setup'ta girilen adres (~/.flowloop/config.json) */
        baseUrl: z.string().default(""),
        /** İş bitince Jira kaydına kısa özet yorumu ekle (sorun / yapılan / neden + branch, commit, PR). */
        comment: z.boolean().default(true),
      })
      .strict()
      .default({ baseUrl: "", comment: true }),
    /** İş bitince branch'i origin'e push'la (asla force push yapılmaz). */
    push: z.boolean().default(false),
    /** Başlamadan önce origin'den base branch'i çek. */
    fetch: z.boolean().default(true),
    commands: z
      .object({
        /** Worktree'de bağımlılık kurulumu. Boşsa linkDirs ile repodaki klasörler bağlanır. */
        install: z.string().default(""),
        /** Bu işin testleri. {{files}} ya da {{testFiles}} içermeli. */
        testRelated: z.string().min(1, "commands.testRelated zorunlu"),
        /** Tüm projenin tip kontrolü; sadece yeni hatalar sayılır. */
        typecheck: z.string().default(""),
        /** {{files}} ile; sadece yeni hatalar sayılır. */
        lint: z.string().default(""),
        /** {{files}} ile; her developer turundan sonra otomatik çalışır. */
        format: z.string().default(""),
        /** Boşsa yerleşik Conventional Commits kontrolü. {{base}} desteklenir. */
        commitCheck: z.string().default(""),
      })
      .strict(),
    /** Repodan worktree'lere symlink ile bağlanan (gitignore'daki) klasörler. */
    linkDirs: z.array(z.string()).default([]),
    paths: z
      .object({
        // boş bırakılırsa (YAML'da null) anlaşılır bir mesaj ver
        edit: z.preprocess(
          (v) => v ?? [],
          z.array(z.string()).min(1, `boş olamaz. Developer'ın değiştirebileceği yolları yaz, ör:\n      edit:\n        - "src/**"\n    (ya da "flowloop init --force" ile yeniden algılat)`),
        ),
        readDeny: z.array(z.string()).default([]),
      })
      .strict(),
    /** Projenin mevcut AI/kodlama kuralları; bulunanlar otomatik dahil edilir. */
    projectDocs: z
      .array(z.string())
      .default(DEFAULT_PROJECT_DOCS),
    /** Kişisel ~/.claude/CLAUDE.md dosyası da kurallara eklensin mi (proje kuralı önceliklidir). */
    userClaudeMd: z.boolean().default(true),
    /**
     * Kullanıcının Claude Code'da tanımlı MCP sunucularından ajanlara açılacaklar
     * (ör. claude-code-memory). Sadece `tools` listesindeki araçlar ve `roles` için.
     */
    mcp: z
      .object({
        /** Sunucu adları; "auto" = ~/.claude.json'da bu repo için tanımlı kod hafızası sunucuları */
        servers: z.array(z.string()).default(["auto"]),
        tools: z.array(z.string()).default(["search_similar", "read_graph", "get_implementation"]),
        roles: z.array(z.enum(["analist", "developer", "reviewer", "committer"])).default(["analist", "developer", "reviewer"]),
      })
      .strict()
      .default({ servers: ["auto"], tools: ["search_similar", "read_graph", "get_implementation"], roles: ["analist", "developer", "reviewer"] }),
    /**
     * Bu projenin bağımlı olduğu diğer repolar (ör. backend). Ajanlar hepsini okuyabilir;
     * edit verilen yollar developer tarafından değiştirilebilir. Değişiklik olursa o repoda da
     * aynı adla branch açılır, commit'lenir, push'lanır ve PR bağlantısı verilir.
     */
    related: z
      .array(
        z
          .object({
            /** Kısa ad (ör. cure-backend); yollarda "@ad:" olarak görünür */
            name: z.string().regex(/^[A-Za-z0-9._-]+$/, "sadece harf, rakam, . _ -"),
            /** Bilgisayardaki repo yolu; bu projeye göre göreli olabilir (ör. ../cure-backend) */
            path: z.string().min(1),
            /** Developer'ın değiştirebileceği yollar; boş = sadece okunur */
            edit: z.array(z.string()).default([]),
            /** Boş = o reponun flowloop.yaml'ı, o da yoksa production → main → master */
            baseBranch: z.string().default(""),
          })
          .strict(),
      )
      .default([]),
    /** flowloop'e özel ek kurallar (opsiyonel). */
    rules: z.array(z.string()).default([]),
    /** Teknoloji özeti; init tarafından üretilir, düzenlenebilir. Tüm rollere verilir. */
    tech: z.string().default(""),
    mutation: z
      .object({
        enabled: z.boolean().default(true),
        testTimeoutSec: z.number().int().positive().default(300),
      })
      .strict()
      .default({ enabled: true, testTimeoutSec: 300 }),
    budgets: z
      .object({
        analist: z.number().positive().default(1),
        gelistir: z.number().positive().default(4),
        commit: z.number().positive().default(0.5),
        total: z.number().positive().default(6),
      })
      .strict()
      .default({ analist: 1, gelistir: 4, commit: 0.5, total: 6 }),
    maxIterations: z.number().int().min(1).max(10).default(3),
    model: z.string().default(""),
    roles: z
      .object({
        analist: roleOverride.optional(),
        developer: roleOverride.optional(),
        reviewer: roleOverride.optional(),
        committer: roleOverride.optional(),
      })
      .strict()
      .default({}),
    /** true: kullanıcının Claude ayarları, plugin, skill ve MCP'leri yüklenmez (önerilen). */
    isolation: z.boolean().default(true),
    /**
     * Ajanları çalıştıran araç:
     *   auto   → Claude erişimi varsa Claude (Agent SDK), yoksa Cursor CLI
     *   claude → Claude Agent SDK
     *   cursor → Cursor CLI (agent / cursor-agent)
     */
    agent: z.enum(["auto", "claude", "cursor"]).default("auto"),
    cursor: z
      .object({
        /** Boş = PATH'te cursor-agent, yoksa agent */
        bin: z.string().default(""),
        /** Boş = Cursor'un varsayılan modeli. roles.<rol>.model de kullanılabilir. */
        model: z.string().default(""),
        /** Rol başına süre sınırı (Cursor maliyet bildirmediği için bütçe yerine süre sınırlanır) */
        timeoutMin: z.number().positive().default(30),
        /** Cursor CLI'ye eklenecek ek argümanlar */
        extraArgs: z.array(z.string()).default([]),
      })
      .strict()
      .default({ bin: "", model: "", timeoutMin: 30, extraArgs: [] }),
    /** Worktree ve çalıştırma dosyalarının yeri. Boş = ~/.flowloop/work */
    workDir: z.string().default(""),
  })
  .strict();

export type FlowloopConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {}

export function loadConfig(root: string): FlowloopConfig {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) throw new ConfigError(`${CONFIG_FILE} bulunamadı. Önce: flowloop init`);
  let raw: unknown;
  try {
    raw = parseYaml(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new ConfigError(`${CONFIG_FILE} geçerli YAML değil: ${(e as Error).message}`);
  }
  if (raw && typeof raw === "object" && (raw as { version?: unknown }).version === 1) {
    throw new ConfigError(`${CONFIG_FILE} eski sürüm (version: 1). Yeniden oluştur: flowloop init --force`);
  }
  const r = configSchema.safeParse(raw);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `  - ${i.path.join(".") || "(kök)"}: ${i.message}`).join("\n");
    throw new ConfigError(`${CONFIG_FILE} doğrulanamadı:\n${msg}`);
  }
  if (!/\{\{(files|testFiles)\}\}/.test(r.data.commands.testRelated)) {
    throw new ConfigError("commands.testRelated {{files}} ya da {{testFiles}} içermeli (sadece bu işin testleri çalışsın).");
  }
  const names = new Set<string>();
  for (const rel of r.data.related) {
    if (names.has(rel.name)) throw new ConfigError(`related: "${rel.name}" adı birden fazla kez kullanılmış`);
    names.add(rel.name);
    const p = path.resolve(root, rel.path.replace(/^~(?=\/|$)/, os.homedir()));
    if (!fs.existsSync(path.join(p, ".git"))) throw new ConfigError(`related.${rel.name}: ${rel.path} bir git reposu değil (${p})`);
  }
  for (const rf of r.data.rules) {
    if (!fs.existsSync(path.join(root, rf))) throw new ConfigError(`rules: ${rf} bulunamadı`);
  }
  return r.data;
}

/** related.path'i mutlak yola çevirir (~ ve göreli yollar desteklenir) */
export function relatedPath(root: string, p: string): string {
  return path.resolve(root, p.replace(/^~(?=\/|$)/, os.homedir()));
}

export function workDirFor(cfg: FlowloopConfig, root: string): string {
  const base = cfg.workDir ? path.resolve(root, cfg.workDir) : path.join(os.homedir(), ".flowloop", "work");
  return path.join(base, path.basename(root));
}

/** Eski adlarla (kgflow, ekip) kullanılan klasör adları; eski kayıtlar bulunmaya devam eder. */
export const LEGACY_NAMES = ["kgflow", "ekip"] as const;

/** Eski adlarla yapılmış çalıştırmaların yerleri; resume/runs/clean onları da bulur. */
export function legacyWorkDirsFor(cfg: FlowloopConfig, root: string): string[] {
  return cfg.workDir ? [] : LEGACY_NAMES.map((n) => path.join(os.homedir(), `.${n}`, "work", path.basename(root)));
}

export function workDirsFor(cfg: FlowloopConfig, root: string): string[] {
  return [workDirFor(cfg, root), ...legacyWorkDirsFor(cfg, root)].filter((d) => fs.existsSync(d));
}

/**
 * .flowloop/ klasörünü projenin .gitignore'una ekler (dosya yoksa oluşturur).
 * Eski ".kgflow" / ".ekip" satırı varsa yerinde ".flowloop/" olarak değiştirir.
 * Dönüş: "created" | "added" | "renamed" | "exists"
 */
export function ensureGitignore(root: string): "created" | "added" | "renamed" | "exists" {
  const file = path.join(root, ".gitignore");
  const entry = `${FLOWLOOP_DIR}/`;
  const matches = (l: string, dir: string) => new RegExp(`^/?${dir.replace(".", "\\.")}/?(\\*\\*)?$`).test(l.trim());
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# flowloop (AI geliştirme akışı) yerel dosyaları\n${entry}\n`);
    return "created";
  }
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  if (lines.some((l) => matches(l, FLOWLOOP_DIR))) return "exists";
  const legacy = lines.findIndex((l) => LEGACY_NAMES.some((n) => matches(l, `.${n}`)));
  if (legacy >= 0) {
    lines[legacy] = entry;
    fs.writeFileSync(file, lines.join("\n"));
    return "renamed";
  }
  fs.writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}\n# flowloop (AI geliştirme akışı) yerel dosyaları\n${entry}\n`);
  return "added";
}

/**
 * Proje eski adla (.kgflow/kgflow.yaml ya da .ekip/ekip.yaml) kurulmuşsa .flowloop/flowloop.yaml'a taşır.
 * Sadece flowloop'un kendi klasörüne dokunur. Taşındıysa eski adı döner.
 */
export function migrateLegacyProject(root: string): string | undefined {
  const dir = path.join(root, FLOWLOOP_DIR);
  if (fs.existsSync(dir)) return undefined;
  for (const n of LEGACY_NAMES) {
    const legacy = path.join(root, `.${n}`);
    if (!fs.existsSync(legacy)) continue;
    fs.renameSync(legacy, dir);
    const oldYaml = path.join(dir, `${n}.yaml`);
    if (fs.existsSync(oldYaml) && !fs.existsSync(path.join(root, CONFIG_FILE))) fs.renameSync(oldYaml, path.join(root, CONFIG_FILE));
    return n;
  }
  return undefined;
}
