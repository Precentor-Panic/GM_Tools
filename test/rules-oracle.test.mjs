import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";

import {
  RULE_FAMILIES,
  RULE_TEXT_MAX_CHARS,
  stripFiveEtoolsTags,
  flattenRuleEntries,
  buildRuleRow,
  loadRulesIndex,
  clearRulesIndexCache,
  searchRulesIndex
} from "../rules-oracle/rules-index.mjs";

/**
 * G9a — rules-oracle/rules-index.mjs, the structured (Plutonium-backed)
 * backend. All fixture JSON below is INVENTED for this test, shaped to
 * match the real plutonium data files' documented quirks (nested
 * {type,name?,entries}, {type:"table",...} nodes, {@tag body|SRC} inline
 * tags) — never copied from a real book or the real bundled data.
 */

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-rules-index-test-"));
const dataDir = join(scratchDir, "foundrydata");
const plutoniumDataDir = join(dataDir, "modules", "plutonium", "data");
mkdirSync(plutoniumDataDir, { recursive: true });

function writeFamily(file, payload) {
  writeFileSync(join(plutoniumDataDir, file), JSON.stringify(payload));
}

const longEntry = "x".repeat(RULE_TEXT_MAX_CHARS + 50);

writeFamily("variantrules.json", {
  variantrule: [
    {
      name: "Ability Check",
      source: "XPHB",
      page: 360,
      ruleType: "C",
      entries: [
        "An ability check uses {@variantrule D20 Test|XPHB} rules and may roll {@dice 1d20}."
      ]
    },
    {
      name: "Breaking Objects",
      source: "XPHB",
      page: 362,
      entries: [
        "Objects can be harmed by attacks.",
        {
          type: "entries",
          name: "Hit Points",
          entries: ["An object is destroyed at 0 Hit Points."]
        },
        {
          type: "table",
          caption: "Object Armor Class",
          colLabels: ["AC", "Substance"],
          rows: [["11", "Cloth, paper, rope"], ["19", "Iron, steel"]]
        }
      ]
    },
    {
      name: "Very Long Rule",
      source: "XPHB",
      page: 400,
      entries: [longEntry]
    }
  ]
});
writeFamily("actions.json", { action: [{ name: "Grapple", source: "PHB", page: 195, entries: ["A grapple attempt uses the {@action Attack|XPHB} action."] }] });
writeFamily("conditionsdiseases.json", {
  condition: [{ name: "Blinded", source: "PHB", page: 290, entries: [{ type: "list", items: ["A blinded creature can't see."] }] }],
  disease: [{ name: "Sewer Plague", source: "DMG", page: 257, entries: ["A vile affliction."] }],
  status: [{ name: "Concentrating", source: "PHB", page: 203, entries: ["Maintains a spell."] }]
});
writeFamily("skills.json", { skill: [{ name: "Acrobatics", source: "PHB", page: 176, entries: ["Covers balance and tumbling."] }] });
writeFamily("senses.json", { sense: [{ name: "Blindsight", source: "PHB", page: 183, entries: ["Perceive without sight."] }] });
writeFamily("tables.json", {
  table: [
    {
      name: "2,500 gp Art Objects",
      source: "PSX",
      page: 26,
      caption: "2,500 gp Art Objects",
      colLabels: ["d10", "Object"],
      rows: [["1", "{@item Platinum headdress|psx}"], ["2", "{@item Gold music box|psx}"]]
    }
  ]
});

await test("RULE_FAMILIES lists the six families with file/props", () => {
  assert.deepEqual(Object.keys(RULE_FAMILIES).sort(), ["actions", "conditionsdiseases", "senses", "skills", "tables", "variantrules"]);
  assert.equal(RULE_FAMILIES.conditionsdiseases.props.length, 3);
});

await test("stripFiveEtoolsTags: takes the first pipe-segment of the tag body", () => {
  assert.equal(stripFiveEtoolsTags("{@variantrule D20 Test|XPHB}"), "D20 Test");
  assert.equal(stripFiveEtoolsTags("{@condition blinded}"), "blinded");
  assert.equal(stripFiveEtoolsTags("{@dice 1d6}"), "1d6");
  assert.equal(stripFiveEtoolsTags("plain text, no tags"), "plain text, no tags");
  assert.equal(stripFiveEtoolsTags("Uses {@action Attack|XPHB} or {@action Utilize|XPHB}."), "Uses Attack or Utilize.");
});

await test("flattenRuleEntries: strings, nested {type,name,entries}, and {type:table} all flatten to visible text", () => {
  const flat = flattenRuleEntries([
    "Top-level line.",
    { type: "entries", name: "Sub Heading", entries: ["Nested line."] },
    { type: "table", caption: "My Table", colLabels: ["A", "B"], rows: [["1", "2"]] }
  ]);
  assert.match(flat, /Top-level line\./);
  assert.match(flat, /Sub Heading\./);
  assert.match(flat, /Nested line\./);
  assert.match(flat, /My Table/);
  assert.match(flat, /A \| B/);
  assert.match(flat, /1 \| 2/);
});

