import { test } from "node:test";
import assert from "node:assert/strict";
import { breakdownTable, focusNote, orderTasks, parseBreakdown, planAks, pointBudget, usesBreakdown, validateBreakdown } from "../src/breakdown.js";
import { markdownToWiki } from "../src/jira.js";

const PLAN = `# Plan

## Kabul kriterleri
- AK-1: normalize
- AK-2: sabit hat reddi
- AK-3: portal mesajı

## İş kırılımı
| Görev | Başlık | AK | Dosyalar | Bağımlı | Puan |
|---|---|---|---|---|---|
| T3 | Portal hata mesajı | AK-3 | \`web/src/Gsm*.tsx\` | T1 | 3 |
| T1 | GSM normalize yardımcısı | AK-1 | src/Common/Gsm.cs, test/GsmTests.cs | — | 1 |
| T2 | Kayıtta doğrulama | AK-1, AK-2 | src/Users/** | T1 | 2 |

## Riskler
Yok
`;

test("iş kırılımı: tablo okunur, sıra bağımlılıkla kurulur, kurallar doğrulanır", () => {
  const t = parseBreakdown(PLAN)!;
  assert.equal(t.length, 3);
  assert.deepEqual(t[1], { id: "T1", title: "GSM normalize yardımcısı", ak: ["AK-1"], files: ["src/Common/Gsm.cs", "test/GsmTests.cs"], deps: [], points: 1 });
  assert.deepEqual(t[0].files, ["web/src/Gsm*.tsx"]);
  assert.deepEqual(planAks(PLAN), ["AK-1", "AK-2", "AK-3"]);
  assert.deepEqual(orderTasks(t).map((x) => x.id), ["T1", "T3", "T2"], "bağımlılığı biten, tablodaki sırayla");
  assert.deepEqual(validateBreakdown(t, planAks(PLAN)), []);
  assert.ok(usesBreakdown(t));
  assert.equal(parseBreakdown("# Plan\n## Kabul kriterleri\n- AK-1"), undefined);

  const bad = validateBreakdown(
    [
      { id: "T1", title: "a", ak: ["AK-1"], files: ["src/a.ts"], deps: ["T2"], points: 13 },
      { id: "T2", title: "b", ak: ["AK-1"], files: [], deps: ["T1", "T9"], points: 4 },
      { id: "T3", title: "c", ak: ["AK-1"], files: ["web/x.ts"], deps: [], points: 1 },
    ],
    ["AK-1", "AK-2"],
    ["src/**", "test/**"],
  );
  const all = bad.join("\n");
  assert.match(all, /T1: puan 13; 1, 2, 3, 5 ya da 8/);
  assert.match(all, /T2: puan 4/);
  assert.match(all, /T2: dosya sütunu boş/);
  assert.match(all, /T2: bağımlı olduğu T9 kırılımda yok/);
  assert.match(all, /T3: web\/x\.ts developer'ın yazabileceği yollar dışında/);
  assert.match(all, /AK-2 hiçbir görevde yok/);
  assert.match(all, /döngü var: T1 → T2 → T1/);
});

test("iş kırılımı: küçük iş kırılımsız; bütçe puanla ölçeklenir; odak notu ve tablo", () => {
  const one = [{ id: "T1", title: "a", ak: ["AK-1"], files: ["a"], deps: [], points: 2 }];
  assert.equal(usesBreakdown(one), false);
  assert.equal(usesBreakdown([...one, { ...one[0], id: "T2", points: 1 }]), false, "toplam 3 puan: küçük iş");
  assert.equal(usesBreakdown([...one, { ...one[0], id: "T2", points: 2 }]), true);
  assert.equal(pointBudget(1, 4), 2);
  assert.equal(pointBudget(8, 4), 8);
  const st = orderTasks(parseBreakdown(PLAN)!).map((t, i) => ({ ...t, status: i === 0 ? ("done" as const) : ("pending" as const), iterations: i === 0 ? 2 : undefined }));
  const dev = focusNote(st[1], st, "developer");
  assert.match(dev, /Şu anki görev: T3\/3 — Portal hata mesajı \(puan 3\)/);
  assert.match(dev, /Tamamlanan ve onaylanan görevler: T1/);
  assert.match(dev, /SADECE T3 görevini yap; sonraki görevlere \(T2\) geçme/);
  assert.match(focusNote(st[1], st, "reviewer"), /Sonraki görevlerin \(T2\) eksikliği FAIL sebebi değildir/);
  assert.match(breakdownTable(st), /\| T1 \| GSM normalize yardımcısı \| AK-1 \| 1 \| 2 \|/);
});

test("Jira: markdown tablo wiki tablosuna çevrilir", () => {
  assert.equal(markdownToWiki("| Görev | Puan |\n|---|---|\n| `T1` | 2 |\nmetin"), "||Görev||Puan||\n|{{T1}}|2|\nmetin");
});

test("stats: puan başına onaylanan görevlerin turu, maliyeti ve süresi", async () => {
  const { computeStats, renderStats } = await import("../src/stats.js");
  const rec = (tasks: { points: number; status: string; iterations: number; costUsd: number; durationMs: number }[]) => ({ id: Math.random().toString(), status: "success", breakdown: { tasks } });
  const st = computeStats([
    rec([{ points: 1, status: "done", iterations: 1, costUsd: 0.2, durationMs: 60_000 }, { points: 3, status: "done", iterations: 2, costUsd: 1, durationMs: 300_000 }]),
    rec([{ points: 3, status: "done", iterations: 4, costUsd: 2, durationMs: 600_000 }, { points: 5, status: "pending", iterations: 0, costUsd: 0, durationMs: 0 }]),
  ]);
  assert.equal(st.points.tasks, 3);
  assert.deepEqual(st.points.byPoints.map((b) => [b.points, b.tasks, b.avgIterations, b.avgCost]), [[1, 1, 1, 0.2], [3, 2, 3, 1.5]]);
  assert.match(renderStats(st, "Test"), /İş kırılımı \(2 çalıştırma · 3 onaylanan görev\)\n  Puan  Görev  Tur   Rework   Maliyet  Süre\n     1      1  1.0     0.0     \$0.20/);
});
