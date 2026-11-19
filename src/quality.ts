/**
 * Aşama kalitesi: analiz, test (otomatik kontroller), geliştirme (reviewer) ve kullanıcı onayında
 * ilk seferde başarı ve rework (bir aşamanın işi geri gönderip yeniden yaptırması).
 * Çalıştırma kaydındaki alanlardan hesaplanır; eski kayıtlarda bulunamayanlar boş kalır.
 */

export interface StageQuality {
  /** İlk seferde geçti mi; aşama hiç çalışmadıysa null */
  firstTime: boolean | null;
  /** Bu aşama yüzünden yapılan tekrar sayısı */
  rework: number;
}

export interface RunQuality {
  analysis: StageQuality & { revisions: number; restarts: number; breakdownFixes: number; /** kırılımda: değişen dosyaların plandaki dosya listesiyle örtüşme oranı (0-1) */ fileAccuracy?: number };
  test: StageQuality & { rounds: number; passed: number; testFails: number; noTests: number };
  dev: StageQuality & { reviews: number; fails: number };
  human: StageQuality & { changeRequests: number; triageFixes: number };
  rework: number;
}

/** Görev başına (iş kırılımı) ölçüm */
export interface TaskQuality {
  checkFails?: number;
  reviewFails?: number;
  filesChanged?: number;
  filesOutside?: string[];
}

/** Hesap için gereken kayıt alanları (RunSummary ve geçmiş kaydı ikisi de uyar) */
export interface QualitySource {
  planReviewed?: boolean;
  planFeedback?: unknown[];
  planRestarts?: number;
  breakdownFixes?: number;
  checks?: { name: string; status: string; summary?: string }[][];
  checkRounds?: number;
  failedCheckRounds?: number;
  phases?: { role: string; verdict?: string }[];
  changesReviewed?: boolean;
  changeRequests?: unknown[];
  triage?: { choice: string }[];
  breakdown?: { tasks: (TaskQuality & { status: string })[] };
}

export function computeQuality(s: QualitySource): RunQuality {
  const revisions = s.planFeedback?.length ?? 0;
  const restarts = s.planRestarts ?? 0;
  const breakdownFixes = s.breakdownFixes ?? 0;
  const done = (s.breakdown?.tasks ?? []).filter((t) => t.status === "done" && t.filesChanged);
  const changedFiles = done.reduce((n, t) => n + (t.filesChanged ?? 0), 0);
  const outside = done.reduce((n, t) => n + (t.filesOutside?.length ?? 0), 0);

  const rounds = s.checks?.length ?? s.checkRounds ?? 0;
  const failedRounds = s.checks ? s.checks.filter((r) => r.some((c) => c.status === "fail")).length : s.failedCheckRounds ?? 0;
  const testFails = (s.checks ?? []).filter((r) => r.some((c) => c.name === "testler" && c.status === "fail")).length;
  const noTests = (s.checks ?? []).flat().filter((c) => /HİÇ TEST KOŞMADI/.test(c.summary ?? "")).length;
  const firstRound = s.checks?.[0];

  const verdicts = (s.phases ?? []).filter((p) => p.role === "reviewer" && p.verdict).map((p) => p.verdict!);
  const fails = verdicts.filter((v) => v !== "PASS").length;

  const changeRequests = s.changeRequests?.length ?? 0;
  const triageFixes = (s.triage ?? []).filter((t) => t.choice === "fix").length;

  const q: RunQuality = {
    analysis: {
      firstTime: s.planReviewed ? revisions + restarts === 0 : null,
      rework: revisions + restarts + breakdownFixes,
      revisions,
      restarts,
      breakdownFixes,
      ...(changedFiles ? { fileAccuracy: (changedFiles - outside) / changedFiles } : {}),
    },
    test: {
      firstTime: firstRound ? !firstRound.some((c) => c.status === "fail") : null,
      rework: failedRounds,
      rounds,
      passed: rounds - failedRounds,
      testFails,
      noTests,
    },
    dev: { firstTime: verdicts.length ? verdicts[0] === "PASS" : null, rework: fails, reviews: verdicts.length, fails },
    // "bu işte düzelt" seçilen inceleme maddeleri değişiklik isteğine dönüşür: ayrıca sayılmaz
    human: { firstTime: s.changesReviewed ? changeRequests === 0 : null, rework: changeRequests, changeRequests, triageFixes },
    rework: 0,
  };
  q.rework = q.analysis.rework + q.test.rework + q.dev.rework + q.human.rework;
  return q;
}

const mark = (x: boolean | null) => (x === null ? "—" : x ? "✓ ilk seferde" : "✗");

/** Çalıştırma sonunda tek blok: aşama aşama başarı ve rework */
export function qualityReport(q: RunQuality): string {
  const a = q.analysis;
  const t = q.test;
  const d = q.dev;
  const h = q.human;
  const lines = [
    "Kalite",
    `  Analiz      : ${mark(a.firstTime)}${a.revisions ? ` · ${a.revisions} plan yorumu` : ""}${a.restarts ? ` · ${a.restarts} baştan analiz` : ""}${a.breakdownFixes ? ` · kırılım ${a.breakdownFixes} kez düzeltildi` : ""}${a.fileAccuracy !== undefined ? ` · dosya tahmini %${Math.round(a.fileAccuracy * 100)}` : ""}`,
    `  Test        : ${t.rounds ? `${t.passed}/${t.rounds} kontrol turu geçti${t.firstTime ? " (ilk turda)" : ""}` : "—"}${t.rework ? ` · ${t.rework} rework${t.testFails ? ` (testlerden: ${t.testFails})` : ""}` : ""}${t.noTests ? ` · ${t.noTests} kez hiç test koşmadı` : ""}`,
    `  Geliştirme  : ${d.reviews ? (d.firstTime ? "✓ ilk incelemede PASS" : `${d.reviews}. incelemede ${d.fails < d.reviews ? "PASS" : "PASS yok"}`) : "—"}${d.rework ? ` · ${d.rework} rework` : ""}`,
    `  Senin onayın: ${mark(h.firstTime)}${h.changeRequests ? ` · ${h.changeRequests} değişiklik isteği${h.triageFixes ? ` (${h.triageFixes} inceleme maddesinden)` : ""}` : ""}`,
    `  Toplam rework: ${q.rework}`,
  ];
  return lines.join("\n");
}
