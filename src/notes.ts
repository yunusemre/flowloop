/**
 * Plan ve ajan çıktılarından insanın görmesi gereken notlar:
 *   - Açık sorular: analistin cevapsız ilerlememesi gereken sorular (planın "## Açık sorular" bölümü)
 *   - Varsayımlar: plandaki "Varsayım:" satırları ve cevaplanmadan geçilen sorular
 *   - İncelenmesi önerilenler: developer'ın Handoff'undaki riskler / atlananlar ve reviewer'ın notları
 *
 * Bunlar onay ekranında gösterilir ve Jira yorumuna eklenir.
 */

export interface OpenQuestion {
  /** S-1, S-2 … (analist yazmadıysa sırayla verilir) */
  id: string;
  /** Sorunun tamamı (birden fazla satır olabilir) */
  text: string;
  /** "Cevap gelmezse:" satırı: analistin önerdiği varsayılan */
  fallback?: string;
  /** "S-1 (PROJ-2): …" biçiminde yazıldıysa sorunun ait olduğu görev (toplu plan) */
  key?: string;
}

export type AttentionKind = "review" | "risk" | "skipped" | "preexisting";
/** Reviewer'ın maddeye koyduğu etiket: ne yapılması gerektiği */
export type AttentionTag = "fix" | "decision" | "manual" | "followup" | "info";

export interface AttentionItem {
  from: "developer" | "reviewer";
  kind: AttentionKind;
  text: string;
  tag?: AttentionTag;
}

const TAGS: [RegExp, AttentionTag][] = [
  [/^d[üu]zelt|^fix/i, "fix"],
  [/^karar|^decision/i, "decision"],
  [/^elle|^manual/i, "manual"],
  [/^ayr[ıi]\s*i[şs]|^follow/i, "followup"],
  [/^bilgi|^info/i, "info"],
];

export const TAG_LABEL: Record<AttentionTag, string> = { fix: "düzelt", decision: "karar", manual: "elle", followup: "ayrı iş", info: "bilgi" };

/** "[elle] metin" → { tag: "manual", text: "metin" } */
export function splitTag(text: string): { tag?: AttentionTag; text: string } {
  const m = /^\s*\**\s*[\[(]\s*([^\])]{2,20}?)\s*[\])]\s*\**\s*[:—–-]?\s*/.exec(text);
  const tag = m ? TAGS.find(([re]) => re.test(m[1].trim()))?.[1] : undefined;
  return tag ? { tag, text: text.slice(m![0].length).trim() } : { text };
}

/** Tekrar tespiti için anahtar ve benzerlik: aynı dosyadan bahseden ve kelimeleri büyük ölçüde örtüşen maddeler aynıdır */
export function attentionKey(text: string): string {
  return norm(text);
}
function tokens(t: string): Set<string> {
  return new Set(norm(t).split(/[^a-z0-9çğıöşü_./-]+/i).filter((w) => w.length >= 4));
}
function paths(t: string): Set<string> {
  return new Set((t.match(/[A-Za-z0-9_.-]+\.(cs|ts|tsx|js|json|csproj|xml|yml|yaml|md|config)\b/g) ?? []).map((p) => p.toLowerCase()));
}
export function similar(a: string, b: string): boolean {
  if (norm(a) === norm(b)) return true;
  const ta = tokens(a), tb = tokens(b);
  const inter = [...ta].filter((x) => tb.has(x)).length;
  const jac = inter / Math.max(1, ta.size + tb.size - inter);
  const pa = paths(a), pb = paths(b);
  const samePath = [...pa].some((p) => pb.has(p));
  return jac >= 0.5 || (samePath && jac >= 0.2);
}

const NONE = /^[\s*_`(]*(yok|none|n\/?a|nothing|hiçbiri|-|—|–)[\s.)*_`]*$/i;
const MAX_ITEM = 400;

