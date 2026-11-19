import { test } from "node:test";
import assert from "node:assert/strict";
import { computeQuality, qualityReport } from "../src/quality.js";
import { computeStats, renderStats } from "../src/stats.js";

const ok = (name = "testler") => ({ name, status: "ok", summary: "" });
const bad = (name = "testler", summary = "") => ({ name, status: "fail", summary });

test("kalite: aşama aşama ilk seferde başarı ve rework", () => {
  const q = computeQuality({
    planReviewed: true,
    planFeedback: [{}],
    breakdownFixes: 1,
    checks: [[ok("format"), bad()], [ok("format"), bad("testler", "komut başarılı döndü ama HİÇ TEST KOŞMADI (x)")], [ok("format"), ok(), bad("tip")], [ok(), ok("tip")]],
    phases: [{ role: "analist" }, { role: "reviewer", verdict: "FAIL" }, { role: "reviewer", verdict: "PASS" }],
    changesReviewed: true,
    changeRequests: [{}],
    triage: [{ choice: "fix" }, { choice: "skip" }],
    breakdown: { tasks: [{ status: "done", filesChanged: 4, filesOutside: ["src/x.ts"] }, { status: "done", filesChanged: 4, filesOutside: [] }] },
  });
  assert.deepEqual(q.analysis, { firstTime: false, rework: 2, revisions: 1, restarts: 0, breakdownFixes: 1, fileAccuracy: 7 / 8 });
  assert.deepEqual(q.test, { firstTime: false, rework: 3, rounds: 4, passed: 1, testFails: 2, noTests: 1 });
  assert.deepEqual(q.dev, { firstTime: false, rework: 1, reviews: 2, fails: 1 });
  assert.deepEqual(q.human, { firstTime: false, rework: 1, changeRequests: 1, triageFixes: 1 });
  assert.equal(q.rework, 7);
  const r = qualityReport(q);
  assert.match(r, /Analiz      : ✗ · 1 plan yorumu · kırılım 1 kez düzeltildi · dosya tahmini %88/);
  assert.match(r, /Test        : 1\/4 kontrol turu geçti · 3 rework \(testlerden: 2\) · 1 kez hiç test koşmadı/);
  assert.match(r, /Geliştirme  : 2\. incelemede PASS · 1 rework/);
  assert.match(r, /Senin onayın: ✗ · 1 değişiklik isteği \(1 inceleme maddesinden\)/);
  assert.match(r, /Toplam rework: 7/);

  const clean = qualityReport(computeQuality({ planReviewed: true, checks: [[ok()]], phases: [{ role: "reviewer", verdict: "PASS" }], changesReviewed: true }));
  assert.match(clean, /Analiz      : ✓ ilk seferde\n  Test        : 1\/1 kontrol turu geçti \(ilk turda\)\n  Geliştirme  : ✓ ilk incelemede PASS\n  Senin onayın: ✓ ilk seferde\n  Toplam rework: 0/);
  // plan onaya sunulmadıysa analiz "—"
  assert.equal(computeQuality({}).analysis.firstTime, null);
});

test("stats: aşama başarısı ve rework; eski kayıtlar mevcut alanlardan hesaplanır", () => {
  const st = computeStats([
    { id: "a", status: "success", planReviewed: true, planFeedback: [], checks: [[ok()]], phases: [{ role: "reviewer", verdict: "PASS" }], changesReviewed: true, changeRequests: [] },
    { id: "b", status: "success", planReviewed: true, planFeedback: [{}, {}], checks: [[bad()], [ok()]], phases: [{ role: "reviewer", verdict: "FAIL" }, { role: "reviewer", verdict: "PASS" }], changesReviewed: true, changeRequests: [{}] },
    // eski kayıt: kalite alanları yok, sadece geçmişteki sayılar
    { id: "c", status: "failed", error: "x", checkRounds: 2, failedCheckRounds: 2, phases: [] },
  ]);
  assert.deepEqual(st.stages.analysis, { firstTimeRate: 0.5, runsCounted: 2, avgRework: 2 / 3, fileAccuracy: null });
  assert.equal(st.stages.test.avgRework, 1);
  assert.equal(st.stages.test.firstTimeRate, 0.5, "eski kayıtta ilk tur bilinmiyor");
  assert.equal(st.stages.test.passRate, 2 / 5);
  assert.equal(st.stages.dev.firstTimeRate, 0.5);
  assert.equal(st.stages.avgRework, (0 + 5 + 2) / 3);
  assert.equal(st.stages.top, "test");
  const out = renderStats(st, "Test");
  assert.match(out, /Aşama başarısı ve rework[^\n]*\n  Analiz       : %50 ilk seferde  · 0\.7 rework\n  Test         : %50 ilk seferde  · 1\.0 rework · kontrol turu geçme oranı %40 · 1 test kırmızısı/);
  assert.match(out, /Toplam rework: 2\.3 \/ çalıştırma · en çok: test/);
});
