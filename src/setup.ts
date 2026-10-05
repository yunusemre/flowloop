import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeAvailable, findCursorBin } from "./backend.js";
import { DEFAULT_JIRA_BASE, globalJiraBase, normalizeJiraBase, writeUserConfig } from "./config.js";
import { color } from "./log.js";
import { defaultStore, getCredential, mask, type SecretStore } from "./secrets.js";

/**
 * flowloop setup: kullanıcının hesap bilgilerini adım adım toplar, her birinin
 * nereden alınacağını gösterir, doğrular ve güvenli yerde saklar.
 *
 *   1) Kimlik (git kullanıcı adı / e-posta) → commit'lerde "Başlatan" olarak görünür
 *   2) AI erişimi: Claude aboneliği (claude setup-token) | Anthropic API anahtarı | Cursor CLI
 *   3) Jira: e-posta + API token (doğrulanır, kim olduğun gösterilir)
 *   4) Bitbucket SSH erişimi (push için)
 *
 * Gizli bilgiler ekrana yazılmaz, komut geçmişine girmez ve ajanlara geçmez.
 */
export interface SetupIO {
  log(s: string): void;
  ask(q: string, def?: string): Promise<string>;
  secret(q: string): Promise<string>;
  confirm(q: string, def?: boolean): Promise<boolean>;
  choose(q: string, options: string[]): Promise<number>;
  open(url: string): void;
  /** Kullanıcının bir işi bitirmesini bekler (Enter) */
  pause(msg: string): Promise<void>;
}

export interface CmdResult {
  code: number;
  out: string;
}

export interface SetupDeps {
  store: SecretStore;
  home: string;
  fetchFn: (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number; json(): Promise<any> }>;
  /** Komutu çalıştırır; interactive=true ise terminali komuta bırakır */
  run(cmd: string, args: string[], opts?: { interactive?: boolean; timeoutMs?: number }): CmdResult;
  which(bin: string): string | undefined;
  /** Kayıtlı Jira adresi ("" = henüz girilmedi) */
  jiraBase: string;
  /** Jira adresini kullanıcı ayarına yazar (~/.flowloop/config.json) */
  saveJiraBase(base: string): void;
}

export const LINKS = {
  jiraToken: "https://id.atlassian.com/manage-profile/security/api-tokens",
  anthropicKeys: "https://console.anthropic.com/settings/keys",
  bitbucketSsh: "https://bitbucket.org/account/settings/ssh-keys/",
  cursorInstall: "https://cursor.com/cli",
};

export interface SetupStatus {
  git: { name?: string; email?: string };
  ai: { claude: boolean; claudeAccount?: string; claudeVia?: string; cursor?: string };
  jira: { email?: string; token?: string };
  ssh?: { ok: boolean; user?: string };
}

const ok = (s: string) => color.green("✓ ") + s;
const warn = (s: string) => color.yellow("! ") + s;
const head = (s: string) => "\n" + color.bold(s);

function gitConfig(deps: SetupDeps, key: string): string | undefined {
  const r = deps.run("git", ["config", "--global", key]);
  return r.code === 0 && r.out.trim() ? r.out.trim() : undefined;
}

function claudeAccount(home: string): string | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    return j.oauthAccount?.emailAddress ?? undefined;
  } catch {
    return undefined;
  }
}

export function setupStatus(deps: SetupDeps): SetupStatus {
  const apiKey = getCredential("ANTHROPIC_API_KEY", deps.store);
  const oauth = getCredential("CLAUDE_CODE_OAUTH_TOKEN", deps.store);
  const login = claudeAvailable(deps.home, {});
  return {
    git: { name: gitConfig(deps, "user.name"), email: gitConfig(deps, "user.email") },
    ai: {
      claude: !!(apiKey || oauth || login),
      claudeVia: apiKey ? "Anthropic API anahtarı" : oauth ? "Claude aboneliği (token)" : login ? "Claude Code girişi" : undefined,
      claudeAccount: claudeAccount(deps.home),
      cursor: deps.which("cursor-agent"),
    },
    jira: { email: getCredential("JIRA_EMAIL", deps.store), token: getCredential("JIRA_API_TOKEN", deps.store) },
  };
}

