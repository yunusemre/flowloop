import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeScope, expandableRepos, parseRepoScope, resolveScope, takeScopeRequest } from "../src/scope.js";
import { computeStats, failReason, loadRecords, parseSince, renderStats, type RunRecord } from "../src/stats.js";

const repos = [
  { name: "backend", ceiling: ["src/**"] },
  { name: "web", ceiling: ["app/**"] },
  { name: "shared", ceiling: [] },
];

test("parseRepoScope: satırları, açıklamaları ve bölüm sonunu okur", () => {
  const plan = "# Plan\n\n## Repo kapsamı\n- backend: yazılabilir\n- `web`: salt okunur (sadece tipler okunacak)\n* shared: Yazilabilir.\n- bozuk satır\n\n## Riskler\n- web: yazılabilir\n";
  const m = parseRepoScope(plan)!;
  assert.equal(m.get("backend"), true);
  assert.equal(m.get("web"), false, "sonraki bölümdeki satır sayılmaz");
  assert.equal(m.get("shared"), true);
  assert.equal(m.size, 3);
  assert.equal(parseRepoScope("# Plan\n## Kabul kriterleri\n"), undefined);
});

test("resolveScope: bölüm yoksa hepsi salt okunur, varsa sadece daraltır; tavan aşılamaz", () => {
  const none = resolveScope("# Plan\n", repos);
  assert.equal(none.fromPlan, false);
  assert.deepEqual(none.edit, { backend: [], web: [], shared: [] });
  assert.equal(none.warnings.length, 1);
  assert.match(describeScope(none, repos), /planda belirtilmedi.*backend: salt okunur/);
  assert.deepEqual(expandableRepos(none.edit, repos), ["backend", "web"], "kapsam talebiyle yine genişletilebilir");
  assert.deepEqual(resolveScope("# Plan\n", [{ name: "shared", ceiling: [] }]).warnings, [], "tavanı olmayan repolar için uyarı gereksiz");

  const plan = "## Repo kapsamı\n- backend: yazılabilir\n- shared: yazılabilir\n- mobil: yazılabilir\n- ana proje: yazılabilir\n";
  const s = resolveScope(plan, repos);
  assert.equal(s.fromPlan, true);
  assert.deepEqual(s.edit, { backend: ["src/**"], web: [], shared: [] }, "listede olmayan web salt okunur; shared'in tavanı yok");
  assert.ok(s.warnings.some((w) => /shared.*tavan aşılamaz/.test(w)));
  assert.ok(s.warnings.some((w) => /"mobil"/.test(w)));
  assert.ok(!s.warnings.some((w) => /ana proje/.test(w)), "ana proje satırı uyarı üretmez");
  assert.match(describeScope(s, repos), /plandan.*backend: yazılabilir \(src\/\*\*\) · web: salt okunur/);
  assert.deepEqual(expandableRepos(s.edit, repos), ["web"]);
});

test("takeScopeRequest: talebi kayda ekler ve dosyayı kaldırır; boş dosya talep değildir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-scope-"));
  assert.equal(takeScopeRequest(dir, 1), undefined);
  fs.writeFileSync(path.join(dir, "scope-request.md"), "  \n");
  assert.equal(takeScopeRequest(dir, 1), undefined);
  fs.writeFileSync(path.join(dir, "scope-request.md"), "backend değişmeli");
  assert.deepEqual(takeScopeRequest(dir, 2), { turn: 2, text: "backend değişmeli" });
  assert.ok(!fs.existsSync(path.join(dir, "scope-request.md")));
  assert.match(fs.readFileSync(path.join(dir, "scope-requests.md"), "utf8"), /## Tur 2\nbackend değişmeli/);
});

const rec = (o: Partial<RunRecord>): RunRecord => ({ id: Math.random().toString(36).slice(2), status: "success", backend: "claude", ...o });

