/**
 * Plutonium monster record -> curated-shelf rawFields (the bestiary-ingest
 * vocabulary), PURE, no I/O.
 *
 * Why this exists (Aureus post-push punch list, E2): add-from-plutonium used
 * to build a shelf row from the compact INDEX row only (name/type/ac/hp/cr),
 * so every Plutonium-sourced creature -- and every reskin spread from one --
 * landed with no attacks, no multiattack, no traits. The Library rail and
 * the Run block then showed AC/HP/CR and nothing else ("most of them appear
 * to have no special abilities"), and the encounter heuristic scored every
 * one of them 0. This module reads the FULL raw record and fills the
 * ingest vocabulary (`attacks`, `multiattack`, `rechargeAbilities`,
 * `legendaryActions`) plus a new `traits[]` list for everything else a GM
 * needs to see at the table.
 *
 * IP posture (same rule as rules-oracle's snippet caps): a trait carries
 * its NAME plus its first sentence, capped at TRAIT_SUMMARY_MAX_CHARS, and
 * at most MAX_TRAITS traits are kept. Whole stat-block text never lands on
 * the shelf; the full record stays where it lives (Plutonium's bundled
 * data) and is re-read on demand. Tests use synthetic records only.
 */
import { normalizeMonster } from "./plutonium-source.mjs";
import { stripFiveEtoolsTags } from "../rules-oracle/rules-index.mjs";

export const TRAIT_SUMMARY_MAX_CHARS = 160;
export const MAX_TRAITS = 16;

/** The order trait kinds are emitted in (and the only values `kind` takes). */
export const TRAIT_KINDS = ["trait", "action", "bonus", "reaction", "legendary", "spellcasting"];

/**
 * Pull the source code out of an add-from-plutonium sourceText stamp
 * ("MM p347 via Plutonium" -> "MM", "MM via Plutonium" -> "MM"). Returns
 * null when the text isn't a Plutonium stamp. Lives here (not in
 * foundry-item-push-ops.mjs, which re-exports it) so bestiary-store.mjs can
 * use it without a circular import.
 */
export function parsePlutoniumProvenance(sourceText) {
  if (typeof sourceText !== "string") return null;
  const m = /^(\S+)(?:\s+p\d+)?\s+via\s+Plutonium\s*$/i.exec(sourceText.trim());
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Tag rendering
// ---------------------------------------------------------------------------

const ATK_WORDS = { m: "Melee", r: "Ranged", mw: "Melee Weapon", rw: "Ranged Weapon", ms: "Melee Spell", rs: "Ranged Spell" };
const ABILITY_NAMES = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" };
const ORDINALS = { 1: "First", 2: "Second", 3: "Third" };

function renderAtk(spec, suffix) {
  const parts = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const words = parts.map((p) => ATK_WORDS[p] ?? p);
  if (!words.length) return `${suffix}:`;
  // "Melee or Ranged Weapon Attack:" reads better than repeating "Weapon".
  const last = words[words.length - 1];
  const heads = words.slice(0, -1).map((w) => w.split(" ")[0]);
  return `${[...heads, last].join(" or ")} ${suffix}:`;
}

/**
 * Render the 5etools tags that carry bestiary semantics into plain text
 * ({@atk mw} -> "Melee Weapon Attack:", {@hit 5} -> "+5", {@h} -> "Hit: ",
 * {@dc 15} -> "DC 15", {@recharge 5} -> "(Recharge 5-6)", the 2024
 * {@actSave …} family), then strip every remaining {@tag …} to its display
 * text. No `{@` ever survives (pinned by test).
 */
export function renderMonsterTagText(s) {
  if (typeof s !== "string" || !s) return "";
  let out = s;
  out = out.replace(/\{@atk\s+([^}]*)\}/g, (_m, spec) => renderAtk(spec, "Attack"));
  out = out.replace(/\{@atkr\s+([^}]*)\}/g, (_m, spec) => renderAtk(spec, "Attack Roll"));
  out = out.replace(/\{@hit\s+([+-]?\d+)[^}]*\}/g, (_m, n) => (n.startsWith("-") ? n : `+${n.replace(/^\+/, "")}`));
  out = out.replace(/\{@hitYourSpellAttack[^}]*\}/g, "your spell attack modifier");
  out = out.replace(/\{@dcYourSpellSave[^}]*\}/g, "your spell save DC");
  out = out.replace(/\{@h\}/g, "Hit: ");
  out = out.replace(/\{@hom\}/g, "Hit or Miss: ");
  out = out.replace(/\{@dc\s+(\d+)[^}]*\}/g, "DC $1");
  out = out.replace(/\{@recharge\s*([^}|]*)(?:\|[^}]*)?\}/g, (_m, n) => {
    const v = Number(String(n).trim());
    return Number.isFinite(v) && v >= 1 && v < 6 ? `(Recharge ${v}-6)` : "(Recharge 6)";
  });
  out = out.replace(/\{@actSave\s+(\w+)[^}]*\}/g, (_m, ab) => `${ABILITY_NAMES[ab.toLowerCase()] ?? ab} Saving Throw:`);
  out = out.replace(/\{@actSaveFailBy\s+(\d+)[^}]*\}/g, "Failure by $1 or More:");
  out = out.replace(/\{@actSaveFail(?:\s+(\d+))?[^}]*\}/g, (_m, n) => (n && ORDINALS[n] ? `${ORDINALS[n]} Failure:` : "Failure:"));
  out = out.replace(/\{@actSaveSuccessOrFail[^}]*\}/g, "Failure or Success:");
  out = out.replace(/\{@actSaveSuccess[^}]*\}/g, "Success:");
  out = out.replace(/\{@actTrigger[^}]*\}/g, "Trigger:");
  out = out.replace(/\{@actResponse[^}]*\}/g, "Response:");
  out = out.replace(/\{@chance\s+(\d+)[^}]*\}/g, "$1 percent");
  out = stripFiveEtoolsTags(out);
  return out.replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
}