export async function jiraWhoAmI(deps: SetupDeps, email: string, token: string): Promise<{ ok: true; name: string } | { ok: false; status: number }> {
  try {
    const r = await deps.fetchFn(`${deps.jiraBase}/rest/api/3/myself`, {
      headers: { Authorization: "Basic " + Buffer.from(`${email}:${token}`).toString("base64"), Accept: "application/json" },
    });
    if (r.status !== 200) return { ok: false, status: r.status };
    const j = await r.json();
    return { ok: true, name: String(j.displayName ?? j.emailAddress ?? email) };
  } catch {
    return { ok: false, status: 0 };
  }
}

async function anthropicKeyValid(deps: SetupDeps, key: string): Promise<number> {
  try {
    const r = await deps.fetchFn("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
    return r.status;
  } catch {
    return 0;
  }
}

function sshBitbucket(deps: SetupDeps): { ok: boolean; user?: string } {
  const r = deps.run("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", "git@bitbucket.org"], { timeoutMs: 15_000 });
  const m = /logged in as (\S+)|authenticated via ssh key/i.exec(r.out);
  return m ? { ok: true, user: m[1]?.replace(/\.$/, "") } : { ok: false };
}

/** Sadece durum (soru sormaz): flowloop setup --check ve flowloop check için */
export async function printStatus(deps: SetupDeps, io: Pick<SetupIO, "log">, opts: { network?: boolean } = {}): Promise<boolean> {
  const s = setupStatus(deps);
  io.log(head("Hesaplar"));
  io.log(s.git.name && s.git.email ? ok(`git kimliği: ${s.git.name} <${s.git.email}>`) : warn("git kimliği eksik (git config --global user.name / user.email)"));
  if (s.ai.claude) io.log(ok(`Claude: ${s.ai.claudeVia}${s.ai.claudeAccount ? ` (${s.ai.claudeAccount})` : ""}`));
  else io.log(warn("Claude erişimi yok"));
  io.log(s.ai.cursor ? ok(`Cursor CLI: ${s.ai.cursor}`) : color.dim("  Cursor CLI: kurulu değil (isteğe bağlı)"));
  io.log(deps.jiraBase ? ok(`Jira adresi: ${deps.jiraBase}`) : warn("Jira adresi tanımlı değil (flowloop setup)"));
  if (s.jira.email && s.jira.token && deps.jiraBase) {
    if (opts.network) {
      const w = await jiraWhoAmI(deps, s.jira.email, s.jira.token);
      io.log(w.ok ? ok(`Jira: ${w.name} <${s.jira.email}>`) : warn(`Jira: token geçersiz (HTTP ${w.status || "bağlantı yok"}) — flowloop setup`));
    } else io.log(ok(`Jira: ${s.jira.email} · token ${mask(s.jira.token)}`));
  } else io.log(warn("Jira bilgisi yok (flowloop run IDT-xxxx için gerekli)"));
  if (opts.network) {
    const ssh = sshBitbucket(deps);
    io.log(ssh.ok ? ok(`Bitbucket SSH${ssh.user ? `: ${ssh.user}` : ""}`) : warn("Bitbucket SSH erişimi yok (push için gerekli)"));
  }
  io.log(color.dim(`  Gizli bilgilerin saklandığı yer: ${deps.store.kind}`));
  return !!(s.git.email && (s.ai.claude || s.ai.cursor) && s.jira.token && deps.jiraBase);
}

