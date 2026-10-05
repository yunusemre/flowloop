import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitOk } from "../src/git.js";
import { remoteLinks } from "../src/remote.js";

function repoWith(url: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "kgflow-rem-"));
  gitOk(["init", "-q"], d);
  gitOk(["remote", "add", "origin", url], d);
  return d;
}

test("Bitbucket / GitHub bağlantıları", () => {
  const bb = remoteLinks(repoWith("git@bitbucket.org:sendeotech/kgs-app.git"))!;
  assert.equal(bb.branch("IDT-1-x"), "https://bitbucket.org/sendeotech/kgs-app/branch/IDT-1-x");
  assert.equal(bb.pr("IDT-1-x", "main"), "https://bitbucket.org/sendeotech/kgs-app/pull-requests/new?source=IDT-1-x&dest=main");
  const gh = remoteLinks(repoWith("https://github.com/acme/app.git"))!;
  assert.equal(gh.pr("f", "main"), "https://github.com/acme/app/compare/main...f?expand=1");
});
