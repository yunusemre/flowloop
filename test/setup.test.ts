import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSetup, printStatus, type SetupDeps, type SetupIO } from "../src/setup.js";
import { FileStore, getCredential, mask, scrubEnv } from "../src/secrets.js";
import { runConfigured } from "../src/git.js";
import { fetchIssue } from "../src/jira.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kgflow-setup-"));
}

/** Senaryolu terminal: verilen cevapları sırayla döner, yazılanları toplar */
function scriptedIO(answers: (string | boolean | number)[]) {
  const out: string[] = [];
  const opened: string[] = [];
  const next = () => {
    if (!answers.length) throw new Error("beklenmeyen soru: " + out.at(-1));
    return answers.shift()!;
  };
  const io: SetupIO = {
    log: (s) => out.push(s.replace(/\x1b\[[0-9;]*m/g, "")),
    ask: async (q) => (out.push("? " + q), String(next())),
    secret: async (q) => (out.push("? " + q), String(next())),
    confirm: async (q) => (out.push("? " + q), Boolean(next())),
    choose: async (q) => (out.push("? " + q), Number(next())),
    open: (u) => opened.push(u),
    pause: async (m) => void out.push("… " + m),
  };
  return { io, out, opened, remaining: answers };
}

function fakeDeps(home: string, over: Partial<SetupDeps> = {}) {
  const store = new FileStore(path.join(home, ".kgflow", "credentials.json"));
  const gitCfg: Record<string, string> = {};
  const calls: string[] = [];
  const deps: SetupDeps = {
    store,
    home,
    jiraBase: "https://kolaygelsin.atlassian.net",
    fetchFn: async (url, init) => {
      if (url.endsWith("/rest/api/3/myself")) {
        const ok = init.headers.Authorization === "Basic " + Buffer.from("yunus@kolaygelsin.com:dogru-token").toString("base64");
        return { status: ok ? 200 : 401, json: async () => ({ displayName: "Yunus Emre Tatar" }) };
      }
      if (url.includes("api.anthropic.com")) return { status: init.headers["x-api-key"] === "sk-ant-api-iyi" ? 200 : 401, json: async () => ({}) };
      return { status: 404, json: async () => ({}) };
    },
    run: (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "git" && args[0] === "config" && args.length === 3) return { code: gitCfg[args[2]] ? 0 : 1, out: gitCfg[args[2]] ?? "" };
      if (cmd === "git" && args[0] === "config" && args.length === 4) {
        gitCfg[args[2]] = args[3];
        return { code: 0, out: "" };
      }
      if (cmd === "ssh") return { code: 0, out: "authenticated via ssh key.\nYou can use git to connect to Bitbucket." };
      return { code: 0, out: "" };
    },
    which: () => undefined,
    ...over,
  };
  return { deps, store, gitCfg, calls };
}