/** Bir markdown bölümünün satırları (başlık eşleşmesi ile sonraki başlık arası); yoksa undefined */
export function sectionLines(text: string, heading: RegExp): string[] | undefined {
  const lines = text.replace(/\r/g, "").split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    // son eşleşen bölüm geçerlidir (revizyonlarda alta eklenmiş olabilir)
    const m = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(lines[i].trim());
    if (m && heading.test(m[2])) {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  const level = /^(#+)/.exec(lines[start].trim())![1].length;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    const h = /^(#{1,6})\s/.exec(l.trim());
    if (h && h[1].length <= level) break;
    out.push(l);
  }
  return out;
}

/** Metinden bir markdown bölümünü (başlık + içerik) çıkarır */
export function removeSection(text: string, heading: RegExp): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let skipLevel = 0;
  for (const l of lines) {
    const m = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(l.trim());
    if (skipLevel) {
      if (m && m[1].length <= skipLevel) skipLevel = 0;
      else continue;
    }
    if (m && heading.test(m[2])) {
      skipLevel = m[1].length;
      continue;
    }
    out.push(l);
  }
  return out.join("\n").trim();
}

export const DECISIONS_SECTION = /^karar gerekli|^kullan[ıi]c[ıi] karar[ıi] gerekli|^decisions? needed/i;

/** Madde listesini öğelere ayırır: "- x", "* x", "1. x"; devam satırları öncekine eklenir */
export function listItems(lines: string[]): string[] {
  const items: string[] = [];
  let cur: string[] | undefined;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const m = /^ ?(?:[-*+]|\d+[.)])\s+(.*)$/.exec(raw); // sadece en üst seviye maddeler
    if (m) {
      if (cur) items.push(cur.join("\n"));
      cur = [m[1]];
    } else if (cur) {
      cur.push(raw.trim());
    } else {
      cur = [raw.trim()];
    }
  }
  if (cur) items.push(cur.join("\n"));
  return items.map((s) => s.trim()).filter((s) => s && !NONE.test(s));
}

const QUESTIONS_HEADING = /^a[çc][ıi]k sorular|^open questions/i;

/** Planın "## Açık sorular" bölümündeki sorular. Bölüm yoksa ya da "Yok" yazıyorsa []. */
export function parseOpenQuestions(plan: string): OpenQuestion[] {
  return parseItems(plan, QUESTIONS_HEADING, "S");
}


/**
 * Reviewer'ın "## Karar gerekli" bölümü: görev, plan, cevaplar ya da referanslar arasındaki çelişkiler.
 * Bunlara ajanlar karar vermez; flowloop kullanıcıya sorar.
 */
export function parseDecisions(text: string): OpenQuestion[] {
  return parseItems(text, DECISIONS_SECTION, "K");
}

function parseItems(text: string, heading: RegExp, prefix: string): OpenQuestion[] {
  const lines = sectionLines(text, heading);
  if (!lines) return [];
  return listItems(lines.filter((l) => !/^\s*VERDICT:/i.test(l))).map((item, i) => {
    const idm = /^\**\s*([A-Z]-?\d+)\s*(?:[(\[]\s*([A-Z][A-Z0-9]+-\d+)\s*[)\]])?\s*\**\s*[:.)—–-]\s*\**\s*/i.exec(item);
    const id = idm ? idm[1].toUpperCase().replace(/^([A-Z])(\d)/, "$1-$2") : `${prefix}-${i + 1}`;
    const body: string[] = [];
    const fb: string[] = [];
    let inFallback = false;
    for (const line of (idm ? item.slice(idm[0].length) : item).split("\n")) {
      const lab = /^\s*[-*]?\s*\**\s*([A-Za-zÇĞİÖŞÜçğıöşü ]{3,30}?)\s*\**\s*:\s*(.*)$/.exec(line);
      if (lab && /^(cevap gelmezse|varsay[ıi]lan|default|if unanswered|[öo]nerim|[öo]neri|recommendation)$/i.test(lab[1].trim())) {
        inFallback = true;
        if (lab[2].trim()) fb.push(lab[2].trim());
        continue;
      }
      if (lab) inFallback = false;
      (inFallback ? fb : body).push(line.trim());
    }
    const fallback = fb.join(" ").trim() || undefined;
    const text = body.filter(Boolean).join("\n");
    const q: OpenQuestion = { id, text: clip(text), fallback: fallback && clip(fallback) };
    if (idm?.[2]) q.key = idm[2].toUpperCase();
    return q;
  });
}

