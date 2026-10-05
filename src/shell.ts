/**
 * Bash komutlarını güvenli şekilde ayrıştırır.
 *
 * Amaç: bir rolün izin verilen komut listesi (ör. "npm test", "git commit")
 * dışına çıkamaması. Bunun için komut tek bir basit komut olmalı:
 *   - zincirleme (; && || |), yönlendirme (> <), arka plan (&) YOK
 *   - komut yerine koyma ($(...), `...`) ve değişken genişletme ($X) YOK
 * Tırnak içindeki metin (ör. commit mesajı) serbesttir; tek tırnak tamamen
 * literaldir, çift tırnak içinde ise $ ve ` yasaktır.
 */

export type ParseResult =
  | { ok: true; tokens: string[] }
  | { ok: false; reason: string };

const META = new Set([";", "&", "|", ">", "<", "(", ")", "`", "$", "\n", "\r"]);

export function parseSimpleCommand(command: string): ParseResult {
  const tokens: string[] = [];
  let cur = "";
  let inToken = false;
  let i = 0;
  const s = command.trim();
  if (!s) return { ok: false, reason: "boş komut" };

  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) return { ok: false, reason: "kapanmamış tek tırnak" };
      cur += s.slice(i + 1, end);
      inToken = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = "";
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "$" || s[j] === "`") {
          return { ok: false, reason: "çift tırnak içinde $ veya ` kullanılamaz (tek tırnak kullan)" };
        }
        if (s[j] === "\\" && j + 1 < s.length && ['"', "\\"].includes(s[j + 1])) {
          buf += s[j + 1];
          j += 2;
          continue;
        }
        buf += s[j];
        j++;
      }
      if (j >= s.length) return { ok: false, reason: "kapanmamış çift tırnak" };
      cur += buf;
      inToken = true;
      i = j + 1;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= s.length) return { ok: false, reason: "sonda ters bölü" };
      const next = s[i + 1];
      if (next === "\n") return { ok: false, reason: "satır devamı desteklenmiyor" };
      cur += next;
      inToken = true;
      i += 2;
      continue;
    }
    if (c === " " || c === "\t") {
      if (inToken) {
        tokens.push(cur);
        cur = "";
        inToken = false;
      }
      i++;
      continue;
    }
    if (META.has(c)) {
      return { ok: false, reason: `izin verilmeyen kabuk karakteri: ${JSON.stringify(c)} (tek, basit bir komut çalıştır)` };
    }
    if (c === "*" || c === "?" || c === "[" || c === "{" || c === "~") {
      return { ok: false, reason: `tırnaksız glob/genişletme karakteri: ${c}` };
    }
    cur += c;
    inToken = true;
    i++;
  }
  if (inToken) tokens.push(cur);
  if (tokens.length === 0) return { ok: false, reason: "boş komut" };
  // VAR=deger komut  biçimini engelle
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    return { ok: false, reason: "ortam değişkeni atamasıyla başlayan komut kullanılamaz" };
  }
  return { ok: true, tokens };
}

/** Komutun herhangi bir argümanı yasak bir bayrakla eşleşiyor mu? */
export function findForbiddenFlag(tokens: string[], forbidden: string[]): string | undefined {
  for (const t of tokens.slice(1)) {
    for (const f of forbidden) {
      if (t === f || t.startsWith(f + "=")) return t;
    }
  }
  return undefined;
}

/**
 * tokens, izin verilen önek komutlardan biriyle (kelime sınırında) başlıyor mu?
 * "npm test" öneki: "npm test", "npm test -- --x" eşleşir; "npm testx" eşleşmez.
 */
export function matchesPrefix(tokens: string[], prefixes: string[]): string | undefined {
  for (const p of prefixes) {
    const pt = parseSimpleCommand(p);
    if (!pt.ok) continue;
    const want = pt.tokens;
    if (want.length > tokens.length) continue;
    if (want.every((w, idx) => tokens[idx] === w)) return p;
  }
  return undefined;
}