export async function runSetup(io: SetupIO, deps: SetupDeps, opts: { force?: boolean } = {}): Promise<void> {
  const s = setupStatus(deps);
  io.log(color.bold("flowloop kurulumu — hesap bilgileri"));
  io.log(color.dim(`Gizli bilgiler ekrana yazılmaz ve ${deps.store.kind} içinde saklanır. Ajanlara asla verilmez.`));

  // ───────────── 1) Kimlik ─────────────
  io.log(head("1/4 Kimlik"));
  io.log(color.dim("Commit'lerde ve Jira yorumunda işi kimin başlattığı olarak görünür."));
  let { name, email } = s.git;
  if (name && email && !opts.force) io.log(ok(`${name} <${email}>`));
  else {
    name = await io.ask("Ad Soyad", name);
    email = await io.ask("İş e-postan", email);
    if (name && email && (await io.confirm(`git'e kaydedilsin mi? (git config --global user.name/user.email)`, true))) {
      deps.run("git", ["config", "--global", "user.name", name]);
      deps.run("git", ["config", "--global", "user.email", email]);
      io.log(ok("git kimliği kaydedildi"));
    }
  }

  // ───────────── 2) AI erişimi ─────────────
  io.log(head("2/4 AI erişimi"));
  if (s.ai.claude && !opts.force) io.log(ok(`Claude: ${s.ai.claudeVia}${s.ai.claudeAccount ? ` (${s.ai.claudeAccount})` : ""}`));
  else if (s.ai.cursor && !opts.force) io.log(ok(`Cursor CLI: ${s.ai.cursor} (Claude erişimi yok; ajanlar Cursor ile çalışacak)`));
  else await setupAi(io, deps);

  // ───────────── 3) Jira ─────────────
  io.log(head("3/4 Jira"));
  io.log(color.dim("Görevi Jira'dan çekmek ve iş bitince yorum yazmak için."));
  await setupJiraBase(io, deps, opts.force);
  await setupJira(io, deps, email, opts.force);

  // ───────────── 4) Bitbucket SSH ─────────────
  io.log(head("4/4 Bitbucket erişimi"));
  io.log(color.dim("Branch'leri push'lamak ve flowloop'u güncellemek için."));
  await setupSsh(io, deps);

  io.log(head("Özet"));
  const ready = await printStatus(deps, io);
  io.log(ready ? "\n" + ok("Hazırsın. Projende: flowloop init && flowloop run IDT-1234 --plan-onayi -v") : "\n" + warn("Eksikleri tamamlamak için istediğin zaman: flowloop setup"));
}

async function setupAi(io: SetupIO, deps: SetupDeps): Promise<void> {
  const choice = await io.choose("Ajanlar hangi hesapla çalışsın?", [
    "Claude aboneliğim (Pro/Max/Team) — Claude Code ile giriş yap",
    "Anthropic API anahtarı (console.anthropic.com, kullanım başına ücret)",
    "Cursor (Claude yoksa; Cursor aboneliğin kullanılır)",
    "Şimdilik geç",
  ]);
  if (choice === 0) {
    if (!deps.which("claude")) {
      io.log(warn("Claude Code kurulu değil."));
      if (!(await io.confirm("Kurulsun mu? (npm install -g @anthropic-ai/claude-code)", true))) return;
      const r = deps.run("npm", ["install", "-g", "@anthropic-ai/claude-code"], { interactive: true });
      if (r.code !== 0) return io.log(warn("Kurulamadı. Elle kur: npm install -g @anthropic-ai/claude-code"));
    }
    io.log("Şimdi Claude Code tarayıcıda giriş sayfasını açacak. Giriş yapınca terminalde uzun bir token görünecek;");
    io.log("o token'ı kopyala ve buraya yapıştır.");
    await io.pause("Hazır olunca Enter'a bas");
    deps.run("claude", ["setup-token"], { interactive: true });
    for (let i = 0; i < 3; i++) {
      const t = (await io.secret("Token'ı yapıştır (sk-ant-oat...)")).trim();
      if (!t) return io.log(warn("Atlandı."));
      if (!/^sk-ant-/.test(t)) {
        io.log(warn("Bu bir Claude token'ına benzemiyor (sk-ant- ile başlamalı). Tekrar dene."));
        continue;
      }
      deps.store.set("CLAUDE_CODE_OAUTH_TOKEN", t);
      return io.log(ok("Claude token'ı kaydedildi"));
    }
  } else if (choice === 1) {
    io.log(`API anahtarı oluştur: ${LINKS.anthropicKeys}  → "Create Key"`);
    io.open(LINKS.anthropicKeys);
    for (let i = 0; i < 3; i++) {
      const k = (await io.secret("Anahtarı yapıştır (sk-ant-api...)")).trim();
      if (!k) return io.log(warn("Atlandı."));
      const st = await anthropicKeyValid(deps, k);
      if (st === 200) {
        deps.store.set("ANTHROPIC_API_KEY", k);
        return io.log(ok("Anthropic API anahtarı doğrulandı ve kaydedildi"));
      }
      io.log(warn(st === 401 ? "Anahtar geçersiz. Tekrar dene." : `Doğrulanamadı (HTTP ${st || "bağlantı yok"}).`));
      if (st !== 401 && (await io.confirm("Doğrulamadan kaydedilsin mi?", false))) {
        deps.store.set("ANTHROPIC_API_KEY", k);
        return io.log(ok("Kaydedildi (doğrulanmadı)"));
      }
    }
  } else if (choice === 2) {
    let bin = deps.which("cursor-agent") ?? findCursorBin();
    if (!bin) {
      io.log(warn("Cursor CLI kurulu değil."));
      if (!(await io.confirm("Kurulsun mu? (curl https://cursor.com/install -fsS | bash)", true))) return;
      const r = deps.run("bash", ["-c", "curl https://cursor.com/install -fsS | bash"], { interactive: true });
      bin = deps.which("cursor-agent") ?? path.join(deps.home, ".local", "bin", "cursor-agent");
      if (r.code !== 0 || !fs.existsSync(bin)) return io.log(warn(`Kurulamadı. Elle kur: ${LINKS.cursorInstall}`));
    }
    io.log("Cursor'a giriş yapılıyor (tarayıcı açılacak)...");
    const r = deps.run(bin, ["login"], { interactive: true });
    io.log(r.code === 0 ? ok("Cursor girişi tamam") : warn("Cursor girişi tamamlanamadı; sonra: cursor-agent login"));
  }
}