/** Plandaki "Varsayım:" ifadeleri (madde ya da satır içi) */
export function extractAssumptions(plan: string): string[] {
  const out: string[] = [];
  for (const line of plan.replace(/\r/g, "").split("\n")) {
    const m = /varsay[ıi]m\s*\**\s*:\s*\**\s*(.+)$/i.exec(line);
    if (m && m[1].trim() && !NONE.test(m[1])) out.push(clip(m[1].replace(/\*+$/, "").trim()));
  }
  return dedupe(out);
}

const HANDOFF_LABELS: { re: RegExp; kind?: AttentionKind }[] = [
  { re: /^changed$/i },
  { re: /^checked$/i },
  { re: /^skipped/i, kind: "skipped" },
  { re: /^risks?$/i, kind: "risk" },
  { re: /^pre-?existing/i, kind: "preexisting" },
];

/** Developer'ın son mesajındaki "## Handoff" bölümünden riskler, atlananlar ve önceden var olan sorunlar */
export function parseHandoff(text: string): AttentionItem[] {
  const lines = sectionLines(text, /^handoff$/i);
  if (!lines) return [];
  const out: AttentionItem[] = [];
  let kind: AttentionKind | undefined;
  let buf: string[] = [];
  const flush = () => {
    if (kind) for (const t of splitValue(buf)) out.push({ from: "developer", kind, text: t });
    buf = [];
  };
  for (const raw of lines) {
    const m = /^\s*[-*]?\s*\**([A-Za-z][A-Za-z /()-]{1,40}?)\**\s*:\s*(.*)$/.exec(raw);
    const label = m && HANDOFF_LABELS.find((l) => l.re.test(m[1].trim()));
    if (m && label) {
      flush();
      kind = label.kind;
      buf = m[2].trim() ? [m[2]] : [];
    } else {
      buf.push(raw);
    }
  }
  flush();
  return out;
}

/** Reviewer'ın "## İncelenmesi önerilenler" bölümü */
export function parseReviewerNotes(text: string): AttentionItem[] {
  const lines = sectionLines(text, /^[İIi]ncelenmesi [öo]nerilenler|^human review|^needs human review/i);
  if (!lines) return [];
  return listItems(lines.filter((l) => !/^\s*VERDICT:/i.test(l))).map((t) => {
    const { tag, text } = splitTag(t);
    return { from: "reviewer" as const, kind: "review" as const, text: clip(text), ...(tag ? { tag } : {}) };
  });
}

/** Onay ekranı ve Jira için tek liste: önce reviewer notları, sonra developer'ın riskleri ve atladıkları */
export function collectAttention(developerText: string, reviewerText: string): AttentionItem[] {
  const dev = parseHandoff(developerText).map((a) => (a.kind === "preexisting" ? { ...a, tag: "followup" as const } : a));
  const out: AttentionItem[] = [];
  // önce reviewer'ın (etiketli) maddeleri; developer'ın aynı konudaki maddesi tekrar eklenmez
  for (const a of [...parseReviewerNotes(reviewerText), ...dev]) {
    if (out.some((b) => similar(a.text, b.text))) continue;
    out.push(a);
  }
  return out;
}

export const ATTENTION_TITLE: Record<AttentionKind, string> = {
  review: "reviewer",
  risk: "risk",
  skipped: "doğrulanmadı",
  preexisting: "önceden var olan",
};

function splitValue(lines: string[]): string[] {
  const raw = lines.map((l) => l.trimEnd()).filter((l) => l.trim());
  if (!raw.length) return [];
  const indent = Math.min(...raw.map((l) => /^\s*/.exec(l)![0].length));
  const nonEmpty = raw.map((l) => l.slice(indent));
  const bulleted = nonEmpty.some((l) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(l));
  const items = bulleted ? listItems(nonEmpty) : [nonEmpty.map((l) => l.trim()).join(" ")];
  // tek satırda "a; b; c" biçimi
  const flat = items.length === 1 && items[0].includes("; ") ? items[0].split(/;\s+/) : items;
  return flat.map((s) => clip(s.trim())).filter((s) => s && !NONE.test(s));
}

function clip(s: string): string {
  return s.length > MAX_ITEM ? s.slice(0, MAX_ITEM - 1) + "…" : s;
}
const norm = (s: string) => s.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(norm(x)) ? false : (seen.add(norm(x)), true)));
}