// ---------------------------------------------------------------------------
// Entry flattening + summaries
// ---------------------------------------------------------------------------

/**
 * Flatten a 5etools `entries` array (strings, {entries}, {type:"list",
 * items}, {type:"item", name, entries|entry}) to an array of RAW strings
 * (tags intact -- render afterwards). Tables and unknown shapes are skipped.
 */
export function flattenMonsterEntries(entries, depth = 0) {
  if (depth > 6) return [];
  const list = Array.isArray(entries) ? entries : (entries == null ? [] : [entries]);
  const out = [];
  for (const e of list) {
    if (typeof e === "string") { out.push(e); continue; }
    if (!e || typeof e !== "object") continue;
    if (e.type === "table") continue;
    const name = typeof e.name === "string" && e.name ? `${e.name}. ` : "";
    const inner = e.type === "list" ? e.items : (e.entries ?? e.entry);
    const flat = flattenMonsterEntries(inner, depth + 1);
    if (name && flat.length) { flat[0] = name + flat[0]; }
    else if (name) flat.push(name.trim());
    out.push(...flat);
  }
  return out;
}

/** First sentence of a rendered text (splits only before a capitalised next sentence, so "5 ft., one target" survives). */
export function firstSentence(text) {
  const t = String(text ?? "").trim();
  if (!t) return "";
  return t.split(/(?<=[.!?])\s+(?=[A-Z"(])/)[0].trim();
}

/** Cap a summary at `max` chars on a word boundary, appending an ellipsis. */
export function capSummary(text, max = TRAIT_SUMMARY_MAX_CHARS) {
  const t = String(text ?? "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, "")}…`;
}

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twice: 2, thrice: 3 };

/**
 * "The knight makes two melee attacks." -> 2. Reads the first number (word
 * or digit) that follows "makes"/"uses"/"attacks"; null when nothing parses.
 */
export function parseMultiattackCount(text) {
  const t = renderMonsterTagText(text).toLowerCase();
  const m = /\b(?:makes|make|uses|use|attacks?)\b[^.;]*?\b(one|two|three|four|five|six|seven|eight|nine|ten|twice|thrice|\d+)\b/.exec(t);
  if (!m) return null;
  const n = NUMBER_WORDS[m[1]] ?? Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Attack / recharge parsing
// ---------------------------------------------------------------------------

function isAttackText(raw) {
  return /\{@atkr?\b/.test(raw) && (/\{@damage\b/.test(raw) || /\{@h\}\s*\d+\s+\w+\s+damage/.test(raw));
}

function parseAttack(name, raw) {
  const hit = /\{@hit\s+([+-]?\d+)/.exec(raw);
  const dmg = /\{@damage\s+([^}|]+)(?:\|[^}]*)?\}\)?\s*([a-z]+(?:\s+or\s+[a-z]+)?)?\s*damage/i.exec(raw);
  let damageDice = null;
  let damageType;
  if (dmg) {
    damageDice = dmg[1].replace(/\s+/g, "");
    if (dmg[2]) damageType = dmg[2].toLowerCase();
  } else {
    const flat = /\{@h\}\s*(\d+)\s+([a-z]+)\s+damage/i.exec(raw);
    if (flat) { damageDice = flat[1]; damageType = flat[2].toLowerCase(); }
  }
  if (!damageDice) return null;
  return {
    name,
    ...(hit ? { toHitBonus: Number(hit[1]) } : {}),
    damageDice,
    ...(damageType ? { damageType } : {}),
    summary: capSummary(renderMonsterTagText(raw))
  };
}

function cleanName(rawName) {
  // Drop only the rendered {@recharge} form ("(Recharge 5-6)") -- a
  // "(Recharges after a Short or Long Rest)" suffix is part of the name.
  return renderMonsterTagText(String(rawName ?? "")).replace(/\(Recharge \d(?:-6)?\)/, "").replace(/\s+/g, " ").trim();
}

function rechargeOnOf(rawName) {
  const m = /\{@recharge\s*([^}|]*)(?:\|[^}]*)?\}/.exec(String(rawName ?? ""));
  if (!m) return null;
  const v = Number(String(m[1]).trim());
  return Number.isFinite(v) && v >= 1 && v < 6 ? `${v}-6` : "6";
}

// ---------------------------------------------------------------------------
// The mapper
// ---------------------------------------------------------------------------

function traitFrom(block, kind, useFirstSentence = true) {
  const text = renderMonsterTagText(flattenMonsterEntries(block.entries ?? block.headerEntries).join(" "));
  const name = cleanName(block.name) || (kind === "spellcasting" ? "Spellcasting" : "");
  if (!name && !text) return null;
  return { name: name || "—", summary: capSummary(useFirstSentence ? firstSentence(text) : text), kind };
}

/**
 * Full raw 5etools monster record -> shelf rawFields. Base fields come from
 * normalizeMonster (the compact index row, so name/type/ac/hp/cr agree with
 * what the "Available via Plutonium" shelf shows); actions with an attack
 * tag become `attacks[]`, "{@recharge}" actions `rechargeAbilities[]`, the
 * Multiattack action `multiattack{count, attackNames?}`, the legendary
 * block `legendaryActions{count}`, and everything else a capped `traits[]`.
 * Empty keys are omitted so the zod shape stays minimal.
 *
 * Throws on a `_copy` reprint shell (no stats of its own -- the caller
 * decides whether to fall back to the compact row).
 */
export function rawFieldsFromPlutoniumRecord(raw) {
  const row = normalizeMonster(raw);
  if (!row) throw new Error(`rawFieldsFromPlutoniumRecord: "${raw?.name ?? "?"}" is not a usable Plutonium monster record (missing name/stats, or a _copy reprint shell).`);

  const rawFields = {
    name: row.name,
    type: row.type ? (row.tags?.length ? `${row.type} (${row.tags.join(", ")})` : row.type) : "Unknown",
    ...(row.ac != null ? { ac: row.ac } : {}),
    ...(row.hp != null ? { hp: row.hp } : {}),
    ...(row.cr != null ? { challengeRating: row.cr } : {}),
    ...(row.size?.length ? { size: row.size.join("/") } : {}),
    ...(row.environment?.length ? { environment: row.environment.join(", ") } : {}),
    ...(row.legendary ? { legendary: true } : {})
  };

  const attacks = [];
  const rechargeAbilities = [];
  const traits = [];
  let multiattackText = null;

  for (const block of Array.isArray(raw.trait) ? raw.trait : []) {
    const t = traitFrom(block, "trait");
    if (t) traits.push(t);
  }
  for (const block of Array.isArray(raw.action) ? raw.action : []) {
    const rawText = flattenMonsterEntries(block.entries).join(" ");
    const name = cleanName(block.name);
    if (/^multiattack$/i.test(name)) { multiattackText = rawText; continue; }
    const rechargeOn = rechargeOnOf(block.name);
    if (rechargeOn) {
      const dmg = /\{@damage\s+([^}|]+)(?:\|[^}]*)?\}/.exec(rawText);
      rechargeAbilities.push({
        name,
        rechargeOn,
        ...(dmg ? { damageDice: dmg[1].replace(/\s+/g, "") } : {}),
        summary: capSummary(renderMonsterTagText(rawText))
      });
      continue;
    }
    if (isAttackText(rawText)) {
      const a = parseAttack(name, rawText);
      if (a) { attacks.push(a); continue; }
    }
    const t = traitFrom(block, "action");
    if (t) traits.push(t);
  }
  for (const block of Array.isArray(raw.bonus) ? raw.bonus : []) {
    const t = traitFrom(block, "bonus");
    if (t) traits.push(t);
  }
  for (const block of Array.isArray(raw.reaction) ? raw.reaction : []) {
    const t = traitFrom(block, "reaction");
    if (t) traits.push(t);
  }
  const legendary = Array.isArray(raw.legendary) ? raw.legendary : [];
  for (const block of legendary) {
    const t = traitFrom(block, "legendary");
    if (t) traits.push(t);
  }
  for (const block of Array.isArray(raw.spellcasting) ? raw.spellcasting : []) {
    const t = traitFrom(block, "spellcasting", false);
    if (t) traits.push(t);
  }

  if (attacks.length) rawFields.attacks = attacks;
  if (multiattackText != null) {
    const count = parseMultiattackCount(multiattackText) ?? 2;
    const lower = renderMonsterTagText(multiattackText).toLowerCase();
    const attackNames = attacks.map((a) => a.name).filter((n) => n && lower.includes(n.toLowerCase()));
    rawFields.multiattack = { count, ...(attackNames.length ? { attackNames } : {}) };
  }
  if (rechargeAbilities.length) rawFields.rechargeAbilities = rechargeAbilities;
  if (legendary.length) {
    rawFields.legendaryActions = { count: typeof raw.legendaryActions === "number" && raw.legendaryActions > 0 ? raw.legendaryActions : 3 };
  }
  if (traits.length) rawFields.traits = traits.slice(0, MAX_TRAITS);
  return rawFields;
}
