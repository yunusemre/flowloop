/**
 * flowloop VS Code eklentisi (VS Code ve Cursor).
 *
 * İnce bir istemci: arka planda `flowloop ui` sunucusu çalışır (yoksa eklenti başlatır), eklenti aynı sohbet
 * arayüzünü editörün içinde bir panelde gösterir. Orchestrator, roller ve güvenlik modeli değişmez; terminal,
 * tarayıcı ve eklenti aynı motoru kullanır.
 *
 * Eklentinin eklediği: açık çalışma alanının proje olarak kaydı, dosya adlarına tıklayınca editörde açma,
 * VS Code teması, durum çubuğu ve "cevabın bekleniyor" bildirimi.
 */
import * as vscode from "vscode";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wrapperHtml } from "./wrapper";

interface UiState {
  token: string;
  port?: number;
  pid?: number;
}
interface Status {
  running: number;
  waiting: number;
  sessions: { id: string; kind: string; project: string; title: string; status: string; step?: string }[];
}

const STATE_FILE = path.join(os.homedir(), ".flowloop", "ui.json");
const CONFIG_FILE = path.join(".flowloop", "flowloop.yaml");

let panel: vscode.WebviewPanel | undefined;
let statusItem: vscode.StatusBarItem;
let timer: NodeJS.Timeout | undefined;
let lastWaiting = new Set<string>();
let starting: Promise<UiState> | undefined;
let out: vscode.OutputChannel;

export function activate(ctx: vscode.ExtensionContext): void {
  out = vscode.window.createOutputChannel("flowloop");
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = "flowloop.open";
  statusItem.text = "$(hubot) flowloop";
  statusItem.tooltip = "flowloop panelini aç";
  statusItem.show();
  ctx.subscriptions.push(
    out,
    statusItem,
    vscode.commands.registerCommand("flowloop.open", () => openPanel(ctx)),
    vscode.commands.registerCommand("flowloop.openInBrowser", async () => {
      const st = await ensureServer();
      await vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${st.port}/#t=${st.token}`));
    }),
    vscode.commands.registerCommand("flowloop.showLog", () => out.show()),
    { dispose: () => timer && clearInterval(timer) },
  );
  // sunucu zaten çalışıyorsa durum çubuğu hemen dolar; çalışmıyorsa panel açılınca başlatılır
  startPolling();
}

export function deactivate(): void {
  if (timer) clearInterval(timer);
}

// ───────────── sunucu ─────────────

function readState(): UiState | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as UiState;
    return typeof j.token === "string" && j.token.length >= 16 ? j : undefined;
  } catch {
    return undefined;
  }
}

async function api<T>(st: UiState, method: string, p: string, body?: unknown, timeoutMs = 3000): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${st.port}${p}`, {
    method,
    headers: { "x-flowloop-token": st.token, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

async function alive(st: UiState | undefined): Promise<boolean> {
  if (!st?.port) return false;
  try {
    await api(st, "GET", "/api/status", undefined, 1500);
    return true;
  } catch {
    return false;
  }
}

/** Çalışan sunucu; yoksa `flowloop ui --background` ile başlatır (terminal açmadan) */
async function ensureServer(): Promise<UiState> {
  const st = readState();
  if (await alive(st)) return st!;
  starting ??= (async () => {
    const cmd = vscode.workspace.getConfiguration("flowloop").get<string>("command") || "flowloop";
    out.appendLine(`flowloop arayüzü başlatılıyor: ${cmd} ui --background --no-open`);
    // GUI'den açılan VS Code'un PATH'i kabuğunkinden kısa olabilir: kullanıcının kabuğuyla (login) çalıştır
    const child =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/d", "/s", "/c", `${cmd} ui --background --no-open`], { windowsHide: true })
        : spawn(process.env.SHELL || "/bin/zsh", ["-lc", `${cmd} ui --background --no-open`]);
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    const code = await new Promise<number>((resolve) => {
      child.on("error", () => resolve(-1));
      child.on("close", (c) => resolve(c ?? -1));
    });
    out.append(log.replace(/#t=[\w-]+/g, "#t=…"));
    const now = readState();
    if (code !== 0 || !(await alive(now))) {
      throw new Error(
        `flowloop arayüzü başlatılamadı (çıkış ${code}). flowloop kurulu mu? Komut yolu ayarı: flowloop.command. Ayrıntı: "flowloop: Kaydı göster".`,
      );
    }
    return now!;
  })().finally(() => (starting = undefined));
  return starting;
}

/** Açık çalışma alanındaki flowloop kurulu klasörler projeye eklenir; ilki seçili gelir */
async function registerWorkspace(st: UiState): Promise<string | undefined> {
  let first: string | undefined;
  const active = vscode.window.activeTextEditor ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri) : undefined;
  const folders = [...(active ? [active] : []), ...(vscode.workspace.workspaceFolders ?? []).filter((f) => f !== active)];
  for (const f of folders) {
    if (f.uri.scheme !== "file" || !fs.existsSync(path.join(f.uri.fsPath, CONFIG_FILE))) continue;
    try {
      const r = await api<{ added: { name: string }[] }>(st, "POST", "/api/projects", { path: f.uri.fsPath });
      first ??= r.added[0]?.name;
    } catch (e) {
      out.appendLine(`Proje eklenemedi (${f.uri.fsPath}): ${(e as Error).message}`);
    }
  }
  return first;
}

// ───────────── panel ─────────────

async function openPanel(ctx: vscode.ExtensionContext): Promise<void> {
  if (panel) {
    panel.reveal();
    return;
  }
  let st: UiState;
  try {
    st = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "flowloop başlatılıyor" }, () => ensureServer());
  } catch (e) {
    const pick = await vscode.window.showErrorMessage((e as Error).message, "Kaydı göster", "Ayarı aç");
    if (pick === "Kaydı göster") out.show();
    if (pick === "Ayarı aç") void vscode.commands.executeCommand("workbench.action.openSettings", "flowloop.command");
    return;
  }
  const project = await registerWorkspace(st);
  const local = vscode.Uri.parse(`http://127.0.0.1:${st.port}/?embed=vscode${project ? `&project=${encodeURIComponent(project)}` : ""}`);
  const ext = await vscode.env.asExternalUri(local); // uzak bağlantıda port yönlendirilir; yerelde aynı adres
  const origin = `${ext.scheme}://${ext.authority}`;
  const src = `${ext.toString(true)}#t=${st.token}`;

  panel = vscode.window.createWebviewPanel("flowloop", "flowloop", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
    enableScripts: true,
    retainContextWhenHidden: true, // canlı akış ve yazılan yorumlar panel gizlenince kaybolmasın
  });
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, "media", "icon.svg");
  panel.webview.html = wrapperHtml(origin, src);
  panel.onDidDispose(() => (panel = undefined), null, ctx.subscriptions);
  panel.webview.onDidReceiveMessage((m) => onMessage(m), null, ctx.subscriptions);
  startPolling();
}

