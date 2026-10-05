import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitOk } from "../src/git.js";
import { remoteLinks } from "../src/remote.js";

function repoWith(url: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "flowloop-rem-"));
  gitOk(["init", "-q"], d);
  gitOk(["remote", "add", "origin", url], d);
  return d;
}

test("Bitbucket / GitHub bağlantıları", () => {
  const bb = remoteLinks(repoWith("git@bitbucket.org:sirket/my-app.git"))!;
  assert.equal(bb.branch("PROJ-1-x"), "https://bitbucket.org/sirket/my-app/branch/PROJ-1-x");
  assert.equal(bb.pr("PROJ-1-x", "main"), "https://bitbucket.org/sirket/my-app/pull-requests/new?source=PROJ-1-x&dest=main");
  const gh = remoteLinks(repoWith("https://github.com/acme/app.git"))!;
  assert.equal(gh.pr("f", "main"), "https://github.com/acme/app/compare/main...f?expand=1");
});
