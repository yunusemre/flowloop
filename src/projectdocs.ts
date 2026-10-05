import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import picomatch from "picomatch";
import type { KgflowConfig } from "./config.js";
import { git } from "./git.js";
import { PACKAGE_ROOT } from "./roles.js";
import { userClaudeMdPath } from "./usermcp.js";

/** base kopyada projectDocs desenleriyle eşleşen (git'te izlenen) dosyalar */
export function findProjectDocs(dir: string, patterns: string[]): string[] {
  const r = git(["ls-files"], dir);
  const files = r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
  const out: string[] = [];
  for (const p of patterns) {
    const m = picomatch(p, { dot: true });
    for (const f of files) if (m(f) && !out.includes(f)) out.push(f);
  }
  return out;
}

const PROCESS_NOTE = `> Bu dosyalar insanlarla etkileşimli çalışan AI araçları için yazılmış olabilir.
> Kod kalitesine dair kurallar (tipler, isimlendirme, dosya yapısı, stil, test yazma)
> AYNEN geçerlidir. Etkileşimli SÜREÇ kuralları ("kullanıcıdan onay iste",
> "oturum başına en fazla N dosya", "edit başına N satır") bu otomatik akışta
> uygulanmaz: onay mekanizması reviewer rolü ve insanın PR incelemesidir.`;

export function composeRules(cfg: KgflowConfig, root: string, baseDir: string, home = os.homedir()): { text: string; docs: string[] } {
  const parts: string[] = [];
  if (cfg.tech.trim()) parts.push(`# Teknoloji\n\nBu projede kullanılan teknolojiler. Çözümü bunlara göre üret; başka kütüphane ekleme.\n\n${cfg.tech.trim()}`);
  parts.push(fs.readFileSync(path.join(PACKAGE_ROOT, "templates", "rules-base.md"), "utf8").trim());

  const docs = findProjectDocs(baseDir, cfg.projectDocs);
  if (docs.length) {
    parts.push(`# Projenin mevcut kuralları\n\n${PROCESS_NOTE}`);
    for (const d of docs) parts.push(`## ${d}\n\n${fs.readFileSync(path.join(baseDir, d), "utf8").trim()}`);
  }
  const personal = userClaudeMdPath(home);
  if (cfg.userClaudeMd && fs.existsSync(personal)) {
    parts.push(`# Geliştiricinin kişisel kuralları (~/.claude/CLAUDE.md)\n\n${PROCESS_NOTE}\n> Proje kuralıyla çelişirse PROJE kuralı geçerlidir.\n\n${fs.readFileSync(personal, "utf8").trim()}`);
    docs.push("~/.claude/CLAUDE.md");
  }
  for (const r of cfg.rules) parts.push(`## ${r}\n\n${fs.readFileSync(path.join(root, r), "utf8").trim()}`);
  return { text: parts.join("\n\n---\n\n"), docs };
}