async function setupJiraBase(io: SetupIO, deps: SetupDeps, force?: boolean): Promise<void> {
  if (deps.jiraBase && !force) return io.log(ok(`Jira adresi: ${deps.jiraBase}`));
  io.log(color.dim("  Tarayıcıda Jira'yı açtığında adres çubuğundaki adres (ör. https://sirket.atlassian.net). Bir kayıt bağlantısı da yapıştırabilirsin."));
  for (let i = 0; i < 3; i++) {
    const raw = await io.ask("Jira adresi", deps.jiraBase || DEFAULT_JIRA_BASE);
    const base = normalizeJiraBase(raw);
    if (!base) {
      io.log(warn("Geçerli bir adres değil. Örnek: https://sirket.atlassian.net"));
      continue;
    }
    deps.jiraBase = base;
    deps.saveJiraBase(base);
    return io.log(ok(`Jira adresi: ${base}`));
  }
}

async function setupJira(io: SetupIO, deps: SetupDeps, defaultEmail: string | undefined, force?: boolean): Promise<void> {
  if (!deps.jiraBase) return io.log(warn("Jira adresi girilmediği için Jira adımı atlandı."));
  const curEmail = getCredential("JIRA_EMAIL", deps.store);
  const curToken = getCredential("JIRA_API_TOKEN", deps.store);
  if (curEmail && curToken && !force) {
    const w = await jiraWhoAmI(deps, curEmail, curToken);
    if (w.ok) return io.log(ok(`Jira: ${w.name} <${curEmail}>`));
    io.log(warn(`Kayıtlı Jira token'ı çalışmıyor (HTTP ${w.status || "bağlantı yok"}); yenisini alalım.`));
  }
  const email = (await io.ask("Atlassian hesabının e-postası", curEmail ?? defaultEmail)).trim();
  if (!email) return io.log(warn("Atlandı."));
  io.log(`API token oluştur: ${LINKS.jiraToken}`);
  io.log(color.dim('  "Create API token" → bir ad ver (ör. flowloop) → oluşan token\'ı kopyala'));
  io.open(LINKS.jiraToken);
  for (let i = 0; i < 3; i++) {
    const token = (await io.secret("Jira API token'ını yapıştır")).trim();
    if (!token) return io.log(warn("Atlandı."));
    const w = await jiraWhoAmI(deps, email, token);
    if (w.ok) {
      deps.store.set("JIRA_EMAIL", email);
      deps.store.set("JIRA_API_TOKEN", token);
      return io.log(ok(`Jira doğrulandı: ${w.name} <${email}>`));
    }
    if (w.status === 401 || w.status === 403) io.log(warn("E-posta ya da token hatalı. Tekrar dene."));
    else {
      io.log(warn(`Jira'ya ulaşılamadı (HTTP ${w.status || "bağlantı yok"}).`));
      if (await io.confirm("Doğrulamadan kaydedilsin mi?", false)) {
        deps.store.set("JIRA_EMAIL", email);
        deps.store.set("JIRA_API_TOKEN", token);
        return io.log(ok("Kaydedildi (doğrulanmadı)"));
      }
    }
  }
}

