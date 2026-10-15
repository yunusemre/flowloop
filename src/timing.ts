import fs from "node:fs";

/**
 * Süre ölçümü: çalıştırmanın nereye zaman harcadığı (run.json → timings, history.jsonl, flowloop stats).
 *
 *   agent  → bir rolün ajan çalışması (analist, developer, reviewer, committer)
 *   check  → flowloop'un kendi çalıştırdığı kontroller (format, test, tip, lint)
 *   setup  → çalışma kopyası, bağımlılık kurulumu
 *   human  → kullanıcının cevabını bekleme (plan onayı, sorular, inceleme maddeleri, değişiklik onayı)
 *   deliver→ commit, push, Jira yorumu
 */
export type TimingKind = "agent" | "check" | "setup" | "human" | "deliver";

export interface TimingEntry {
  step: string;
  kind: TimingKind;
  ms: number;
  iteration?: number;
  /** ek bilgi (ör. mutasyon test koşusu sayısı) */
  note?: string;
}

export class Stopwatch {
  /** iç içe ölçümler: içteki adımın süresi dıştakinden düşülür (her süre bir kez sayılır) */
  private stack: number[] = [];

  constructor(
    readonly entries: TimingEntry[] = [],
    private clock: () => number = Date.now,
  ) {}

  add(e: TimingEntry): void {
    this.entries.push({ ...e, ms: Math.max(0, Math.round(e.ms)) });
  }

  /** Bir kaydın süresinin bir kısmını ayrı bir adım olarak ayırır (ör. reviewer içindeki mutasyon testleri) */
  carve(index: number, e: TimingEntry): void {
    const from = this.entries[index];
    if (!from) return this.add(e);
    const ms = Math.min(from.ms, Math.max(0, Math.round(e.ms)));
    from.ms -= ms;
    this.entries.push({ ...e, ms });
  }

  private begin(): number {
    this.stack.push(0);
    return this.clock();
  }

  private end(t0: number, step: string, kind: TimingKind, extra: Partial<TimingEntry>): void {
    const total = this.clock() - t0;
    const inner = this.stack.pop() ?? 0;
    this.add({ step, kind, ms: total - inner, ...extra });
    if (this.stack.length) this.stack[this.stack.length - 1] += total;
  }

  time<T>(step: string, kind: TimingKind, fn: () => T, extra: Partial<TimingEntry> = {}): T {
    const t0 = this.begin();
    try {
      return fn();
    } finally {
      this.end(t0, step, kind, extra);
    }
  }

  async timeAsync<T>(step: string, kind: TimingKind, fn: () => Promise<T>, extra: Partial<TimingEntry> = {}): Promise<T> {
    const t0 = this.begin();
    try {
      return await fn();
    } finally {
      this.end(t0, step, kind, extra);
    }
  }

  /** Kullanıcıya soru soran bir geri çağırmayı sarar: bekleme süresi "human" olarak sayılır */
  human<A extends unknown[], R>(step: string, fn: ((...a: A) => Promise<R>) | undefined): ((...a: A) => Promise<R>) | undefined {
    if (!fn) return undefined;
    return (...a: A) => this.timeAsync(step, "human", () => fn(...a));
  }
}

export function totals(entries: TimingEntry[]): Record<TimingKind, number> {
  const t: Record<TimingKind, number> = { agent: 0, check: 0, setup: 0, human: 0, deliver: 0 };
  for (const e of entries) t[e.kind] += e.ms;
  return t;
}

/** 75000 → "1:15", 3723000 → "1:02:03" */
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const KIND_LABEL: Record<TimingKind, string> = { agent: "ajanlar", check: "kontroller", setup: "hazırlık", human: "senin cevabın", deliver: "teslim" };

/**
 * Çalıştırma sonunda gösterilen süre tablosu. Toplam süre ölçülmeyen aralıkları da (flowloop'un kendi işi)
 * içerir; "diğer" olarak gösterilir.
 */
export function timingReport(entries: TimingEntry[], totalMs: number): string {
  if (!entries.length) return "";
  const t = totals(entries);
  const measured = Object.values(t).reduce((a, b) => a + b, 0);
  const machine = totalMs - t.human;
  const head =
    `Süre: toplam ${fmtDuration(totalMs)} · makine ${fmtDuration(machine)} · senin cevabın ${fmtDuration(t.human)}\n` +
    "  " +
    (Object.keys(t) as TimingKind[])
      .filter((k) => k !== "human" && t[k] > 0)
      .map((k) => `${KIND_LABEL[k]} ${fmtDuration(t[k])}`)
      .concat(totalMs - measured > 5000 ? [`diğer ${fmtDuration(totalMs - measured)}`] : [])
      .join(" · ");
  // en uzun adımlar: nereye bakılması gerektiğini gösterir
  const top = [...entries]
    .filter((e) => e.kind !== "human")
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 6)
    .map((e) => `  ${fmtDuration(e.ms).padStart(7)}  ${e.step}${e.iteration ? ` #${e.iteration}` : ""}${e.note ? ` (${e.note})` : ""}`);
  return `${head}\n  En uzun adımlar:\n${top.join("\n")}`;
}

/** Mutasyon test koşularının kaydı (Claude'da süreç içi, Cursor'da ayrı süreç: dosya ikisinde de çalışır) */
export function readMutantRuns(file: string, since = 0): { runs: number; ms: number } {
  try {
    let runs = 0;
    let ms = 0;
    for (const l of fs.readFileSync(file, "utf8").split("\n")) {
      if (!l.trim()) continue;
      const r = JSON.parse(l) as { at: number; ms: number };
      if (r.at < since) continue;
      runs++;
      ms += r.ms;
    }
    return { runs, ms };
  } catch {
    return { runs: 0, ms: 0 };
  }
}
