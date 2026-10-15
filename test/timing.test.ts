import { test } from "node:test";
import assert from "node:assert/strict";
import { Stopwatch, fmtDuration, timingReport, totals } from "../src/timing.js";
import { computeStats, renderStats, type RunRecord } from "../src/stats.js";

test("süre: iç içe ölçümde her süre bir kez sayılır, kullanıcı beklemesi ayrılır", async () => {
  let t = 0;
  const sw = new Stopwatch([], () => t);
  const ask = sw.human("plan onayı", async () => {
    t += 30_000; // kullanıcı 30 sn düşündü
    return "ok";
  })!;
  await sw.timeAsync("analist", "agent", async () => {
    t += 60_000;
    await ask();
    t += 10_000;
  });
  sw.time("testler", "check", () => {
    t += 5_000;
  }, { iteration: 1 });
  const tot = totals(sw.entries);
  assert.equal(tot.agent, 70_000);
  assert.equal(tot.human, 30_000);
  assert.equal(tot.check, 5_000);
  sw.carve(sw.entries.findIndex((e) => e.step === "analist"), { step: "mutasyon testleri", kind: "check", ms: 20_000 });
  assert.equal(totals(sw.entries).agent, 50_000);
  assert.equal(totals(sw.entries).check, 25_000);
  const rep = timingReport(sw.entries, 110_000);
  assert.match(rep, /toplam 1:50 · makine 1:20 · senin cevabın 0:30/);
  assert.match(rep, /0:50\s+analist/);
});

test("süre biçimi", () => {
  assert.equal(fmtDuration(75_000), "1:15");
  assert.equal(fmtDuration(3_723_000), "1:02:03");
  assert.equal(fmtDuration(400), "0:00");
});

test("stats: süre dağılımı ve en uzun adımlar", () => {
  const rec = (id: string, agentMs: number, checkMs: number, humanMs: number): RunRecord => ({
    id,
    status: "success",
    durationMs: agentMs + checkMs + humanMs,
    timings: [
      { step: "developer", kind: "agent", ms: agentMs },
      { step: "tip kontrolü", kind: "check", ms: checkMs },
      { step: "plan onayı", kind: "human", ms: humanMs },
    ],
  });
  const s = computeStats([rec("a", 600_000, 300_000, 60_000), rec("b", 400_000, 100_000, 0), { id: "eski", status: "success" }]);
  assert.equal(s.time.runsCounted, 2);
  assert.equal(s.time.byKind.agent, 500_000);
  assert.deepEqual(s.time.slowSteps[0], ["developer", 500_000]);
  assert.match(renderStats(s, "x"), /En uzun adımlar[\s\S]*8:20\s+developer/);
});
