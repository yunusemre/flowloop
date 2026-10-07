import fs from "node:fs";
import path from "node:path";
import { FLOWLOOP_DIR } from "./config.js";

/**
 * flowloop stats: çalıştırmaların ölçüm özeti.
 * Kaynaklar: kalıcı geçmiş (.flowloop/history.jsonl) + henüz temizlenmemiş run.json dosyaları.
 * Aynı çalıştırmanın birden fazla kaydı varsa (ör. resume) en son yazılan geçerlidir.
 */

/** Ölçüm için gereken alanlar (RunSummary'nin ve geçmiş kaydının ortak alt kümesi) */
export interface RunRecord {
  id: string;
  status: string;
  taskKey?: string;
  backend?: string;
  totalCostUsd?: number;
  iterations?: number;
  phases?: { role: string; verdict?: string; iteration?: number }[];
  denials?: { role: string; tool: string }[];
  planFeedback?: unknown[];
  changeRequests?: unknown[];
  scopeRequests?: { decision?: string }[];
  scope?: { fromPlan: boolean };
  userApproved?: boolean;
  related?: { commits?: string[] }[];
  checkRounds?: number;
  failedCheckRounds?: number;
  checks?: { status: string }[][];
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface Stats {
  runs: number;
  success: number;
  failed: number;
  /** Başarısız çalıştırmaların nedenlerine göre dağılımı */
  failReasons: [string, number][];
  successRate: number;
  /** İlk reviewer kararı PASS olan çalıştırmaların oranı (reviewer'a ulaşanlar içinde) */
  firstPassRate: number;
  reviewerFailRate: number;
  checkFailRate: number;
  avgIterations: number;
  avgPlanRevisions: number;
  avgChangeRequests: number;
  multiRepoRuns: number;
  scopeFromPlan: number;
  scopeRequests: { total: number; expand: number; continue: number; cancel: number };
  denials: { total: number; runsWithDenials: number; top: [string, number][] };
  cost: { total: number; avg: number; runsCounted: number };
  /** Dakika; sadece başlangıç/bitiş zamanı olan kayıtlar */
  duration: { median: number; runsCounted: number };
}

const ratio = (a: number, b: number) => (b ? a / b : 0);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Hata metnini kaba bir kategoriye indirger (ölçüm için; ayrıntı run.json'da) */
export function failReason(error = ""): string {
  if (/rol ihlali/i.test(error)) return "rol ihlali";
  if (/bütçe (bitti|doldu)/i.test(error)) return "bütçe";
  if (/kapsam/i.test(error)) return "kapsam talebi";
  if (/turda onay alınamadı|turda tamamlanamadı/i.test(error)) return "tur sınırı";
  if (/plan onaylanmadı|plan .* onaylanmadı/i.test(error)) return "plan onaylanmadı";
  if (/değişiklikler onaylanmadı/i.test(error)) return "değişiklik onaylanmadı";
  if (/commit|push/i.test(error)) return "commit/teslim";
  if (/hata ile bitti/i.test(error)) return "ajan hatası";
  return error ? "diğer" : "bilinmiyor";
}

export function computeStats(records: RunRecord[]): Stats {
  // hatasız "failed" kayıt henüz sürmekte olan çalıştırmadır (özet başlangıçta failed yazılır)
  const done = records.filter((r) => r.status === "success" || (r.status === "failed" && !!r.error));
  const success = done.filter((r) => r.status === "success");
  const failed = done.filter((r) => r.status === "failed");

  const reasons = new Map<string, number>();
  for (const r of failed) reasons.set(failReason(r.error), (reasons.get(failReason(r.error)) ?? 0) + 1);

  const reviewerPhases = done.flatMap((r) => (r.phases ?? []).filter((p) => p.role === "reviewer" && p.verdict));
  const reachedReview = done.filter((r) => (r.phases ?? []).some((p) => p.role === "reviewer" && p.verdict));
  const firstPass = reachedReview.filter((r) => (r.phases ?? []).find((p) => p.role === "reviewer" && p.verdict)!.verdict === "PASS");

  let checkRounds = 0;
  let failedChecks = 0;
  for (const r of done) {
    if (r.checkRounds !== undefined) {
      checkRounds += r.checkRounds;
      failedChecks += r.failedCheckRounds ?? 0;
    } else if (r.checks) {
      checkRounds += r.checks.length;
      failedChecks += r.checks.filter((c) => c.some((x) => x.status === "fail")).length;
    }
  }

  const sr = done.flatMap((r) => r.scopeRequests ?? []);
  const denialGroups = new Map<string, number>();
  for (const r of done) for (const d of r.denials ?? []) denialGroups.set(`${d.role} · ${d.tool}`, (denialGroups.get(`${d.role} · ${d.tool}`) ?? 0) + 1);

  // Cursor maliyet bildirmez: ortalamaya sadece Claude çalıştırmaları girer
  const costed = done.filter((r) => r.backend !== "cursor" && typeof r.totalCostUsd === "number");
  const durations = done
    .filter((r) => r.startedAt && r.finishedAt)
    .map((r) => (Date.parse(r.finishedAt!) - Date.parse(r.startedAt!)) / 60000)
    .filter((m) => Number.isFinite(m) && m >= 0);

  return {
    runs: done.length,
    success: success.length,
    failed: failed.length,
    failReasons: [...reasons].sort((a, b) => b[1] - a[1]),
    successRate: ratio(success.length, done.length),
    firstPassRate: ratio(firstPass.length, reachedReview.length),
    reviewerFailRate: ratio(reviewerPhases.filter((p) => p.verdict !== "PASS").length, reviewerPhases.length),
    checkFailRate: ratio(failedChecks, checkRounds),
    avgIterations: avg(done.map((r) => r.iterations ?? 0)),
    avgPlanRevisions: avg(done.map((r) => r.planFeedback?.length ?? 0)),
    avgChangeRequests: avg(done.map((r) => r.changeRequests?.length ?? 0)),
    multiRepoRuns: done.filter((r) => (r.related ?? []).some((x) => x.commits?.length)).length,
    scopeFromPlan: done.filter((r) => r.scope?.fromPlan).length,
    scopeRequests: {
      total: sr.length,
      expand: sr.filter((x) => x.decision === "expand").length,
      continue: sr.filter((x) => x.decision === "continue").length,
      cancel: sr.filter((x) => x.decision === "cancel").length,
    },
    denials: {
      total: done.reduce((n, r) => n + (r.denials?.length ?? 0), 0),
      runsWithDenials: done.filter((r) => r.denials?.length).length,
      top: [...denialGroups].sort((a, b) => b[1] - a[1]).slice(0, 5),
    },
    cost: { total: costed.reduce((n, r) => n + r.totalCostUsd!, 0), avg: avg(costed.map((r) => r.totalCostUsd!)), runsCounted: costed.length },
    duration: { median: median(durations), runsCounted: durations.length },
  };
}

/** Geçmiş + mevcut run.json'lar; id başına son kayıt. since verilirse ondan eski kayıtlar atlanır. */
export function loadRecords(root: string, workDirs: string[], since?: Date): RunRecord[] {
  const byId = new Map<string, RunRecord>();
  const put = (r: RunRecord) => r?.id && byId.set(r.id, r);
  for (const base of workDirs) {
    for (const id of fs.readdirSync(base)) {
      const f = path.join(base, id, "run.json");
      if (!fs.existsSync(f)) continue;
      try {
        put(JSON.parse(fs.readFileSync(f, "utf8")));
      } catch {
        /* bozuk kayıt atlanır */
      }
    }
  }
  // geçmiş dosyası run.json'lardan sonra okunur: bitiş anındaki kayıt kesindir
  const hist = path.join(root, FLOWLOOP_DIR, "history.jsonl");
  if (fs.existsSync(hist)) {
    for (const line of fs.readFileSync(hist, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        put(JSON.parse(line));
      } catch {
        /* yarım satır atlanır */
      }
    }
  }
  const all = [...byId.values()];
  if (!since) return all;
  return all.filter((r) => {
    const t = Date.parse(r.finishedAt ?? r.startedAt ?? "");
    return Number.isFinite(t) ? t >= since.getTime() : false;
  });
}

/** "30d", "2w", "6m" → o kadar önceki tarih */
export function parseSince(v: string, now = new Date()): Date {
  const m = /^(\d+)\s*([dwm])$/i.exec(v.trim());
  if (!m) throw new Error(`--since biçimi: 30d, 2w ya da 6m (verilen: ${v})`);
  const n = Number(m[1]);
  const days = m[2].toLowerCase() === "d" ? n : m[2].toLowerCase() === "w" ? n * 7 : n * 30;
  return new Date(now.getTime() - days * 86400000);
}

const pct = (x: number) => `%${Math.round(x * 100)}`;

export function renderStats(s: Stats, label: string): string {
  if (!s.runs) return `${label}: tamamlanmış çalıştırma yok.`;
  const lines = [
    `${label}: ${s.runs} çalıştırma · ${s.success} başarılı · ${s.failed} başarısız (başarı ${pct(s.successRate)})`,
    "",
    "Kalite",
    `  İlk incelemede PASS     : ${pct(s.firstPassRate)}`,
    `  Reviewer FAIL oranı     : ${pct(s.reviewerFailRate)} (tüm inceleme turları)`,
    `  Otomatik kontrol hatası : ${pct(s.checkFailRate)} (kontrol turları)`,
    `  Ortalama tur            : ${s.avgIterations.toFixed(1)}`,
    "",
    "İnsan müdahalesi",
    `  Plan yorumu (ortalama)  : ${s.avgPlanRevisions.toFixed(1)}`,
    `  Değişiklik isteği (ort.): ${s.avgChangeRequests.toFixed(1)}`,
    `  Kapsam talepleri        : ${s.scopeRequests.total}${s.scopeRequests.total ? ` (genişletildi ${s.scopeRequests.expand} · genişletmeden devam ${s.scopeRequests.continue} · durduruldu ${s.scopeRequests.cancel})` : ""}`,
    "",
    "Yönetişim",
    `  Kapsamı plandan gelen   : ${s.scopeFromPlan} çalıştırma`,
    `  Birden fazla repo       : ${s.multiRepoRuns} çalıştırma`,
    `  Reddedilen işlem        : ${s.denials.total} (${s.denials.runsWithDenials} çalıştırmada)`,
    ...s.denials.top.map(([k, n]) => `    - ${k}: ${n}`),
  ];
  if (s.failReasons.length) lines.push("", "Başarısızlık nedenleri", ...s.failReasons.map(([k, n]) => `  - ${k}: ${n}`));
  lines.push("", "Maliyet ve süre");
  lines.push(s.cost.runsCounted ? `  Maliyet                 : $${s.cost.total.toFixed(2)} toplam · $${s.cost.avg.toFixed(2)} ortalama (${s.cost.runsCounted} Claude çalıştırması)` : "  Maliyet                 : — (Cursor maliyet bildirmez)");
  lines.push(s.duration.runsCounted ? `  Süre (medyan)           : ${s.duration.median.toFixed(0)} dk (${s.duration.runsCounted} çalıştırma; onay bekleme dahil)` : "  Süre                    : — (eski kayıtlarda zaman bilgisi yok)");
  return lines.join("\n");
}
