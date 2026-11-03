// This repo is public. Fail if anything staged, tracked or about to be pushed would publish someone else's IP or a
// secret: map or token art, asset packs, Foundry pack databases, the Czepeku catalogue or data derived from a vendor's
// maps, gated download links, embedded images, or keys. Run before committing map work, and with --push before every
// push (plans/map-quality-plan.md, "Rules").
//   bin/ip-check              the staged files
//   bin/ip-check --all        every tracked file
//   bin/ip-check --push [remote]   every version of every file a push would send (all commits not on the remote,
//                                  default origin), not just the tip: a file added and later deleted still goes out
//   bin/ip-check --range <a..b>    the same for a revision range
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Kinds of file that only ever come from someone else's product here.
const BINARY = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?|webm|mp4|m4a|ogg|mp3|pdf|zip|pck|dungeondraft_pack|dungeondraft_map|dd2vtt|uvtt|db|ldb|sst)$/i;
// Hosts that serve gated or licensed downloads. Only the host is printed, never the link.
const GATED = /https?:\/\/[a-z0-9.-]*(dropbox|dropboxusercontent|patreon|patreonusercontent|forgottenadventures|czepeku|cyclopean|dndungeon|gumroad|itch\.io)[a-z0-9.-]*/i;
// Data derived from a licensed product even when it is text, recognised by its path. A file named for a map vendor is
// notes on their maps (cuts, walls, profiles, file lists); those live under stagecraft/ (ignored).
const DERIVED = /(czepeku|forgotten.?adventures|dndungeon|cyclopean|map-shelf\/|scenes\.json$|\/packs\/(index|catalogue|thumbs)\/)/i;
const BLOB = /[A-Za-z0-9+/=]{4000,}/;
// Keys and private keys. The match is never printed.
const SECRET = /(sk-ant-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abp]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
// Files that hold these patterns on purpose, to describe or enforce this rule.
const SELF = new Set(["bin/ip-check.mjs"]);
// Paths that must stay ignored whether or not they exist yet.
export const MUST_IGNORE = ["stagecraft/czepeku-catalogue.json", "stagecraft/map-shelf/profiles.jsonl", "stagecraft/map-shelf/look.jsonl",
  "stagecraft/map-shelf/thumbs/x.jpg", "stagecraft/map-shelf/shelf.html", "stagecraft/map-segment-specs/x.json", ".env"];

/** The problems with one file, from its path and (when it is text) its contents. */
export function fileProblems(path, text) {
  if (SELF.has(path) || path.includes("node_modules/")) return [];
  if (BINARY.test(path)) return [`${path}: binary art, pack or database file`];
  if (DERIVED.test(path)) return [`${path}: data derived from a licensed product`];
  if (text == null) return [];
  const out = [];
  const host = text.match(GATED);
  if (host) out.push(`${path}: link to a gated download host (${new URL(host[0]).host})`);
  if (BLOB.test(text)) out.push(`${path}: a long encoded blob (an embedded image?)`);
  if (SECRET.test(text)) out.push(`${path}: something shaped like a key or private key`);
  return out;
}

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 256 << 20 });

/** Every blob reachable from the revisions (git rev-list syntax), each with the path it was seen at. */
function blobsIn(revs) {
  const seen = new Map();
  for (const line of git("rev-list", "--objects", ...revs).split("\n")) {
    const sp = line.indexOf(" ");
    if (sp > 0 && !seen.has(line.slice(0, sp))) seen.set(line.slice(0, sp), line.slice(sp + 1));
  }
  const types = execFileSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    { input: [...seen.keys()].join("\n"), encoding: "utf8", maxBuffer: 256 << 20 });
  const blobs = new Set(types.split("\n").filter((l) => l.endsWith(" blob")).map((l) => l.split(" ")[0]));
  return [...seen].filter(([sha]) => blobs.has(sha));
}

function main(argv) {
  process.chdir(git("rev-parse", "--show-toplevel").trim());
  const after = (k) => { const v = argv[argv.indexOf(k) + 1]; return v && !v.startsWith("-") ? v : null; };
  const problems = [];
  let label;
  if (argv.includes("--push") || argv.includes("--range")) {
    const revs = argv.includes("--range") ? [after("--range")] : ["HEAD", "--not", `--remotes=${after("--push") ?? "origin"}`];
    const blobs = blobsIn(revs);
    for (const [sha, path] of blobs) {
      if (SELF.has(path) || path.includes("node_modules/")) continue;
      const buf = execFileSync("git", ["cat-file", "blob", sha], { maxBuffer: 256 << 20 });
      problems.push(...fileProblems(path, buf.includes(0) ? null : buf.toString("utf8")).map((p) => `${p} [${sha.slice(0, 8)}]`));
    }
    label = `${blobs.length} file version(s) in ${revs.join(" ")}`;
  } else {
    const ALL = argv.includes("--all");
    const files = (ALL ? git("ls-files", "-z") : git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z")).split("\0").filter(Boolean);
    for (const f of files) {
      let text = null;
      try { text = readFileSync(f, "utf8"); } catch {}
      problems.push(...fileProblems(f, text));
    }
    label = `${files.length} ${ALL ? "tracked" : "staged"} file(s)`;
  }
  for (const p of MUST_IGNORE) {
    try { git("check-ignore", "-q", p); } catch { problems.push(`${p}: not ignored`); }
  }
  if (problems.length) {
    console.error(`ip-check: ${problems.length} problem(s)\n  ` + problems.join("\n  "));
    process.exit(1);
  }
  console.log(`ip-check: ok (${label})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
