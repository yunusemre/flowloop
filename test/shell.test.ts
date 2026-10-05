import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesPrefix, parseSimpleCommand } from "../src/shell.js";

const ok = (c: string) => {
  const r = parseSimpleCommand(c);
  assert.ok(r.ok, `${c} kabul edilmeliydi: ${!r.ok ? r.reason : ""}`);
  return r.tokens;
};
const bad = (c: string) => assert.equal(parseSimpleCommand(c).ok, false, `${c} reddedilmeliydi`);

test("basit komutlar ve tırnaklar", () => {
  assert.deepEqual(ok("npm test"), ["npm", "test"]);
  assert.deepEqual(ok(`git commit -m "feat(fiyat): ekspres; > 50 TL" -m 'AK-1 $HOME'`), ["git", "commit", "-m", "feat(fiyat): ekspres; > 50 TL", "-m", "AK-1 $HOME"]);
  assert.deepEqual(ok(`dotnet test --filter "Category=Unit"`), ["dotnet", "test", "--filter", "Category=Unit"]);
  assert.deepEqual(ok("git commit -m \"satır1\nsatır2\""), ["git", "commit", "-m", "satır1\nsatır2"]);
});

test("zincirleme, yönlendirme, yerine koyma reddedilir", () => {
  for (const c of ["npm test && rm -rf src", "npm test; ls", "npm test | tee x", "npm test > out.txt", "echo $(id)", "echo `id`",
    "npm test &", 'git commit -m "$(cat /etc/passwd)"', "FOO=1 npm test", "ls *.js", "cat ~/.ssh/id_rsa", "npm test\nrm x", "git commit -m 'açık"]) bad(c);
});

test("önek eşleşmesi kelime sınırında", () => {
  assert.equal(matchesPrefix(ok("npm test -- --watch=false"), ["npm test"]), "npm test");
  assert.equal(matchesPrefix(ok("npm testx"), ["npm test"]), undefined);
  assert.equal(matchesPrefix(ok("npm run build"), ["npm test"]), undefined);
  assert.equal(matchesPrefix(ok("git push origin main"), ["git commit", "git add"]), undefined);
  assert.equal(matchesPrefix(ok("git -C .. commit -m x"), ["git commit"]), undefined);
});
