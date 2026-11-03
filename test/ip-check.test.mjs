// bin/ip-check's rules. Every risky string is assembled at run time so this file never trips the check itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileProblems, MUST_IGNORE } from "../bin/ip-check.mjs";

test("art, packs and databases are refused by extension", () => {
  for (const p of ["maps/x.webp", "a/b.PNG", "p.dungeondraft_pack", "m.dd2vtt", "packs/scenes/000005.ldb"])
    assert.equal(fileProblems(p, null).length, 1, p);
  assert.deepEqual(fileProblems("map-plan/svg.mjs", "export const x = 1;"), []);
});

test("a file named for a map vendor is derived data, whatever it holds", () => {
  const vendor = "cze" + "peku";
  for (const p of [`map-segments/specs/${vendor}-216-sewer-tunnels.json`, `notes/Forgotten-Adventures-list.md`, "x/map-shelf/p.jsonl", "a/scenes.json"])
    assert.match(fileProblems(p, "{}")[0] ?? "", /derived/, p);
});

test("gated links name the host only", () => {
  const link = "https://www." + "drop" + "box.com/s/abc/pack.zip?dl=1";
  const [p] = fileProblems("plans/x.md", `get it at ${link}`);
  assert.match(p, /gated download host \(www\.dropbox\.com\)/);
  assert.ok(!p.includes("abc"));
});

test("keys and long blobs are refused; the key is never echoed", () => {
  const key = "sk-" + "ant-" + "a".repeat(24);
  const [p] = fileProblems("x.mjs", `const k = "${key}";`);
  assert.match(p, /key/);
  assert.ok(!p.includes(key));
  assert.match(fileProblems("x.html", "data:image/png;base64," + "QUFB".repeat(1200))[0], /blob/);
  assert.match(fileProblems("x.pem", "-----BEGIN " + "RSA PRIVATE KEY-----\n")[0], /key/);
});

test("ordinary code that mentions vendors or tokens passes", () => {
  assert.deepEqual(fileProblems("test/pull.test.mjs", 'packId: "cze' + 'peku-taverns.scenes", apiKey: "k-test"'), []);
});

test("the paths that hold licensed data are ignored in this checkout", () => {
  for (const p of MUST_IGNORE) execFileSync("git", ["check-ignore", "-q", p]);
});
