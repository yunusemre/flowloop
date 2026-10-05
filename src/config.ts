import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const KGFLOW_DIR = ".kgflow";
/** Şirket Jira adresi (varsayılan). kgflow.yaml'daki jira.baseUrl ya da JIRA_BASE_URL ile değiştirilebilir. */
export const DEFAULT_JIRA_BASE = "https://kolaygelsin.atlassian.net";

/** Kullanılacak Jira adresi: kgflow.yaml → JIRA_BASE_URL → şirket varsayılanı */
export function jiraBaseUrl(cfg: { jira: { baseUrl: string } }): string {
  return (cfg.jira.baseUrl || process.env.JIRA_BASE_URL || DEFAULT_JIRA_BASE).trim().replace(/\/+$/, "");
}
export const DEFAULT_PROJECT_DOCS = ["CLAUDE.md", "AGENTS.md", ".cursorrules", ".cursor/rules/*.mdc", ".github/copilot-instructions.md", ".windsurfrules"];
export const CONFIG_FILE = path.join(KGFLOW_DIR, "kgflow.yaml");

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
    /** {{jira}}, {{slug}}, {{date}}. {{jira}} bulunamazsa "kgflow/{{slug}}-{{date}}" kullanılır. */
    branchName: z.string().default("kgflow/{{slug}}-{{date}}"),
    /** Jira entegrasyonu: `kgflow run IDT-1234` görev dosyasını Jira'dan üretir. */
    jira: z
      .object({
        /** Boş = JIRA_BASE_URL, o da yoksa şirket varsayılanı (DEFAULT_JIRA_BASE) */
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
        edit: z.array(z.string()).min(1),
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
    /** kgflow'e özel ek kurallar (opsiyonel). */
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
    /** Worktree ve çalıştırma dosyalarının yeri. Boş = ~/.kgflow/work */
    workDir: z.string().default(""),
  })
  .strict();

export type KgflowConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {}

export function loadConfig(root: string): KgflowConfig {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) throw new ConfigError(`${CONFIG_FILE} bulunamadı. Önce: kgflow init`);
  let raw: unknown;
  try {
    raw = parseYaml(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new ConfigError(`${CONFIG_FILE} geçerli YAML değil: ${(e as Error).message}`);
  }
  if (raw && typeof raw === "object" && (raw as { version?: unknown }).version === 1) {
    throw new ConfigError(`${CONFIG_FILE} eski sürüm (version: 1). Yeniden oluştur: kgflow init --force`);
  }
  const r = configSchema.safeParse(raw);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `  - ${i.path.join(".") || "(kök)"}: ${i.message}`).join("\n");
    throw new ConfigError(`${CONFIG_FILE} doğrulanamadı:\n${msg}`);
  }
  if (!/\{\{(files|testFiles)\}\}/.test(r.data.commands.testRelated)) {
    throw new ConfigError("commands.testRelated {{files}} ya da {{testFiles}} içermeli (sadece bu işin testleri çalışsın).");
  }
  for (const rf of r.data.rules) {
    if (!fs.existsSync(path.join(root, rf))) throw new ConfigError(`rules: ${rf} bulunamadı`);
  }
  return r.data;
}

export function workDirFor(cfg: KgflowConfig, root: string): string {
  const base = cfg.workDir ? path.resolve(root, cfg.workDir) : path.join(os.homedir(), ".kgflow", "work");
  return path.join(base, path.basename(root));
}

/** Eski adla (ekip) yapılmış çalıştırmaların yeri; resume/runs/clean onları da bulur. */
export function legacyWorkDirFor(cfg: KgflowConfig, root: string): string | undefined {
  return cfg.workDir ? undefined : path.join(os.homedir(), ".ekip", "work", path.basename(root));
}

export function workDirsFor(cfg: KgflowConfig, root: string): string[] {
  return [workDirFor(cfg, root), legacyWorkDirFor(cfg, root)].filter((d): d is string => !!d && fs.existsSync(d));
}

/**
 * .kgflow/ klasörünü projenin .gitignore'una ekler (dosya yoksa oluşturur).
 * Eski ".ekip" satırı varsa yerinde ".kgflow/" olarak değiştirir.
 * Dönüş: "created" | "added" | "renamed" | "exists"
 */
export function ensureGitignore(root: string): "created" | "added" | "renamed" | "exists" {
  const file = path.join(root, ".gitignore");
  const entry = `${KGFLOW_DIR}/`;
  const matches = (l: string, dir: string) => new RegExp(`^/?${dir.replace(".", "\\.")}/?(\\*\\*)?$`).test(l.trim());
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# kgflow (AI geliştirme akışı) yerel dosyaları\n${entry}\n`);
    return "created";
  }
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  if (lines.some((l) => matches(l, KGFLOW_DIR))) return "exists";
  const legacy = lines.findIndex((l) => matches(l, ".ekip"));
  if (legacy >= 0) {
    lines[legacy] = entry;
    fs.writeFileSync(file, lines.join("\n"));
    return "renamed";
  }
  fs.writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}\n# kgflow (AI geliştirme akışı) yerel dosyaları\n${entry}\n`);
  return "added";
}

/**
 * Proje eski adla (.ekip/ekip.yaml) kurulmuşsa .kgflow/kgflow.yaml'a taşır.
 * Sadece kgflow'un kendi klasörüne dokunur. Taşındıysa true döner.
 */
export function migrateLegacyProject(root: string): boolean {
  const legacy = path.join(root, ".ekip");
  const dir = path.join(root, KGFLOW_DIR);
  if (fs.existsSync(dir) || !fs.existsSync(legacy)) return false;
  fs.renameSync(legacy, dir);
  const oldYaml = path.join(dir, "ekip.yaml");
  if (fs.existsSync(oldYaml) && !fs.existsSync(path.join(root, CONFIG_FILE))) fs.renameSync(oldYaml, path.join(root, CONFIG_FILE));
  return true;
}
