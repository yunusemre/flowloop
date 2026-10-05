import { test } from "node:test";
import assert from "node:assert/strict";
import { ScopedChecks, newLines, normalize, type CheckRunner } from "../src/checks.js";
import { configSchema } from "../src/config.js";

const cfg = configSchema.parse({
  version: 2,
  commands: { testRelated: "jest --findRelatedTests {{files}}", typecheck: "tsc", lint: "eslint {{files}}", format: "prettier --write {{files}}" },
  paths: { edit: ["src/**"] },
});

/** cwd + komut önekine göre sahte çıktı döndüren koşucu */
function fake(map: Record<string, { code: number; out: string }>): CheckRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run(cmd, cwd) {
      calls.push(`${cwd}$ ${cmd}`);
      const key = Object.keys(map).find((k) => `${cwd}$ ${cmd}`.startsWith(k));
      const r = key ? map[key] : { code: 0, out: "" };
      return { code: r.code, stdout: r.out, stderr: "" };
    },
  };
}

test("normalize: satır/sütun ve kök klasör silinir", () => {
  const a = normalize("/w/wt/src/a.tsx(12,5): error TS2322: x\n/w/wt/src/a.tsx:3:1: error bad [rule]", ["/w/wt", "/w/base"]);
  assert.deepEqual(a, ["src/a.tsx: error TS2322: x", "src/a.tsx: error bad [rule]"]);
  assert.deepEqual(newLines(["a", "a", "b"], ["a"]), ["a", "b"]);
});

const many = (n: number, file = "src/old.tsx") => Array.from({ length: n }, (_, i) => `${file}(${i + 1},1): error TS2322: eski hata ${i}`).join("\n");

test("tip: projede var olan 200 hata bloklamaz, kod kaysa bile", () => {
  const shifted = Array.from({ length: 200 }, (_, i) => `src/old.tsx(${i + 40},1): error TS2322: eski hata ${i}`).join("\n");
  const r = new ScopedChecks(cfg, "/w/wt", "/w/base", fake({ "/w/base$ tsc": { code: 2, out: many(200) }, "/w/wt$ tsc": { code: 2, out: shifted } })).typecheck(["src/a.tsx"]);
  assert.equal(r.status, "ok");
  assert.match(r.summary, /200 hata kapsam dışı/);
});

test("tip: bu işle gelen hata (başka dosyada bile) bloklar", () => {
  const after = many(200) + "\nsrc/consumer.tsx(3,1): error TS2345: imza değişti";
  const r = new ScopedChecks(cfg, "/w/wt", "/w/base", fake({ "/w/base$ tsc": { code: 2, out: many(200) }, "/w/wt$ tsc": { code: 2, out: after } })).typecheck(["src/a.tsx"]);
  assert.equal(r.status, "fail");
  assert.match(r.details!, /consumer\.tsx: error TS2345/);
});

test("lint: sadece değişen dosyalar ve sadece yeni bulgular", () => {
  const base = "/w/base/src/a.tsx\n  3:1  error  eski  rule-a";
  const after = "/w/wt/src/a.tsx\n  9:1  error  eski  rule-a\n  10:2  error  yeni  rule-b";
  const runner = fake({ "/w/base$ eslint": { code: 1, out: base }, "/w/wt$ eslint": { code: 1, out: after } });
  const r = new ScopedChecks(cfg, "/w/wt", "/w/base", runner).lint(["src/a.tsx", "src/new.tsx"], ["src/a.tsx"]);
  assert.equal(r.status, "fail");
  assert.equal(r.details, "error yeni rule-b");
  assert.ok(runner.calls.some((c) => c === "/w/wt$ eslint 'src/a.tsx' 'src/new.tsx'"));
  assert.ok(runner.calls.some((c) => c === "/w/base$ eslint 'src/a.tsx'"));
});

test("lint: uyarılar bloklamaz, sadece yeni HATALAR sayılır", () => {
  const after = "/w/wt/src/a.tsx\n  9:1  warning  Missing trailing comma  comma-dangle\n\n✖ 1 problem (0 errors, 1 warning)";
  const runner = fake({ "/w/base$ eslint": { code: 0, out: "" }, "/w/wt$ eslint": { code: 0, out: after } });
  const r = new ScopedChecks(cfg, "/w/wt", "/w/base", runner).lint(["src/a.tsx"], ["src/a.tsx"]);
  assert.equal(r.status, "ok");
});

test("testler: sadece ilgili testler; base'de de aynı kırmızıysa bloklamaz", () => {
  const out = "FAIL src/old.test.ts\n  ✕ eski kırık test (5 ms)";
  const r = new ScopedChecks(cfg, "/w/wt", "/w/base", fake({ "/w/wt$ jest": { code: 1, out }, "/w/base$ jest": { code: 1, out: out.replace("5 ms", "9 ms") } })).tests(["src/a.ts"], ["src/a.ts"]);
  assert.equal(r.status, "ok");
  const r2 = new ScopedChecks(cfg, "/w/wt", "/w/base", fake({ "/w/wt$ jest": { code: 1, out: out + "\n  ✕ yeni test" }, "/w/base$ jest": { code: 1, out } })).tests(["src/a.ts"], ["src/a.ts"]);
  assert.equal(r2.status, "fail");
  assert.match(r2.details!, /yeni test/);
});

test("testFiles kullanan komutta test dosyası yoksa başarısız", () => {
  const c2 = configSchema.parse({ version: 2, commands: { testRelated: "node --test {{testFiles}}" }, paths: { edit: ["src/**"] } });
  const r = new ScopedChecks(c2, "/w/wt", "/w/base", fake({})).tests(["src/a.js"], []);
  assert.equal(r.status, "fail");
});
