import { randomBytes } from "node:crypto";

/** Panel: sunucunun sayfasını çerçeveler; sayfadan gelen mesajları eklentiye, VS Code renklerini sayfaya iletir */
export function wrapperHtml(origin: string, src: string): string {
  const nonce = randomBytes(16).toString("base64");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:var(--vscode-editor-background)}iframe{border:0;width:100%;height:100vh;display:block}</style>
</head><body>
<iframe id="f" src="${src.replace(/"/g, "&quot;")}" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const f = document.getElementById("f");
const ORIGIN = ${JSON.stringify(origin)};
// VS Code tema değişkenleri → flowloop sayfasının değişkenleri (ilk bulunan; hiçbiri yoksa sayfanın kendi koyu/açık rengi)
const MAP = {
  "--bg": ["--vscode-editor-background"],
  "--panel": ["--vscode-sideBar-background", "--vscode-editor-background"],
  "--text": ["--vscode-foreground", "--vscode-editor-foreground"],
  "--muted": ["--vscode-descriptionForeground"],
  "--line": ["--vscode-panel-border", "--vscode-editorGroup-border", "--vscode-widget-border"],
  "--accent": ["--vscode-textLink-foreground", "--vscode-button-background"],
  "--accent-soft": ["--vscode-list-hoverBackground"],
  "--code": ["--vscode-textCodeBlock-background", "--vscode-input-background"],
  "--user": ["--vscode-button-background"],
  "--user-text": ["--vscode-button-foreground"],
  "--err": ["--vscode-errorForeground"],
  "--warn": ["--vscode-editorWarning-foreground"],
  "--ok": ["--vscode-testing-iconPassed", "--vscode-gitDecoration-addedResourceForeground"],
  "--font": ["--vscode-font-family"],
};
function theme() {
  const cs = getComputedStyle(document.documentElement);
  const vars = {};
  for (const [k, list] of Object.entries(MAP)) for (const v of list) { const x = cs.getPropertyValue(v).trim(); if (x) { vars[k] = x; break; } }
  const c = document.body.classList;
  const dark = c.contains("vscode-dark") || (c.contains("vscode-high-contrast") && !c.contains("vscode-high-contrast-light"));
  f.contentWindow.postMessage({ type: "flowloop:theme", dark, vars }, ORIGIN);
}
window.addEventListener("message", (e) => {
  if (e.origin !== ORIGIN || e.source !== f.contentWindow) return;
  if (e.data && e.data.type === "flowloop:ready") theme();
  else if (e.data && e.data.type === "flowloop:open") vscode.postMessage(e.data);
});
new MutationObserver(theme).observe(document.body, { attributes: true, attributeFilter: ["class"] });
</script>
</body></html>`;
}

