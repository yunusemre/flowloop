import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitOk } from "../src/git.js";
import { parseRemote, remoteLinks } from "../src/remote.js";

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

test("remote adresi: insteadOf yönlendirmesi, SSH portu ve SSH ana makinesi web bağlantısını bozmaz", () => {
  const d = repoWith("git@bitbucket.org:sirket/my-app.git");
  gitOk(["config", "url.ssh://git@ssh.bitbucket.org:443/.insteadOf", "git@bitbucket.org:"], d);
  assert.match(gitOk(["remote", "get-url", "origin"], d), /ssh\.bitbucket\.org/, "git yönlendirmeyi uygular");
  assert.equal(remoteLinks(d)!.web, "https://bitbucket.org/sirket/my-app");
  assert.deepEqual(parseRemote("ssh://git@ssh.bitbucket.org:443/sirket/my-app.git"), { host: "bitbucket.org", repo: "sirket/my-app" });
  assert.deepEqual(parseRemote("ssh://git@ssh.github.com:443/acme/app.git"), { host: "github.com", repo: "acme/app" });
  assert.deepEqual(parseRemote("https://user@bitbucket.org/sirket/my-app.git/"), { host: "bitbucket.org", repo: "sirket/my-app" });
  assert.deepEqual(parseRemote("git@gitlab.com:grup/alt/proje.git"), { host: "gitlab.com", repo: "grup/alt/proje" });
  assert.equal(parseRemote("/yerel/klasor"), undefined);
});