test("setup: sıfırdan kimlik + API anahtarı + Jira; yanlış token tekrar sorulur, gizliler saklanır", async () => {
  const home = tmp();
  const { deps, store, gitCfg } = fakeDeps(home);
  const { io, out, opened, remaining } = scriptedIO([
    "Yunus Emre Tatar", "yunus@kolaygelsin.com", true, // kimlik
    1, "sk-ant-api-iyi", // AI: API anahtarı
    "yunus@kolaygelsin.com", "yanlis", "dogru-token", // Jira: önce yanlış token
  ]);
  await runSetup(io, deps);
  assert.equal(remaining.length, 0, "tüm sorular soruldu");
  assert.equal(gitCfg["user.email"], "yunus@kolaygelsin.com");
  assert.equal(store.get("ANTHROPIC_API_KEY"), "sk-ant-api-iyi");
  assert.equal(store.get("JIRA_API_TOKEN"), "dogru-token");
  assert.equal(store.get("JIRA_EMAIL"), "yunus@kolaygelsin.com");
  const text = out.join("\n");
  assert.match(text, /E-posta ya da token hatalı/);
  assert.match(text, /Jira doğrulandı: Yunus Emre Tatar/);
  assert.match(text, /Bitbucket SSH/);
  assert.ok(!text.includes("dogru-token") && !text.includes("sk-ant-api-iyi"), "gizli bilgi ekrana yazılmaz");
  assert.ok(opened.some((u) => u.includes("id.atlassian.com")) && opened.some((u) => u.includes("console.anthropic.com")), "token sayfaları açıldı");
  const mode = fs.statSync(path.join(home, ".kgflow", "credentials.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("setup: her şey hazırsa soru sormaz, sadece doğrular", async () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "yunus@kolaygelsin.com" } }));
  const { deps, store, gitCfg } = fakeDeps(home);
  gitCfg["user.name"] = "Yunus";
  gitCfg["user.email"] = "yunus@kolaygelsin.com";
  store.set("JIRA_EMAIL", "yunus@kolaygelsin.com");
  store.set("JIRA_API_TOKEN", "dogru-token");
  const { io, out } = scriptedIO([]);
  await runSetup(io, deps);
  const text = out.join("\n");
  assert.match(text, /Claude: Claude Code girişi \(yunus@kolaygelsin\.com\)/);
  assert.match(text, /Jira: Yunus Emre Tatar/);
  assert.match(text, /Hazırsın/);
});

test("setup: Claude aboneliği ile token (claude setup-token)", async () => {
  const home = tmp();
  const { deps, store, gitCfg, calls } = fakeDeps(home, { which: (b) => (b === "claude" ? "/usr/local/bin/claude" : undefined) });
  gitCfg["user.name"] = "Y";
  gitCfg["user.email"] = "y@k.com";
  const { io } = scriptedIO([0, "yanlış-biçim", "sk-ant-oat01-abc", "y@k.com", ""]);
  await runSetup(io, deps);
  assert.ok(calls.includes("claude setup-token"));
  assert.equal(store.get("CLAUDE_CODE_OAUTH_TOKEN"), "sk-ant-oat01-abc");
  assert.equal(store.get("JIRA_API_TOKEN"), undefined, "boş bırakılan adım atlanır");
});

test("printStatus: maskeli özet", async () => {
  const home = tmp();
  const { deps, store } = fakeDeps(home);
  store.set("JIRA_EMAIL", "a@b.com");
  store.set("JIRA_API_TOKEN", "abcdefghijkl");
  const lines: string[] = [];
  await printStatus(deps, { log: (s) => lines.push(s) });
  const t = lines.join("\n");
  assert.match(t, /token abcd…ijkl/);
  assert.ok(!t.includes("abcdefghijkl"));
  assert.equal(mask("kısa"), "••••");
});

test("gizli bilgiler: ortam değişkeni önce, sonra saklama yeri", () => {
  const store = new FileStore(path.join(tmp(), "c.json"));
  store.set("JIRA_API_TOKEN", "kayitli");
  assert.equal(getCredential("JIRA_API_TOKEN", store, {}), "kayitli");
  assert.equal(getCredential("JIRA_API_TOKEN", store, { JIRA_API_TOKEN: "env" }), "env");
  store.delete("JIRA_API_TOKEN");
  assert.equal(getCredential("JIRA_API_TOKEN", store, {}), undefined);
});

test("Jira istemcisi kayıtlı token'ı kullanır", async () => {
  const file = path.join(tmp(), "c.json");
  new FileStore(file).set("JIRA_EMAIL", "a@b.com");
  new FileStore(file).set("JIRA_API_TOKEN", "t0k");
  const saved = { f: process.env.KGFLOW_SECRET_FILE, e: process.env.JIRA_EMAIL, t: process.env.JIRA_API_TOKEN };
  process.env.KGFLOW_SECRET_FILE = file;
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_API_TOKEN;
  let auth = "";
  try {
    await fetchIssue("IDT-1", "https://x.atlassian.net", {
      fetchFn: async (_u, i) => {
        auth = i.headers.Authorization;
        return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
      },
    }).catch(() => undefined);
  } finally {
    for (const [k, v] of Object.entries({ KGFLOW_SECRET_FILE: saved.f, JIRA_EMAIL: saved.e, JIRA_API_TOKEN: saved.t })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.equal(auth, "Basic " + Buffer.from("a@b.com:t0k").toString("base64"));
});

test("ajan ve test komutları gizli bilgileri görmez", () => {
  const env = scrubEnv({ PATH: "/bin", HOME: "/h", JIRA_API_TOKEN: "x", JIRA_EMAIL: "e", ANTHROPIC_API_KEY: "k", GITHUB_TOKEN: "g", AWS_SECRET_ACCESS_KEY: "a", DB_PASSWORD: "p", SSH_AUTH_SOCK: "/s" }, { ANTHROPIC_API_KEY: "k" });
  assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_API_KEY", "HOME", "PATH", "SSH_AUTH_SOCK"]);
  const saved = process.env.JIRA_API_TOKEN;
  process.env.JIRA_API_TOKEN = "gizli";
  process.env.MY_SERVICE_SECRET = "gizli2";
  try {
    const r = runConfigured('echo "[$JIRA_API_TOKEN][$MY_SERVICE_SECRET]"', os.tmpdir());
    assert.equal(r.stdout.trim(), "[][]");
    const full = runConfigured('echo "[$JIRA_API_TOKEN]"', os.tmpdir(), undefined, { fullEnv: true });
    assert.equal(full.stdout.trim(), "[gizli]", "bağımlılık kurulumu tam ortamla çalışır");
  } finally {
    delete process.env.MY_SERVICE_SECRET;
    if (saved === undefined) delete process.env.JIRA_API_TOKEN;
    else process.env.JIRA_API_TOKEN = saved;
  }
});