test("computeStats: oranlar, sürmekte olan kayıtlar ve Cursor maliyeti", () => {
  const records: RunRecord[] = [
    rec({ iterations: 1, totalCostUsd: 2, phases: [{ role: "reviewer", verdict: "PASS" }], startedAt: "2026-10-01T10:00:00Z", finishedAt: "2026-10-01T10:20:00Z", checkRounds: 1, failedCheckRounds: 0 }),
    rec({ iterations: 2, totalCostUsd: 4, phases: [{ role: "reviewer", verdict: "FAIL" }, { role: "reviewer", verdict: "PASS" }], planFeedback: [{}], startedAt: "2026-10-01T10:00:00Z", finishedAt: "2026-10-01T10:40:00Z", scope: { fromPlan: true }, related: [{ commits: ["a"] }], checkRounds: 3, failedCheckRounds: 1 }),
    rec({ status: "failed", error: "3 turda onay alınamadı.", iterations: 3, totalCostUsd: 6, phases: [{ role: "reviewer", verdict: "FAIL" }], denials: [{ role: "developer", tool: "Bash" }, { role: "developer", tool: "Bash" }], scopeRequests: [{ decision: "continue" }, { decision: "expand" }] }),
    rec({ backend: "cursor", totalCostUsd: 0, iterations: 1, phases: [{ role: "reviewer", verdict: "PASS" }] }),
    rec({ status: "failed" }), // sürmekte (hata yok): sayılmaz
  ];
  const s = computeStats(records);
  assert.equal(s.runs, 4);
  assert.equal(s.success, 3);
  assert.equal(s.failed, 1);
  assert.equal(s.firstPassRate, 2 / 4);
  assert.equal(s.reviewerFailRate, 2 / 5);
  assert.equal(s.checkFailRate, 1 / 4);
  assert.equal(s.avgIterations, 7 / 4);
  assert.equal(s.cost.runsCounted, 3, "Cursor maliyete girmez");
  assert.equal(s.cost.total, 12);
  assert.equal(s.duration.median, 30);
  assert.equal(s.multiRepoRuns, 1);
  assert.equal(s.scopeFromPlan, 1);
  assert.deepEqual(s.scopeRequests, { total: 2, expand: 1, continue: 1, cancel: 0 });
  assert.deepEqual(s.denials.top, [["developer · Bash", 2]]);
  assert.deepEqual(s.failReasons, [["tur sınırı", 1]]);
  const text = renderStats(s, "Tüm kayıtlar");
  assert.match(text, /4 çalıştırma · 3 başarılı · 1 başarısız \(başarı %75\)/);
  assert.match(text, /İlk incelemede PASS\s+: %50/);
  assert.match(renderStats(computeStats([]), "Son 30d"), /tamamlanmış çalıştırma yok/);
});

test("failReason ve parseSince", () => {
  assert.equal(failReason("Reviewer gerçek dosyaları değiştirdi! Rol ihlali."), "rol ihlali");
  assert.equal(failReason("Bütçe bitti (gelistir)."), "bütçe");
  assert.equal(failReason("analist için ayrılan bütçe doldu"), "bütçe");
  assert.equal(failReason("Kapsam talebi kabul edilmedi"), "kapsam talebi");
  assert.equal(failReason("Plan onaylanmadı. Plan saklandı"), "plan onaylanmadı");
  const now = new Date("2026-10-31T00:00:00Z");
  assert.equal(parseSince("30d", now).toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(parseSince("2w", now).toISOString(), "2026-10-17T00:00:00.000Z");
  assert.throws(() => parseSince("dün"), /--since biçimi/);
});

test("loadRecords: geçmiş run.json'ı ezer, since filtresi uygulanır", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-stats-"));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-statswork-"));
  fs.mkdirSync(path.join(work, "a"));
  fs.writeFileSync(path.join(work, "a", "run.json"), JSON.stringify({ id: "a", status: "failed", startedAt: "2026-10-01T00:00:00Z" }));
  fs.mkdirSync(path.join(work, "b"));
  fs.writeFileSync(path.join(work, "b", "run.json"), JSON.stringify({ id: "b", status: "success", finishedAt: "2026-08-01T00:00:00Z" }));
  fs.mkdirSync(path.join(root, ".flowloop"));
  fs.writeFileSync(path.join(root, ".flowloop/history.jsonl"), `${JSON.stringify({ id: "a", status: "failed", error: "x", finishedAt: "2026-10-02T00:00:00Z" })}\n{bozuk\n${JSON.stringify({ id: "a", status: "success", finishedAt: "2026-10-03T00:00:00Z" })}\n`);
  const all = loadRecords(root, [work]);
  assert.equal(all.length, 2);
  assert.equal(all.find((r) => r.id === "a")!.status, "success", "son kayıt geçerli");
  assert.deepEqual(loadRecords(root, [work], new Date("2026-09-01T00:00:00Z")).map((r) => r.id), ["a"]);
});