async function setupSsh(io: SetupIO, deps: SetupDeps): Promise<void> {
  let r = sshBitbucket(deps);
  if (r.ok) return io.log(ok(`Bitbucket SSH${r.user ? `: ${r.user}` : ""}`));
  io.log(warn("Bitbucket'a SSH ile bağlanılamadı."));
  const key = path.join(deps.home, ".ssh", "id_ed25519");
  if (!fs.existsSync(key) && !fs.existsSync(path.join(deps.home, ".ssh", "id_rsa"))) {
    if (!(await io.confirm("Bir SSH anahtarı oluşturulsun mu? (ssh-keygen -t ed25519)", true))) return;
    const email = gitConfig(deps, "user.email") ?? "flowloop";
    deps.run("ssh-keygen", ["-t", "ed25519", "-C", email, "-f", key, "-N", ""]);
  }
  const pub = [key + ".pub", path.join(deps.home, ".ssh", "id_rsa.pub")].find((p) => fs.existsSync(p));
  if (!pub) return io.log(warn("Açık anahtar bulunamadı."));
  const copied = deps.which("pbcopy") ? deps.run("bash", ["-c", `pbcopy < "${pub}"`]).code === 0 : false;
  io.log(`Açık anahtarını Bitbucket'a ekle: ${LINKS.bitbucketSsh}  → "Add key"`);
  io.log(copied ? color.dim("  Anahtar panoya kopyalandı; sayfaya yapıştırman yeterli.") : color.dim(`  Eklenecek anahtar: ${fs.readFileSync(pub, "utf8").trim()}`));
  io.open(LINKS.bitbucketSsh);
  await io.pause("Ekledikten sonra Enter'a bas");
  r = sshBitbucket(deps);
  io.log(r.ok ? ok(`Bitbucket SSH${r.user ? `: ${r.user}` : ""}`) : warn("Hâlâ bağlanılamıyor; sonra tekrar dene: ssh -T git@bitbucket.org"));
}

// ───────────── gerçek terminal ve sistem ─────────────

export function systemDeps(jiraBase = globalJiraBase()): SetupDeps {
  return {
    store: defaultStore(),
    home: os.homedir(),
    jiraBase: jiraBase.replace(/\/+$/, ""),
    saveJiraBase: (base) => writeUserConfig({ jiraBaseUrl: base }),
    fetchFn: (u, i) => fetch(u, i) as any,
    run: (cmd, args, o = {}) => {
      const r = spawnSync(cmd, args, { encoding: "utf8", stdio: o.interactive ? "inherit" : "pipe", timeout: o.timeoutMs });
      return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    },
    which: (bin) => {
      const r = spawnSync("bash", ["-lc", `command -v ${bin}`], { encoding: "utf8" });
      return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
    },
  };
}

export function terminalIO(): SetupIO {
  const input = process.stdin;
  const readLine = (prompt: string, hidden = false): Promise<string> =>
    new Promise((resolve) => {
      process.stdout.write(prompt);
      let buf = "";
      const wasRaw = input.isRaw;
      input.setRawMode?.(true);
      input.resume();
      input.setEncoding("utf8");
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n") {
            input.setRawMode?.(wasRaw ?? false);
            input.pause();
            input.off("data", onData);
            process.stdout.write("\n");
            return resolve(buf);
          }
          if (ch === "\u0003") {
            input.setRawMode?.(false);
            process.stdout.write("\n");
            process.exit(130);
          }
          if (ch === "\u007f" || ch === "\b") {
            if (buf) {
              buf = buf.slice(0, -1);
              if (!hidden) process.stdout.write("\b \b");
            }
            continue;
          }
          buf += ch;
          process.stdout.write(hidden ? "•" : ch);
        }
      };
      input.on("data", onData);
    });
  return {
    log: (s) => console.log(s),
    ask: async (q, def) => (await readLine(`${q}${def ? color.dim(` [${def}]`) : ""}: `)) || def || "",
    secret: (q) => readLine(`${q}: `, true),
    confirm: async (q, def = true) => {
      const a = (await readLine(`${q} ${def ? "[E/h]" : "[e/H]"} `)).trim();
      return a ? /^[eEyY]/.test(a) : def;
    },
    choose: async (q, options) => {
      console.log(q);
      options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
      for (;;) {
        const n = Number((await readLine("Seçimin: ")).trim());
        if (n >= 1 && n <= options.length) return n - 1;
      }
    },
    open: (url) => {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      spawnSync(opener, [url], { stdio: "ignore" });
    },
    pause: async (msg) => {
      await readLine(`${msg}… `);
    },
  };
}
