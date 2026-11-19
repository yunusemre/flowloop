# flowloop — VS Code / Cursor eklentisi

flowloop'un sohbet arayüzünü editörün içinde açar. Arka planda `flowloop ui` sunucusu çalışır (yoksa eklenti başlatır);
terminal, tarayıcı ve eklenti aynı motoru kullanır.

- **flowloop: Paneli aç** (durum çubuğundaki flowloop'a tıklamak da açar). Açık çalışma alanı flowloop kuruluysa proje olarak eklenir ve seçili gelir.
- Sohbetteki dosya adlarına (`src/a.ts:42`, ajanın okuduğu/yazdığı dosyalar) tıklayınca dosya yandaki sütunda o satırda açılır; süren işte çalışma kopyasındaki hâli açılır.
- Panel VS Code temasının renklerini kullanır.
- Durum çubuğu: süren iş ve adımı; cevabın beklendiğinde uyarı rengi ve bildirim.
- **flowloop: Arayüzü tarayıcıda aç**, **flowloop: Kaydı göster**.

Ayar: `flowloop.command` — flowloop PATH'te değilse tam yolu.

Derleme: `npm install && npm run package` → `flowloop-vscode.vsix`.
Kurulum: VS Code / Cursor → Extensions → `…` → **Install from VSIX…**, ya da `code --install-extension flowloop-vscode.vsix` (Cursor: `cursor --install-extension …`).
