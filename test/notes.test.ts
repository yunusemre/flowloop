import { test } from "node:test";
import assert from "node:assert/strict";
import { collectAttention, extractAssumptions, parseHandoff, parseOpenQuestions, parseReviewerNotes } from "../src/notes.js";

test("açık sorular: biçimli, numarasız ve 'Yok'", () => {
  const plan = "## Kabul kriterleri\nAK-1\n\n## Açık sorular\n- S-1: A mı B mi?\n  Neden önemli: yanlış ekran\n  Cevap gelmezse: A\n- **S2:** Limit kaç?\n\n## Riskler\n- r\n";
  assert.deepEqual(parseOpenQuestions(plan), [
    { id: "S-1", text: "A mı B mi?\nNeden önemli: yanlış ekran", fallback: "A" },
    { id: "S-2", text: "Limit kaç?", fallback: undefined },
  ]);
  assert.deepEqual(parseOpenQuestions("## Açık sorular\nYok\n"), []);
  assert.deepEqual(parseOpenQuestions("## Acik sorular\n- Yok.\n"), []);
  assert.deepEqual(parseOpenQuestions("## Riskler\n- x\n"), []);
  assert.deepEqual(parseOpenQuestions("### Open questions\n1. Which API?\n2. Timeout?\n").map((q) => q.id), ["S-1", "S-2"]);
});

test("açık sorular: revizyonda alta eklenen son bölüm geçerlidir", () => {
  assert.deepEqual(parseOpenQuestions("## Açık sorular\n- S-1: eski\n\n## Geri bildirime yanıt\nx\n\n## Açık sorular\nYok\n"), []);
});

test("varsayımlar plandan toplanır, tekrarlar atılır", () => {
  assert.deepEqual(extractAssumptions("AK-1 x\n  Varsayım: liste 20'şerli\n- **Varsayım:** liste 20'şerli\nVarsayım: yok\nVarsayılan: değil\n"), ["liste 20'şerli"]);
});

test("Handoff: riskler, atlananlar ve önceden var olanlar; none/yok atlanır", () => {
  const t = "Bitti.\n\n## Handoff\nChanged: a.ts: x\nChecked: AK-1 → a.test.ts\nSkipped / not checked: none\nRisks: web etkilenebilir; mobil eski sürüm\nPre-existing issues seen (not touched):\n  - b.ts lint\n  - c.ts tip\n";
  assert.deepEqual(parseHandoff(t), [
    { from: "developer", kind: "risk", text: "web etkilenebilir" },
    { from: "developer", kind: "risk", text: "mobil eski sürüm" },
    { from: "developer", kind: "preexisting", text: "b.ts lint" },
    { from: "developer", kind: "preexisting", text: "c.ts tip" },
  ]);
  assert.deepEqual(parseHandoff("Handoff yok"), []);
});

test("reviewer notları ve birleşik liste (tekrar yok)", () => {
  const r = "✅\n## İncelenmesi önerilenler\n- Cihazda dene\n- Yok\nVERDICT: PASS";
  assert.deepEqual(parseReviewerNotes(r), [{ from: "reviewer", kind: "review", text: "Cihazda dene" }]);
  assert.deepEqual(parseReviewerNotes("## İncelenmesi önerilenler\nYok\n\nVERDICT: PASS"), []);
  const all = collectAttention("## Handoff\nRisks: x\nRisks: x\n", r);
  assert.deepEqual(all.map((a) => a.text), ["Cihazda dene", "x"]);
});
