// Clash checks: combinations of pieces that would look wrong at the table (pure; no fs).
//
// These are WARNINGS, never problems: the map still assembles and can be pushed, because
// sometimes the GM wants the odd one out (one blood-soaked room among clean ones). A warning
// has a stable `id`, so a composition can list it under `clash.ignore` once the GM has
// looked at it and accepted it.
//
// They read segment v2 fields (composition.mjs): tags, variantInfo and measured colours.
// A piece without a given tag is simply not checked for it, so untagged v1 segments never warn.
//
// Join checks (floor, colour) look only at OPEN openings between two pieces: a door, or a
// piece tagged role "transition" on either side, reads as an intended change of scene.

export const CLASH_DEFAULTS = { colourDelta: 20 };

/** CIE76 distance between two Lab colours. */
export function deltaE(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

const name = (p) => p.label || p.key;
const listNames = (ps) => ps.map(name).join(", ");

// Group placed pieces by a per-variant value; only pieces that state the value take part.
function groupBy(placed, pick) {
  const groups = new Map();
  for (const p of placed) {
    const v = pick(p);
    if (v == null) continue;
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(p);
  }
  return groups;
}

// One warning naming the minority groups against the largest one.
function mixed(code, what, groups) {
  if (groups.size < 2) return null;
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const [mainV, mainPs] = sorted[0];
  const odd = sorted.slice(1).map(([v, ps]) => `${listNames(ps)} ${ps.length > 1 ? "are" : "is"} ${v}`);
  return {
    id: code, code,
    message: `mixed ${what}: ${odd.join("; ")}, while ${mainPs.length > 1 ? `the other ${mainPs.length} are` : `${name(mainPs[0])} is`} ${mainV}`,
    pieces: sorted.slice(1).flatMap(([, ps]) => ps.map((p) => p.key))
  };
}

/**
 * @param {object} comp     a parsed composition
 * @param {Array<{key, label?, segment, seg, variant, file}>} placed  each piece with its parsed segment and the art file it shows
 * @param {Array<{opening, pieces: string[]}>} joins  each opening with the keys of the pieces whose edges it touches
 * @returns {Array<{id, code, message, pieces, opening?}>}  minus anything in comp.clash.ignore
 */
export function clashWarnings(comp, placed, joins) {
  const opts = { ...CLASH_DEFAULTS, ...(comp.clash ?? {}) };
  const ignore = new Set(comp.clash?.ignore ?? []);
  const out = [];
  const byKey = new Map(placed.map((p) => [p.key, p]));

  // The same landmark twice.
  for (const [segment, ps] of groupBy(placed, (p) => (p.seg.tags?.unique ? p.segment : null))) {
    if (ps.length > 1) out.push({ id: `unique-repeat:${segment}`, code: "unique-repeat", message: `${segment} is a one-off landmark but appears ${ps.length} times (${listNames(ps)})`, pieces: ps.map((p) => p.key) });
  }

  // Story state and time of day, per placed variant. A variant without info counts as clean; time is only compared when stated.
  const state = mixed("mixed-state", "story state", groupBy(placed, (p) => (p.seg.variantInfo ? p.seg.variantInfo[p.variant]?.state ?? "clean" : null)));
  if (state) out.push(state);
  const time = mixed("mixed-time", "time of day", groupBy(placed, (p) => p.seg.variantInfo?.[p.variant]?.time ?? null));
  if (time) out.push(time);

  // Light direction: overhead light ("top") goes with anything.
  const light = mixed("mixed-light", "light direction", groupBy(placed, (p) => (p.seg.tags?.light && p.seg.tags.light !== "top" ? `lit from ${p.seg.tags.light}` : null)));
  if (light) out.push(light);

  // Open joins between two different-looking pieces.
  for (const { opening, pieces } of joins) {
    if (opening.kind !== "open" || pieces.length !== 2) continue;
    const [a, b] = pieces.map((k) => byKey.get(k));
    if (!a || !b || a.seg.tags?.role === "transition" || b.seg.tags?.role === "transition") continue;
    const fa = a.seg.tags?.floor, fb = b.seg.tags?.floor;
    if (fa?.length && fb?.length && !fa.some((m) => fb.includes(m))) {
      out.push({ id: `floor-jump:${opening.id}`, code: "floor-jump", opening: opening.id, pieces: [a.key, b.key],
        message: `${opening.id}: ${name(a)} (${fa.join("/")}) opens straight onto ${name(b)} (${fb.join("/")}) with nothing in common underfoot; a door or a transition piece would bridge it` });
    }
    const ca = a.seg.colours?.[a.file], cb = b.seg.colours?.[b.file];
    if (ca && cb) {
      const d = deltaE(ca, cb);
      if (d > opts.colourDelta) out.push({ id: `colour-jump:${opening.id}`, code: "colour-jump", opening: opening.id, pieces: [a.key, b.key], deltaE: Math.round(d),
        message: `${opening.id}: ${name(a)} and ${name(b)} differ sharply in colour (ΔE ${Math.round(d)}, limit ${opts.colourDelta}); a door, a transition piece or a theme grade would soften it` });
    }
  }
  return out.filter((w) => !ignore.has(w.id));
}