await test("buildRuleRow: skips a record with no name", () => {
  assert.equal(buildRuleRow("variantrules", "variantrule", { source: "PHB" }), null);
});

await test("loadRulesIndex: installed:false, empty rows when the plutonium dir is missing (never throws)", () => {
  const result = loadRulesIndex(join(scratchDir, "no-such-dataDir"));
  assert.equal(result.installed, false);
  assert.deepEqual(result.rows, []);
});

await test("loadRulesIndex: reads all six families, rows carry family/name/source/page/text", () => {
  const result = loadRulesIndex(dataDir);
  assert.equal(result.installed, true);
  const names = result.rows.map((r) => r.name);
  assert.ok(names.includes("Ability Check"));
  assert.ok(names.includes("Grapple"));
  assert.ok(names.includes("Blinded"));
  assert.ok(names.includes("Acrobatics"));
  assert.ok(names.includes("Blindsight"));
  assert.ok(names.includes("2,500 gp Art Objects"));

  const abilityCheck = result.rows.find((r) => r.name === "Ability Check");
  assert.equal(abilityCheck.family, "variantrules");
  assert.equal(abilityCheck.source, "XPHB");
  assert.equal(abilityCheck.page, 360);
  assert.equal(abilityCheck.ruleType, "C");
  assert.match(abilityCheck.text, /D20 Test/);
  assert.doesNotMatch(abilityCheck.text, /\{@/);
});

await test("loadRulesIndex: conditionsdiseases rows carry ruleType from their own prop array when the record has none", () => {
  const result = loadRulesIndex(dataDir);
  const blinded = result.rows.find((r) => r.name === "Blinded");
  assert.equal(blinded.ruleType, "condition");
  const disease = result.rows.find((r) => r.name === "Sewer Plague");
  assert.equal(disease.ruleType, "disease");
});

await test("loadRulesIndex: text is capped at RULE_TEXT_MAX_CHARS with a trailing ellipsis", () => {
  const result = loadRulesIndex(dataDir);
  const row = result.rows.find((r) => r.name === "Very Long Rule");
  assert.ok(row.text.length <= RULE_TEXT_MAX_CHARS + 1);
  assert.ok(row.text.endsWith("…"));
});

await test("loadRulesIndex: tables family flattens caption/colLabels/rows, tags stripped", () => {
  const result = loadRulesIndex(dataDir);
  const table = result.rows.find((r) => r.name === "2,500 gp Art Objects");
  assert.match(table.text, /Platinum headdress/);
  assert.doesNotMatch(table.text, /\{@/);
});

await test("loadRulesIndex: per-file mtime cache invalidates when a family file is rewritten", () => {
  clearRulesIndexCache();
  const before = loadRulesIndex(dataDir);
  assert.ok(!before.rows.some((r) => r.name === "Fresh New Rule"));

  writeFamily("skills.json", { skill: [{ name: "Fresh New Rule", source: "PHB", page: 1, entries: ["New."] }] });
  // Bump mtime forward to guarantee a change is observable even on
  // filesystems with coarse mtime resolution.
  const future = new Date(Date.now() + 5000);
  utimesSync(join(plutoniumDataDir, "skills.json"), future, future);

  const after1 = loadRulesIndex(dataDir);
  assert.ok(after1.rows.some((r) => r.name === "Fresh New Rule"));
});

await test("searchRulesIndex: empty query returns []", () => {
  const result = loadRulesIndex(dataDir);
  assert.deepEqual(searchRulesIndex(result.rows, { query: "" }), []);
});

await test("searchRulesIndex: case-insensitive ALL-terms match over name+text; name hits rank before text-only", () => {
  const result = loadRulesIndex(dataDir);
  const hits = searchRulesIndex(result.rows, { query: "ability check" });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].name, "Ability Check");

  // "attack" only appears in Grapple's TEXT (via the {@action Attack} tag),
  // not its name -- proves the text-hit path independent of the name path.
  const textHits = searchRulesIndex(result.rows, { query: "attack" });
  assert.ok(textHits.some((r) => r.name === "Grapple"));
});

await test("searchRulesIndex: family filters", () => {
  const result = loadRulesIndex(dataDir);
  const hits = searchRulesIndex(result.rows, { query: "blinded", family: "conditionsdiseases" });
  assert.ok(hits.length >= 1);
  assert.ok(hits.every((r) => r.family === "conditionsdiseases"));
  const noHits = searchRulesIndex(result.rows, { query: "blinded", family: "skills" });
  assert.deepEqual(noHits, []);
});

await test("searchRulesIndex: limit is capped at 50", () => {
  const rows = [];
  for (let i = 0; i < 80; i++) rows.push({ family: "variantrules", name: `Rule Match ${i}`, source: "X", page: 1, text: "match" });
  const hits = searchRulesIndex(rows, { query: "match", limit: 500 });
  assert.equal(hits.length, 50);
});

after(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});