async function onMessage(m: { type?: string; path?: string; line?: number; roots?: string[] }): Promise<void> {
  if (m?.type !== "flowloop:open" || typeof m.path !== "string") return;
  const candidates = path.isAbsolute(m.path)
    ? [m.path]
    : (m.roots ?? []).filter((r) => typeof r === "string" && path.isAbsolute(r)).map((r) => path.join(r, m.path!));
  const file = candidates.find((c) => {
    try {
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  });
  if (!file) {
    void vscode.window.showWarningMessage(`flowloop: ${m.path} bulunamadı.`);
    return;
  }
  const line = Math.max(0, (m.line ?? 1) - 1);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const range = new vscode.Range(line, 0, line, 0);
  // panelin yanındaki sütunda: sohbet açık kalır
  const column = panel?.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
  await vscode.window.showTextDocument(doc, { viewColumn: column, selection: range, preview: true });
}

// ───────────── durum çubuğu ─────────────

function startPolling(): void {
  if (timer) return;
  const tick = async () => {
    const st = readState();
    let s: Status | undefined;
    try {
      s = st?.port ? await api<Status>(st, "GET", "/api/status", undefined, 1500) : undefined;
    } catch {
      s = undefined;
    }
    render(s);
  };
  void tick();
  timer = setInterval(tick, 3000);
}

function render(s: Status | undefined): void {
  if (!s) {
    statusItem.text = "$(hubot) flowloop";
    statusItem.tooltip = "flowloop panelini aç (arayüz çalışmıyorsa başlatılır)";
    statusItem.backgroundColor = undefined;
    lastWaiting = new Set();
    return;
  }
  const waiting = s.sessions.filter((x) => x.status === "waiting");
  const running = s.sessions.filter((x) => x.status === "running");
  const short = (t: string) => (t.length > 40 ? t.slice(0, 39) + "…" : t);
  const step = (x: Status["sessions"][number]) => (x.step ? x.step.replace(/^\d\/\d\s+/, "").split(/\s{2,}/)[0] : "");
  if (waiting.length) {
    statusItem.text = `$(bell) flowloop: cevabın bekleniyor${waiting.length > 1 ? ` (${waiting.length})` : ` · ${short(waiting[0].title)}`}`;
    statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else if (running.length) {
    statusItem.text = `$(sync~spin) flowloop: ${running.length > 1 ? `${running.length} iş sürüyor` : `${short(running[0].title)}${step(running[0]) ? ` · ${step(running[0])}` : ""}`}`;
    statusItem.backgroundColor = undefined;
  } else {
    statusItem.text = "$(hubot) flowloop";
    statusItem.backgroundColor = undefined;
  }
  statusItem.tooltip = [...waiting, ...running].map((x) => `${x.status === "waiting" ? "⏳ cevabın bekleniyor" : "▶ sürüyor"} · ${x.project} · ${x.title}`).join("\n") || "flowloop panelini aç";
  // yeni bekleyen soru: bildirim (panel öndeyse gerek yok)
  const now = new Set(waiting.map((x) => x.id));
  const fresh = waiting.filter((x) => !lastWaiting.has(x.id));
  lastWaiting = now;
  if (fresh.length && !panel?.visible) {
    void vscode.window.showInformationMessage(`flowloop: cevabın bekleniyor — ${fresh[0].project} · ${fresh[0].title}`, "Aç").then((a) => {
      if (a) void vscode.commands.executeCommand("flowloop.open");
    });
  }
}
