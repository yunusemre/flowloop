import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitRemote, updateNotice } from "../src/update.js";

test("gitRemote: kaynak adresini ayrıştırır", () => {
  assert.deepEqual(gitRemote("git+ssh://git@bitbucket.org/sendeotech/kgflow.git"), { url: "ssh://git@bitbucket.org/sendeotech/kgflow.git", ref: "HEAD" });
  assert.deepEqual(gitRemote("git+ssh://git@bitbucket.org/x/kgflow.git#develop"), { url: "ssh://git@bitbucket.org/x/kgflow.git", ref: "develop" });
  assert.deepEqual(gitRemote("git@bitbucket.org:x/kgflow.git"), { url: "git@bitbucket.org:x/kgflow.git", ref: "HEAD" });
  assert.equal(gitRemote("https://example.com/kgflow-0.2.0.tgz"), undefined);
});

test("updateNotice: yeni commit varsa haber verir, günde bir kez kontrol eder", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kgflow-up-"));
  fs.mkdirSync(path.join(home, ".kgflow"));
  fs.writeFileSync(path.join(home, ".kgflow/install.json"), JSON.stringify({ mode: "remote", source: "https://x/k.tgz", commit: "aaaaaaa1" }));
  let calls = 0;
  const check = () => (calls++, "bbbbbbb2");
  const t0 = Date.parse("2026-10-05T10:00:00Z");
  assert.match(updateNotice(home, t0, check)!, /yeni bir sürümü var \(bbbbbbb\)/);
  assert.match(updateNotice(home, t0 + 60_000, check)!, /kgflow update/);
  assert.equal(calls, 1, "aynı gün tekrar sorulmaz");
  updateNotice(home, t0 + 25 * 3600_000, check);
  assert.equal(calls, 2);
  assert.equal(updateNotice(home, t0 + 50 * 3600_000, () => "aaaaaaa1"), undefined, "güncelse sessiz");
  assert.equal(updateNotice(home, t0 + 80 * 3600_000, () => undefined), undefined, "ağ yoksa sessiz");
});

test("updateNotice: kurulum kaydı yoksa ya da kapalıysa sessiz", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kgflow-up-"));
  assert.equal(updateNotice(home, Date.now(), () => "x"), undefined);
});
