import { test } from "node:test";
import assert from "node:assert/strict";
import { hasSecret, redact } from "../src/redact.js";

test("redact: connection string, JSON, başlık ve bilinen token biçimleri", () => {
  assert.equal(redact("Server=db;Database=kg;User Id=app;Password=S3cr3t!;"), "Server=db;Database=kg;User Id=app;Password=[gizli];");
  assert.equal(redact('{"ConnectionString": "x", "ApiKey": "abc123456"}'), '{"ConnectionString": "x", "ApiKey": "[gizli]"}');
  assert.equal(redact("jira_token: ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz"), "jira_token: [gizli]");
  assert.equal(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123"), "Authorization: Bearer [gizli]");
  assert.equal(redact("mongodb://app:pa55word@host:27017/db"), "mongodb://app:[gizli]@host:27017/db");
  assert.equal(redact("key AKIAABCDEFGHIJKLMNOP end"), "key [gizli] end");
  assert.match(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIx\n-----END RSA PRIVATE KEY-----"), /PRIVATE KEY \[gizli\]/);
  assert.equal(hasSecret("Password=x;"), true);
});

test("redact: sıradan kod ve test çıktısına dokunmaz", () => {
  for (const s of [
    "Passed!  - Failed: 0, Passed: 21",
    "error CS0103: The name 'tokenizer' does not exist",
    "const token = getToken();",
    "if (password.length < 8) throw new Error('kısa');",
    "GSM: (532)-123-45-67 → 5321234567",
    "author: ali@example.com",
  ]) assert.equal(redact(s), s, s);
});

test("redact: kişisel veri isteğe bağlı", () => {
  assert.equal(redact("ali@example.com 0532 123 45 67", { personal: true }), "[e-posta] [telefon]");
  assert.equal(redact("+90 532 123 45 67 / 5321234567", { personal: true }), "[telefon] / [telefon]");
  assert.equal(redact("Co-Authored-By: Claude <noreply@anthropic.com>", { personal: true }), "Co-Authored-By: Claude <noreply@anthropic.com>");
  assert.equal(redact("sipariş 12345678901 tutar 532", { personal: true }), "sipariş 12345678901 tutar 532");
});
