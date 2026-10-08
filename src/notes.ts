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
export interface AttentionItem {
  from: "developer" | "reviewer";
  kind: AttentionKind;
  text: string;
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
  const lines = sectionLines(plan, QUESTIONS_HEADING);
  if (!lines) return [];
  return listItems(lines).map((item, i) => {
    const idm = /^\**\s*(S-?\d+)\s*(?:[(\[]\s*([A-Z][A-Z0-9]+-\d+)\s*[)\]])?\s*\**\s*[:.)—–-]\s*\**\s*/i.exec(item);
    const id = idm ? idm[1].toUpperCase().replace(/^S(\d)/, "S-$1") : `S-${i + 1}`;
    const body: string[] = [];
    const fb: string[] = [];
    let inFallback = false;
    for (const line of (idm ? item.slice(idm[0].length) : item).split("\n")) {
      const lab = /^\s*[-*]?\s*\**\s*([A-Za-zÇĞİÖŞÜçğıöşü ]{3,30}?)\s*\**\s*:\s*(.*)$/.exec(line);
      if (lab && /^(cevap gelmezse|varsay[ıi]lan|default|if unanswered)$/i.test(lab[1].trim())) {
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
  return listItems(lines.filter((l) => !/^\s*VERDICT:/i.test(l))).map((t) => ({ from: "reviewer" as const, kind: "review" as const, text: clip(t) }));
}

/** Onay ekranı ve Jira için tek liste: önce reviewer notları, sonra developer'ın riskleri ve atladıkları */
export function collectAttention(developerText: string, reviewerText: string): AttentionItem[] {
  const all = [...parseReviewerNotes(reviewerText), ...parseHandoff(developerText)];
  const seen = new Set<string>();
  return all.filter((a) => {
    const k = a.kind + "|" + norm(a.text);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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
