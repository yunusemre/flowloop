/**
 * Dışarı giden ve ajana dönen metinlerde gizli bilgi maskelemesi.
 *
 * Nereye uygulanır: ajana dönen kontrol ve mutasyon çıktıları, flowloop araçlarının cevapları,
 * Jira'ya yazılan yorumlar ve sorular. Testler ve loglar connection string, token ya da anahtar basabilir;
 * bunlar modele ve Jira'ya gitmemeli.
 *
 * Kişisel veri (e-posta, cep telefonu) varsayılan olarak maskelenmez: geliştirme işlerinde bunlar çoğunlukla
 * test verisidir (ör. GSM doğrulama testleri) ve maskelemek işi bozar. flowloop.yaml → redact.personal: true
 * ile açılır.
 */

const MASK = "[gizli]";

/** [kalıp, maskelenmiş hâli] — değerin kendisi gider, adı kalır (ajan neyin gizlendiğini bilsin) */
const SECRET_PATTERNS: [RegExp, string | ((...m: string[]) => string)][] = [
  // PEM anahtar blokları
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, `-----PRIVATE KEY ${MASK}-----`],
  // connection string içindeki parola ve anahtarlar: Password=...; Pwd=...; AccountKey=...; SharedAccessKey=...
  [/\b(password|pwd|accountkey|sharedaccesskey|client_secret|clientsecret)\s*=\s*("[^"]*"|'[^']*'|[^;"'\s]+)/gi, (_m, k: string) => `${k}=${MASK}`],
  // URL içindeki kullanıcı:parola@
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]+)@/gi, (_m, pre: string) => `${pre}:${MASK}@`],
  // JSON / YAML / ini: "password": "x", apiKey: x, token = x
  [
    /(["']?\b[\w.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?\b["']?\s*[:=]\s*)("[^"\n]{3,}"|'[^'\n]{3,}'|(?=[^\s,;]*\d)[A-Za-z0-9_+/.=~-]{8,}(?![\w(]))/gi,
    (m, k: string, v: string) => (v.includes(MASK) ? m : `${k}${v.startsWith('"') ? `"${MASK}"` : v.startsWith("'") ? `'${MASK}'` : MASK}`),
  ],
  // Authorization başlıkları
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, (_m, k: string) => `${k} ${MASK}`],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  // bilinen token biçimleri: AWS, GitHub, Slack, Atlassian, Anthropic, OpenAI, Google
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bATATT[A-Za-z0-9_=-]{20,}/g, MASK],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, MASK],
  [/\bsk-[A-Za-z0-9]{32,}\b/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, MASK],
];

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
/** Türk cep numaraları: +90 5xx..., 0 5xx..., 5xx xxx xx xx (ayraçlı ya da bitişik) */
const TR_MOBILE = /(?<![\d])(?:\+?90[\s-]?|0)?\(?5\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}(?![\d])/g;

/** Maskelenmemesi gereken teknik adresler (commit imzası vb.) */
const SAFE_EMAIL = /^(noreply|no-reply|cursoragent)@|@(anthropic\.com|cursor\.com|users\.noreply\.github\.com)$/i;

export interface RedactOptions {
  /** e-posta ve cep telefonu da maskelensin */
  personal?: boolean;
}

export function redact(text: string, opts: RedactOptions = {}): string {
  if (!text) return text;
  let out = text;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep as never);
  if (opts.personal) {
    out = out.replace(EMAIL, (m) => (SAFE_EMAIL.test(m) ? m : "[e-posta]"));
    out = out.replace(TR_MOBILE, "[telefon]");
  }
  return out;
}

/** Metinde maskelenecek bir gizli bilgi var mı (uyarı için) */
export function hasSecret(text: string): boolean {
  return redact(text) !== text;
}
