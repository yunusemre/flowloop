import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * flowloop'un gizli bilgileri (Jira token'ı, Anthropic anahtarı...).
 *
 * Saklama yeri:
 *   macOS  → Anahtar Zinciri (Keychain), servis adı "flowloop"
 *   Linux  → secret-tool (GNOME Keyring / KWallet) varsa o, yoksa ~/.flowloop/credentials.json (izin 600)
 *
 * Okuma sırası: ortam değişkeni → saklama yeri. Böylece eskiden ~/.zshrc'ye
 * yazılmış değişkenler çalışmaya devam eder.
 *
 * Gizli bilgiler ajanlara ortam değişkeni olarak GEÇMEZ (bkz. agentEnv).
 */
export const SECRET_NAMES = ["JIRA_API_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
export const PLAIN_NAMES = ["JIRA_EMAIL"] as const;
export type CredName = (typeof SECRET_NAMES)[number] | (typeof PLAIN_NAMES)[number];

const SERVICE = "flowloop";
/** Eski adla (kgflow) kaydedilmiş gizliler okunup yeni yere taşınır */
const LEGACY_SERVICE = "kgflow";

export interface SecretStore {
  readonly kind: string;
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): void;
}

class KeychainStore implements SecretStore {
  readonly kind = "macOS Anahtar Zinciri";
  constructor(private service = SERVICE) {}
  get(name: string) {
    const r = spawnSync("security", ["find-generic-password", "-s", this.service, "-a", name, "-w"], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.replace(/\n$/, "") || undefined : undefined;
  }
  set(name: string, value: string) {
    // -U: varsa güncelle
    const r = spawnSync("security", ["add-generic-password", "-U", "-s", this.service, "-a", name, "-l", `${this.service} ${name}`, "-w", value], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`Anahtar Zinciri'ne yazılamadı: ${r.stderr.trim()}`);
  }
  delete(name: string) {
    spawnSync("security", ["delete-generic-password", "-s", this.service, "-a", name], { encoding: "utf8" });
  }
}

class SecretToolStore implements SecretStore {
  readonly kind = "sistem anahtarlığı (secret-tool)";
  constructor(private service = SERVICE) {}
  get(name: string) {
    const r = spawnSync("secret-tool", ["lookup", "service", this.service, "account", name], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.replace(/\n$/, "") || undefined : undefined;
  }
  set(name: string, value: string) {
    // değer stdin'den verilir; komut satırında görünmez
    const r = spawnSync("secret-tool", ["store", "--label", `${this.service} ${name}`, "service", this.service, "account", name], { input: value, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`Anahtarlığa yazılamadı: ${r.stderr.trim()}`);
  }
  delete(name: string) {
    spawnSync("secret-tool", ["clear", "service", this.service, "account", name]);
  }
}

export class FileStore implements SecretStore {
  readonly kind: string;
  constructor(private file: string) {
    this.kind = `${file} (sadece sen okuyabilirsin)`;
  }
  private read(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }
  private write(d: Record<string, string>) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(d, null, 2), { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }
  get(name: string) {
    return this.read()[name] || undefined;
  }
  set(name: string, value: string) {
    this.write({ ...this.read(), [name]: value });
  }
  delete(name: string) {
    const d = this.read();
    delete d[name];
    this.write(d);
  }
}

function has(bin: string): boolean {
  return spawnSync("bash", ["-lc", `command -v ${bin}`], { encoding: "utf8" }).status === 0;
}

let cached: SecretStore | undefined;
export function defaultStore(home = os.homedir()): SecretStore {
  if (process.env.FLOWLOOP_SECRET_FILE) return new FileStore(process.env.FLOWLOOP_SECRET_FILE);
  if (cached) return cached;
  if (process.platform === "darwin" && has("security")) cached = new KeychainStore();
  else if (process.platform === "linux" && has("secret-tool") && process.env.DBUS_SESSION_BUS_ADDRESS) cached = new SecretToolStore();
  else cached = new FileStore(path.join(home, ".flowloop", "credentials.json"));
  return cached;
}

/** Eski adla (kgflow) saklanmış gizlilerin yeri */
export function legacyStore(home = os.homedir()): SecretStore | undefined {
  if (process.env.FLOWLOOP_SECRET_FILE) return undefined;
  if (process.platform === "darwin" && has("security")) return new KeychainStore(LEGACY_SERVICE);
  if (process.platform === "linux" && has("secret-tool") && process.env.DBUS_SESSION_BUS_ADDRESS) return new SecretToolStore(LEGACY_SERVICE);
  const f = path.join(home, ".kgflow", "credentials.json");
  return fs.existsSync(f) ? new FileStore(f) : undefined;
}

/** Ortam değişkeni → saklama yeri (eski adla saklanmışsa okunur ve yeni yere taşınır) */
export function getCredential(name: CredName, store: SecretStore = defaultStore(), env = process.env, legacy: SecretStore | undefined = store === cached ? legacyStore() : undefined): string | undefined {
  const v = env[name];
  if (v) return v;
  try {
    const cur = store.get(name);
    if (cur) return cur;
    const old = legacy?.get(name);
    if (old) {
      try {
        store.set(name, old);
      } catch {
        /* taşınamadı; yine de kullan */
      }
    }
    return old;
  } catch {
    return undefined;
  }
}

export function mask(v: string | undefined): string {
  if (!v) return "—";
  return v.length <= 8 ? "••••" : `${v.slice(0, 4)}…${v.slice(-4)}`;
}

/** Ajanlara ve kontrol komutlarına geçmemesi gereken değişken adları */
const SECRET_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL|_PAT$|^AWS_|^AZURE_|^GOOGLE_APPLICATION|^NPM_TOKEN|^GH_|^GITHUB_|^BITBUCKET_|^JIRA_)/i;

/**
 * Ajan süreçleri için ortam: gizli görünen her değişken çıkarılır. Sadece
 * ajanın kendi kimlik doğrulaması için gereken (allow) değişkenler eklenir.
 * Böylece ajanın yazdığı bir test ya da komut, Jira token'ını okuyamaz.
 */
export function scrubEnv(env: NodeJS.ProcessEnv, allow: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === "NODE_TEST_CONTEXT") continue;
    if (SECRET_PATTERN.test(k)) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(allow)) if (v) out[k] = v;
  return out;
}
