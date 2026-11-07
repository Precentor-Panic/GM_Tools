// The temple recipe: a long hall on one axis. Drawn with the entrance to the south and the sanctum to the north; the
// seed (or opts) turns and mirrors it.
//
//   narthex      a porch room across the front: the main doors in, a font
//   nave         the hall, with an aisle each side behind a row of pillars; pews either side of a centre walk
//   chapels      small bays off the aisles' outer walls, between buttresses, each with a statue and candles
//   sanctum      up steps at the far end, ending in a round apse: the altar, braziers, a lectern
//   sacristy     behind the apse, through a door in its wall, with the priests' own door out
//   vestry, crypt stair   rooms either side of the sanctum
//   bell tower   an optional square tower at a front corner
//   outside      a paved plaza with steps before the doors; grass round the rest
//
// opts: {nave 20-26 long, width 9-11 between the pillars, chapels 2-3 a side, tower?, round?: round pillars, mirror?, turn?}
import { Build, rng } from "./build.mjs";
import { transformPlan } from "./transform.mjs";

export function makeTemple(o = {}, seed = 1) {
  const r = rng(seed);
  const L = o.nave ?? r.int(20, 26), nw = o.width ?? r.pick([9, 11]), aw = 3, nd = r.int(3, 4), sd = r.int(5, 6);
  const nCh = o.chapels ?? r.int(2, 3), chD = 2.5, margin = 4, plazaD = 7;
  const round = o.round ?? r.chance(0.3), tower = o.tower ?? r.chance(0.6);
  const BW = nw + 2 * aw, apseR = nw / 2;
  const sacD = 3, Wm = Math.ceil(BW + 2 * (chD + margin)), Hm = Math.ceil(2 + sacD + apseR + sd + L + nd + plazaD);
  const b = new Build(Wm, Hm, { seed, outerWall: "stone", innerWall: "stone" });
  const x0 = (Wm - BW) / 2, xa = x0 + aw, xb = x0 + aw + nw, x1 = x0 + BW, cx = Wm / 2;
  const yS = Hm - plazaD, yN = yS - nd - L, ys = yN - sd; // front wall, nave's north end, sanctum's north edge

  b.ground("grass", { rect: [0, 0, Wm, Hm] }, { label: "grounds", material: "grass" });
  b.ground("plaza", { rect: [x0 - chD - 1, yS, BW + 2 * chD + 2, plazaD] }, { label: "plaza", material: "paving" });
  b.room("narthex", { rect: [x0, yS - nd, BW, nd] }, { label: "narthex", material: "stone" });
  b.room("nave", { rect: [x0, yN, BW, L] }, { label: "nave", material: "stone" });
  b.room("sanctum", { rect: [xa, ys, nw, sd] }, { label: "sanctum", material: "ornate" });
  b.room("sanctum", { circle: [cx, ys, apseR] }, { where: [b.cv.byKey("grass")] });
  b.room("vestry", { rect: [x0, ys, aw, sd] }, { label: "vestry", material: "stone" });
  b.room("crypt", { rect: [xb, ys, aw, sd] }, { label: "crypt stair", material: "stone" });
  // The sacristy behind the apse: its south wall is the apse's curve.
  b.room("sacristy", { rect: [cx - 3, ys - apseR - sacD + 0.5, 6, sacD + 1] }, { label: "sacristy", material: "stone", where: [b.cv.byKey("grass")] });

  // Chapels between buttresses along both aisles: bays spread along the nave, clear of its ends.
  const span = L - 4, step = span / nCh, chW = Math.min(4, step - 1.5);
  const bays = [];
  for (let i = 0; i < nCh; i++) bays.push(Math.round(yN + 2 + step * i + (step - chW) / 2));
  bays.forEach((y, i) => {
    b.room(`chapel-w${i}`, { rect: [x0 - chD, y, chD, chW] }, { label: "chapel", material: "stone" });
    b.room(`chapel-e${i}`, { rect: [x1, y, chD, chW] }, { label: "chapel", material: "stone" });
  });
  // Buttresses: between and beyond the chapels, and at the corners of the apse end.
  const butY = [yN + 0.5, ...bays.map((y) => y + chW + (step - chW) / 2 - 0.4)].filter((y) => y < yS - nd - 1);
  for (const y of butY) {
    b.solid(`but-w${y}`, { rect: [x0 - 0.8, y, 0.8, 0.8] }, { material: "stone" });
    b.solid(`but-e${y}`, { rect: [x1, y, 0.8, 0.8] }, { material: "stone" });
  }
  b.solid("but-nw", { rect: [x0 - 0.8, ys + 0.5, 0.8, 0.8] }, { material: "stone" });
  b.solid("but-ne", { rect: [x1, ys + 0.5, 0.8, 0.8] }, { material: "stone" });
  if (tower) b.room("tower", { rect: [x0 - 2, yS - nd - 1, 4, 4] }, { label: "bell tower", material: "stone" });
  // Pillars down both sides of the nave, standing a square in from the aisle line.
  const pil = [];
  for (let y = yN + 2.5; y < yS - nd - 1.5; y += 3) for (const x of [xa, xb]) pil.push([x, y]);
  pil.forEach(([x, y], i) => b.solid(`pillar-${i}`, round ? { circle: [x, y, 0.5] } : { rect: [x - 0.5, y - 0.5, 1, 1] }, { material: "stone" }));

  // ---- openings ----
  b.door("narthex", "plaza", { at: [cx, yS], width: 2 });
  b.door("narthex", "nave", { at: [cx, yS - nd], width: 2 });
  b.door("narthex", "nave", { at: [x0 + 1.2, yS - nd], width: 1 });
  b.door("narthex", "nave", { at: [x1 - 1.2, yS - nd], width: 1 });
  b.arch("nave", "sanctum", { at: [cx, yN], width: nw - 2 });
  b.door("sanctum", "vestry", { at: [xa, ys + sd - 1.5] });
  b.door("sanctum", "crypt", { at: [xb, ys + sd - 1.5] });
  b.door("sanctum", "sacristy", { at: [cx, ys - apseR] });
  b.door("sacristy", "grass", { at: [cx + 3, ys - apseR - sacD / 2 + 0.5] });
  b.door("vestry", "nave", { at: [x0 + 1.5, yN] });
  bays.forEach((y, i) => { b.arch("nave", `chapel-w${i}`, { at: [x0, y + chW / 2], width: chW - 1 }); b.arch("nave", `chapel-e${i}`, { at: [x1, y + chW / 2], width: chW - 1 }); });
  if (tower) b.door("tower", "narthex", { at: [x0 + 1, yS - nd + 1] });
  // Windows: tall ones in the aisle walls between the bays, round the apse, and either side of the front doors.
  for (let y = yN + 1.5; y < yS - nd - 1; y += 2.5) for (const [x, side] of [[x0, "w"], [x1, "e"]]) b.window("nave", "grass", { at: [x, y], width: 1, optional: true });
  for (const a of [-0.6, 0, 0.6]) b.window("sanctum", "grass", { at: [cx + Math.sin(a) * apseR, ys - Math.cos(a) * apseR], width: 1, optional: true });
  b.window("narthex", "plaza", { at: [cx - 3, yS], width: 1, optional: true });
  b.window("narthex", "plaza", { at: [cx + 3, yS], width: 1, optional: true });

  // Keep the centre walk and the chancel clear.
  b.keepClear([cx - 1, yN, 2, L]);
  b.trace(o.name ?? "Temple");

  // ---- dressing ----
  // Pews in rows either side of the walk, between the pillar rows.
  const pewW = (nw - 2) / 2 - 0.3;
  for (let y = yN + 3.5; y < yS - nd - 1.2; y += 1.5) {
    b.item("pew", cx - 1 - pewW / 2 - 0.1, y, { size: pewW, rotation: 0 });
    b.item("pew", cx + 1 + pewW / 2 + 0.1, y, { size: pewW, rotation: 0 });
  }
  // The runner down the centre walk: a strip of carpet laid on the floor.
  b.plan.areas.push({ id: "runner", kind: "floor", material: "carpet", shape: { rect: [cx - 1, yN + 0.5, 2, L - 1] } });
  // The sanctum: steps up, the altar before the apse, braziers, a lectern.
  b.item("stone steps", cx, yN - 0.6, { size: nw - 2, rotation: 0, layer: "floor" });
  b.item("altar", cx, ys - 0.5, { size: 2.2, rotation: 0 });
  b.item("altar candles", cx, ys - 1.3, { size: 1 });
  for (const dx of [-2, 2]) { b.item("brazier", cx + dx, ys + 0.6, { size: 1 }); b.light(cx + dx, ys + 0.6, { bright: 2, dim: 6, color: "#ffb060" }); }
  b.item("lectern", cx + 2.4, yN - 1.8, { size: 1, rotation: 180 });
  b.light(cx, ys - 1.2, { bright: 1, dim: 4, color: "#ffe0a0" });
  // Chapels: a statue against the outer wall, candles.
  bays.forEach((y, i) => {
    for (const [x, rot] of [[x0 - chD + 0.6, 90], [x1 + chD - 0.6, 270]]) {
      b.item("statue", x, y + chW / 2, { size: 2, rotation: rot });
      b.item("candles", x + (rot === 90 ? 0.9 : -0.9), y + chW / 2 + 0.8, { size: 0.7 });
      b.light(x + (rot === 90 ? 0.9 : -0.9), y + chW / 2 + 0.8, { bright: 0.5, dim: 3, color: "#ffd890" });
    }
  });
  // Narthex: a font, lamps by the doors.
  b.item("font", cx - 3.2, yS - nd / 2, { size: 1.4 });
  for (const dx of [-1.8, 1.8]) b.light(cx + dx, yS - 0.6, { bright: 1, dim: 4, color: "#ffd890" });
  // Vestry and sacristy: a wardrobe of vestments, a chest, a table of vessels.
  b.item("cabinet", x0 + 0.5, ys + 1.5, { size: 1.8, rotation: 90 });
  b.item("chest", x0 + 1.5, ys + 0.6, { size: 1 });
  b.item("stone stairs", xb + aw / 2, ys + 1.8, { size: 3, rotation: 90 });
  b.item("table", cx - 1.2, ys - apseR - sacD / 2, { size: 2, rotation: 0 });
  b.item("shelf", cx + 1.5, ys - apseR - sacD + 0.9, { size: 2, rotation: 0 });
  b.item("chest", cx - 2.3, ys - apseR - sacD + 1, { size: 1 });
  b.light(x0 + aw / 2, ys + 2.5, { bright: 1, dim: 3, color: "#ffd890" }); b.light(xb + aw / 2, ys + 3.5, { bright: 1, dim: 3, color: "#ffd890" });
  b.light(cx, ys - apseR - sacD / 2, { bright: 1, dim: 3, color: "#ffd890" });
  if (tower) { b.item("ladder", x0 - 1, yS - nd + 0.5, { size: 2, rotation: 0 }); b.item("bell rope", x0, yS - nd, { size: 0.6 }); }
  // Outside: steps up to the doors, lamps on the plaza, a few trees in the grounds.
  b.item("stone steps", cx, yS + 0.8, { size: 4, rotation: 0, layer: "floor" });
  for (const dx of [-4, 4]) { b.item("lamp post", cx + dx, yS + 2.5, { size: 1 }); b.light(cx + dx, yS + 2.5, { bright: 2, dim: 6, color: "#ffcf8a" }); }
  b.scatter("grass", 4, 1.6, (x, y, rr) => b.item("tree", x, y, { size: rr.range(3, 4.5), rotation: rr.int(0, 359), layer: "above" }), { within: [0, 0, Wm, yS - 1] });
  b.mark("entrance", cx, yS + 0.5, "main doors");
  b.mark("exit", cx + 3.5, ys - apseR - sacD / 2 + 0.5, "priests' door");
  b.mark("exit", xb + aw / 2, ys + 1.5, "stairs down", "crypt");
  b.mark("landmark", cx, ys - 0.5, "altar");

  const plan = b.done({ name: o.name ?? "Temple", brief: { recipe: "temple", seed }, source: { kind: "maker", ref: `temple:${seed}` } });
  const mirror = o.mirror ?? r.chance(0.5);
  return mirror || o.turn ? Object.assign(transformPlan(plan, { mirror, turn: o.turn ?? 0 }), { regions: plan.regions, links: plan.links }) : plan;
}
