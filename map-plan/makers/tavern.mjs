// The tavern recipe. Drawn with the street to the south and the kitchen to the west; the seed (or opts) mirrors it.
//
//   common room   the front 56-64% of the building: the bar along its back wall by the kitchen door, the hearth on a
//                 chimney breast in the far side wall, tables in the rest, an optional bay window onto the street
//   snug          an optional small room in the front corner, through an arch
//   back strip    kitchen (with an outshot into the yard and a pantry), stair hall (back door, stairs up), back room
//   outside       the yard behind (well, woodpile, cart, a privy), the street in front (lamp, crates)
//
// opts: {width 16-20, depth 11-13, mirror?, turn?}. Returns the plan.
import { Build, rng } from "./build.mjs";
import { transformPlan } from "./transform.mjs";

export function makeTavern(o = {}, seed = 1) {
  const r = rng(seed);
  const fw = o.width ?? r.int(16, 20), fd = o.depth ?? r.int(11, 13);
  const sideM = 4, yardD = 7, streetD = 5;
  const W = fw + 2 * sideM, H = yardD + fd + streetD;
  const b = new Build(W, H, { seed });
  const x0 = sideM, y0 = yardD, x1 = x0 + fw, y1 = y0 + fd;

  // ---- ground ----
  b.ground("yard", { rect: [0, 0, W, y1] }, { label: "yard", material: "grass" });
  b.ground("street", { rect: [0, y1, W, H - y1] }, { label: "street", material: "cobbles" });

  // ---- the building ----
  const cd = Math.round(fd * r.range(0.56, 0.64)), yb = y1 - cd;
  const kw = Math.round(fw * r.range(0.34, 0.42)), sw = 3, bw = fw - kw - sw;
  const out = r.int(1, 2), backIn = r.int(0, 1);
  const kx = x0, sx = x0 + kw, bx = sx + sw;
  b.room("common", { rect: [x0, yb, fw, cd] }, { label: "common room", material: "wood" });
  const snug = r.chance(0.65) ? { w: r.int(4, 5), d: Math.min(cd - 2, r.int(4, 5)) } : null;
  if (snug) b.room("snug", { rect: [x0, y1 - snug.d, snug.w, snug.d] }, { label: "snug", material: "wood" });
  b.room("kitchen", { rect: [kx, y0 - out, kw, yb - y0 + out] }, { label: "kitchen", material: "stone" });
  b.room("hall", { rect: [sx, y0, sw, yb - y0] }, { label: "stair hall", material: "plain wood" });
  b.room("back", { rect: [bx, y0 + backIn, bw, yb - y0 - backIn] }, { label: "back room", material: "plain wood" });
  const pw = r.int(2, 3);
  const pantry = r.chance(0.6);
  if (pantry) b.room("pantry", { rect: [kx, y0 - out, pw, 3] }, { label: "pantry", material: "plain wood" });
  // Chimney breasts: the common room's on its far side wall, the kitchen's on its back wall.
  const hy = yb + Math.max(1, Math.min(cd - 4, r.int(1, cd - 4)));
  b.solid("chimney", { rect: [x1, hy, 1, 3] }, { label: "chimney", material: "stone" });
  const kcx = kx + kw - 4;
  b.solid("kchimney", { rect: [kcx, y0 - out - 1, 3, 1] }, { label: "kitchen chimney", material: "stone" });
  // A bay window onto the street, clear of the snug.
  const frontFrom = x0 + (snug?.w ?? 0);
  const bayAt = r.chance(0.55) && x1 - frontFrom >= 11 ? frontFrom + 1 : null;
  if (bayAt != null) b.room("common", { polygon: [[bayAt, y1], [bayAt + 0.75, y1 + 1], [bayAt + 2.75, y1 + 1], [bayAt + 3.5, y1]] });
  // The privy, at the far corner of the yard from the kitchen.
  b.room("privy", { rect: [W - 3, 1, 2, 2] }, { label: "privy", material: "plain wood" });
  // Packed dirt behind the building where the work is done, and a worn path out to the privy: ground paint only
  // (the yard is one space), laid under the building.
  b.area("court", "open", { rect: [x0 - 1, y0 - out - 3, fw + 2, out + 3] }, { material: "dirt" });
  b.area("track", "open", { polygon: [[sx + 0.5, y0 - out - 1], [W - 2.5, 3.6], [W - 1.5, 3], [W - 2, 2.6], [sx + 1.5, y0 - out - 2]] }, { material: "path" });
  b.area("front", "open", { rect: [x0 - 1, y1, fw + 2, 1.2] }, { material: "dirt" });

  // ---- doors, arches, windows ----
  const doorX = Math.max((bayAt ?? frontFrom) + (bayAt != null ? 5 : 2), Math.round(frontFrom + (x1 - frontFrom) * r.range(0.45, 0.6)));
  b.door("common", "street", { at: [doorX, y1], width: 2 });
  b.door("common", "kitchen", { at: [sx - 1.2, yb] });
  b.arch("common", "hall", { at: [sx + 1.5, yb], width: 2 });
  b.door("hall", "back", { at: [bx, (y0 + yb) / 2 + 0.5] });
  b.door("hall", "yard", { at: [sx + 1.5, y0] });
  b.door("kitchen", "yard", { at: [kx, yb - 1.5] });
  if (pantry) b.door("kitchen", "pantry", { at: [kx + pw, y0 - out + 2] });
  if (snug) b.arch("common", "snug", { at: [x0 + snug.w, y1 - snug.d / 2], width: 2 });
  b.door("privy", "yard", { at: [W - 2, 3] });
  for (const wx of [frontFrom + 1.5, x1 - 2]) b.window("common", "street", { at: [wx, y1], width: 1.5, optional: true });
  if (bayAt != null) b.window("common", "street", { at: [bayAt + 1.75, y1 + 1], width: 1.5, optional: true });
  b.window("common", "yard", { at: [x1, y1 - 1.2], width: 1.5, optional: true });
  if (snug) b.window("snug", "street", { at: [x0 + snug.w / 2, y1], width: 1.5, optional: true });
  if (snug) b.window("snug", "yard", { at: [x0, y1 - snug.d / 2], width: 1.2, optional: true });
  b.window("back", "yard", { at: [bx + bw / 2, y0 + backIn], width: 1.5, optional: true });
  b.window("back", "yard", { at: [x1, (y0 + yb) / 2], width: 1.2, optional: true });
  b.window("kitchen", "yard", { at: [kx + kw / 2 - 1, y0 - out], width: 1.2, optional: true });
  // Fences: the yard is shut off from the street, with a gate on the east side.
  b.fence([[0.2, y1], [x0, y1]]);
  b.fence([[x1 + 1, y1], [W - 3, y1]]);

  // Keep clear before tracing so the scatter avoids them: the bar, the hearth, the stairs, the walk to the bar.
  const barY = yb + 1.6, barW = x0 + 1.5, barE = sx - 0.6;
  b.keepClear([x0, yb, sx - x0 + 0.2, 2.7]);
  b.keepClear([x1 - 3, hy - 0.6, 3, 4.2]);
  b.keepClear([doorX - 1, barY + 1, 2, y1 - barY - 1]);
  const plan0 = b.trace(o.name ?? "Tavern");
  void plan0;

  // ---- dressing ----
  // The bar: a counter with its flap at the west end, stools in front, kegs and a shelf behind.
  b.low([[barW, barY], [barE, barY], [barE, yb]]);
  // The counter in pieces about as long as its return to the back wall, so a renderer that scales a piece to its length
  // draws them all the same thickness.
  const nSeg = Math.ceil((barE - barW) / 1.8), seg = (barE - barW) / nSeg;
  for (let i = 0; i < nSeg; i++) b.item("bar counter", barW + seg * (i + 0.5), barY, { size: seg, rotation: 0 });
  b.item("bar counter", barE - 0.45, (yb + barY) / 2 - 0.2, { size: barY - yb + 0.1, rotation: 90 });
  for (let x = barW + 0.6; x < barE - 0.3; x += 1.1) b.item("bar stool", x, barY + 0.75, { size: 0.6 });
  for (let x = barW + 0.6, k = 0; x < barE - 1 && k < 3; x += 1.2, k++) b.item(k % 2 ? "barrel" : "keg", x, yb + 0.55, { size: 0.9 });
  b.item("shelf of bottles", x0 + 0.4, yb + 1.2, { size: 2, rotation: 90 });
  b.light((barW + barE) / 2, barY - 0.3, { bright: 2, dim: 5, color: "#ffcf8a" });
  // The hearth: fire on the chimney breast, a rug and two chairs before it.
  b.item("fireplace", x1 - 0.45, hy + 1.5, { size: 2.6, rotation: 270 });
  b.item("bear rug", x1 - 2.2, hy + 1.5, { size: 2.4, rotation: 90, layer: "floor" });
  b.item("armchair", x1 - 2.4, hy + 0.2, { size: 1, rotation: 135 });
  b.item("armchair", x1 - 2.4, hy + 2.8, { size: 1, rotation: 45 });
  b.light(x1 - 0.9, hy + 1.5, { bright: 3, dim: 8, color: "#ff9a4a" });
  // Tables with chairs round them.
  const commonArea = fw * cd - (snug ? snug.w * snug.d : 0);
  b.scatter("common", Math.round(commonArea / 11), 1.15, (x, y, rr) => {
    const square = rr.chance(0.35);
    b.item(square ? "table" : "table round", x, y, { size: square ? 1.5 : 1.4, rotation: square ? rr.pick([0, 90]) : rr.int(0, 359) });
    for (const [dx, dy, rot] of rr.shuffle([[1.05, 0, 270], [-1.05, 0, 90], [0, 1.05, 0], [0, -1.05, 180]]).slice(0, rr.int(2, 4))) b.item("chair", x + dx, y + dy, { size: 0.8, rotation: rot });
    if (rr.chance(0.45)) b.light(x, y, { bright: 1, dim: 3, color: "#ffd9a0" });
  });
  if (snug) {
    const cx = x0 + snug.w / 2, cy = y1 - snug.d / 2;
    b.item("table", cx, cy, { size: 2, rotation: 90 });
    b.item("bench", cx - 1.2, cy, { size: 2, rotation: 90 }); b.item("bench", cx + 1.2, cy, { size: 2, rotation: 90 });
    b.light(cx, cy, { bright: 1, dim: 3, color: "#ffd9a0" });
  }
  // Kitchen: the oven on the chimney, a worktable, barrels and sacks.
  b.item("oven", kcx + 1.5, y0 - out + 0.6, { size: 2.2, rotation: 0 });
  b.light(kcx + 1.5, y0 - out + 1, { bright: 2, dim: 5, color: "#ff8a3a" });
  const kmx = kx + kw / 2 + 0.5, kmy = (y0 - out + yb) / 2 + 0.4;
  b.item("worktable", kmx, kmy, { size: 2.4, rotation: 0 });
  b.item("pots and pans", kmx, kmy, { size: 1 });
  b.scatter("kitchen", 4, 0.55, (x, y, rr) => b.item(rr.pick(["barrel", "sack", "sack", "crate"]), x, y, { size: 0.9, rotation: rr.int(0, 359) }), { within: [kx, yb - 2.6, kw, 2.6] });
  if (pantry) b.scatter("pantry", 3, 0.5, (x, y, rr) => b.item(rr.pick(["sack", "crate", "barrel"]), x, y, { size: 0.9, rotation: rr.int(0, 359) }));
  // Stair hall: the stairs up along the east wall; a lamp.
  b.item("stairs", bx - 0.8, (y0 + yb) / 2 - 0.4, { size: 3, rotation: 270 });
  b.light(sx + 1, yb - 0.8, { bright: 1, dim: 4, color: "#ffd9a0" });
  // Back room: a private table.
  const bcx = bx + bw / 2, bcy = (y0 + backIn + yb) / 2;
  b.item("table", bcx, bcy, { size: 2.2, rotation: 0 });
  for (const [dx, dy, rot] of [[-0.6, -0.9, 180], [0.6, -0.9, 180], [-0.6, 0.9, 0], [0.6, 0.9, 0]]) b.item("chair", bcx + dx, bcy + dy, { size: 0.8, rotation: rot });
  b.item("cabinet", x1 - 0.5, y0 + backIn + 1.2, { size: 1.6, rotation: 270 });
  b.light(bcx, bcy, { bright: 1, dim: 4, color: "#ffd9a0" });
  // The yard: well, woodpile by the kitchen door, a cart, barrels.
  b.item("well", x0 + kw + 1.5, 3, { size: 2 });
  b.item("woodpile", kx - 1.3, yb - 3, { size: 2, rotation: 90 });
  b.item("cart", W - 6, 4.2, { size: 3, rotation: r.pick([0, 20, 340]) });
  b.scatter("yard", 3, 0.6, (x, y, rr) => b.item(rr.pick(["barrel", "crate", "hay bale"]), x, y, { size: 1, rotation: rr.int(0, 359) }), { within: [1, 1, W - 2, y0 - out - 2] });
  b.light(sx + 1.5, y0 - 0.6, { bright: 1, dim: 4, color: "#ffcf8a" });
  // The street: a lamp by the door, crates, a sign.
  b.item("lamp post", doorX + 2.5, y1 + 1.6, { size: 1 });
  b.light(doorX + 2.5, y1 + 1.6, { bright: 2, dim: 6, color: "#ffcf8a" });
  b.item("hanging sign", doorX - 1.6, y1 + 0.4, { size: 1.2 });
  b.scatter("street", 3, 0.6, (x, y, rr) => b.item(rr.pick(["crate", "barrel", "sack"]), x, y, { size: 0.9, rotation: rr.int(0, 359) }), { within: [1, y1 + 2.5, W - 2, H - y1 - 3] });
  b.mark("entrance", doorX, y1 + 0.5, "front door");
  b.mark("exit", sx + 1.5, y0 - 0.5, "back door");
  b.mark("exit", bx - 0.8, (y0 + yb) / 2 - 0.4, "stairs up", "upstairs");

  const plan = b.done({ name: o.name ?? "Tavern", brief: { recipe: "tavern", seed }, source: { kind: "maker", ref: `tavern:${seed}` } });
  const mirror = o.mirror ?? r.chance(0.5);
  return (mirror || o.turn) ? Object.assign(transformPlan(plan, { mirror, turn: o.turn ?? 0 }), { regions: plan.regions, links: plan.links }) : plan;
}
