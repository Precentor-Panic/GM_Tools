// This repo is public. Fail if anything staged or tracked would publish someone else's IP: map or token art, asset
// packs, Foundry pack databases, the Czepeku catalogue or data derived from it, or gated download links. Run before
// committing map work (plans/map-quality-plan.md, "Rules"). `--all` checks every tracked file, not just the staged ones.
//   bin/ip-check [--all]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 << 20 });
const root = git("rev-parse", "--show-toplevel").trim();
process.chdir(root);
const ALL = process.argv.includes("--all");
const files = (ALL ? git("ls-files", "-z") : git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"))
  .split("\0").filter(Boolean).filter((f) => !f.includes("node_modules/"));

// Kinds of file that only ever come from someone else's product here.
const BINARY = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?|webm|mp4|m4a|ogg|mp3|pdf|zip|pck|dungeondraft_pack|dungeondraft_map|dd2vtt|uvtt|db|ldb|sst)$/i;
// Hosts that serve gated or licensed downloads. Only the host is printed, never the link.
const GATED = /https?:\/\/[a-z0-9.-]*(dropbox|dropboxusercontent|patreon|patreonusercontent|forgottenadventures|czepeku|cyclopean|dndungeon|gumroad|itch\.io)[a-z0-9.-]*/i;
// Data that is derived from a licensed product even when it is text.
const DERIVED = /(czepeku-catalogue|map-shelf|scenes\.json$|\/extra\/czepeku-|\/packs\/(index|catalogue|thumbs)\/)/i;
const BLOB = /[A-Za-z0-9+/=]{4000,}/;
// Files that hold these patterns on purpose, to describe or enforce this rule.
const SELF = new Set(["bin/ip-check.mjs"]);

const problems = [];
for (const f of files) {
  if (SELF.has(f)) continue;
  if (BINARY.test(f)) { problems.push(`${f}: binary art, pack or database file`); continue; }
  if (DERIVED.test(f)) { problems.push(`${f}: data derived from a licensed product`); continue; }
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  const host = text.match(GATED);
  if (host) problems.push(`${f}: link to a gated download host (${new URL(host[0]).host})`);
  if (BLOB.test(text)) problems.push(`${f}: a long encoded blob (an embedded image?)`);
}
// Paths that must stay ignored whether or not they exist yet.
for (const p of ["stagecraft/czepeku-catalogue.json", "stagecraft/map-shelf/profiles.jsonl", ".env"]) {
  try { git("check-ignore", "-q", p); } catch { problems.push(`${p}: not ignored`); }
}
if (problems.length) {
  console.error(`ip-check: ${problems.length} problem(s)\n  ` + problems.join("\n  "));
  process.exit(1);
}
console.log(`ip-check: ok (${files.length} ${ALL ? "tracked" : "staged"} file(s))`);
