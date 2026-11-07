// The fort recipe: a square curtain wall with towers at the corners, a gatehouse, buildings against the inner walls,
// a yard. Drawn with the gate to the south. `ruin` adds the wear (wear.mjs): a tower fallen, a breach in the curtain,
// bites out of the walls, trees growing through a roofless building.
//
//   curtain      a solid ring a square thick; towers round or square, hollow, a door into the yard
//   gatehouse    two guard rooms flanking a gate passage, a portcullis at each end
//   barracks     along the north wall: dormitory, mess, store
//   hall         along the west wall: a great hall and its kitchen
//   yard         open ground: a well, a cart, a practice post
//
// opts: {side 24-30, round?: round towers, ruin?: true, mirror?, turn?}
import { Build, rng } from "./build.mjs";
import { transformPlan } from "./transform.mjs";
import { breach, fall, crumble } from "./wear.mjs";

export function makeFort(o = {}, seed = 1) {
  const r = rng(seed);
  const S = o.side ?? 2 * r.int(12, 15), t = 1, M = 6, roundT = o.round ?? r.chance(0.6), ruin = o.ruin ?? true;
  const Wm = S + 2 * M, Hm = S + 2 * M + 2;
  const b = new Build(Wm, Hm, { seed, outerWall: "stone", innerWall: "wood" });
  const x0 = M, y0 = M, x1 = x0 + S, y1 = y0 + S, cx = x0 + S / 2;
  const ix0 = x0 + t, iy0 = y0 + t, ix1 = x1 - t, iy1 = y1 - t;

  b.ground("grass", null, { material: "grass" }); // the void is grass; named for links
  b.ground("road", { rect: [cx - 1.5, y1, 3, Hm - y1] }, { label: "road", material: "dirt" });
  b.solid("curtain", { rect: [x0, y0, S, S] }, { label: "curtain wall", material: "stone" });
  b.ground("yard", { rect: [ix0, iy0, S - 2 * t, S - 2 * t] }, { label: "yard", material: "dirt" });
  // Corner towers: masonry merged with the curtain, a room inside.
  const TR = 3.25, TI = 2.25, corners = [["nw", x0, y0], ["ne", x1, y0], ["sw", x0, y1], ["se", x1, y1]];
  const towerDoor = {};
  for (const [k, x, y] of corners) {
    b.solid("curtain", roundT ? { circle: [x, y, TR] } : { rect: [x - TR, y - TR, 2 * TR, 2 * TR] });
    b.room(`tower-${k}`, roundT ? { circle: [x, y, TI] } : { rect: [x - TI, y - TI, 2 * TI, 2 * TI] }, { label: "tower", material: "stone" });
    // A doorway through the masonry into the yard, beside the curtain's inner face.
    const sx = x === x0 ? 1 : -1, sy = y === y0 ? 1 : -1, dx0 = x + sx * 1.25, dy1 = y + sy * (TR + 0.5);
    b.room(`tower-${k}`, { rect: [Math.min(dx0, dx0 + sx), Math.min(y + sy * 0.5, dy1), 1, Math.abs(dy1 - (y + sy * 0.5))] });
    towerDoor[k] = [dx0 + sx * 0.5, dy1];
  }
  // Gatehouse: two towers jutting out either side of a passage through the south wall.
  const gw = 3, gtW = 3.5, gtD = 5, gy = y1 - 2.5;
  b.solid("curtain", { rect: [cx - gw / 2 - gtW, gy, gtW, gtD] });
  b.solid("curtain", { rect: [cx + gw / 2, gy, gtW, gtD] });
  // Guard rooms run right up to the passage, so their doors open onto it.
  b.room("guard-w", { rect: [cx - gw / 2 - gtW + 0.75, gy + 0.75, gtW - 0.75, gtD - 1.5] }, { label: "guard room", material: "stone" });
  b.room("guard-e", { rect: [cx + gw / 2, gy + 0.75, gtW - 0.75, gtD - 1.5] }, { label: "guard room", material: "stone" });
  b.room("gate", { rect: [cx - gw / 2, gy, gw, gtD] }, { label: "gate passage", material: "stone" });
  // Barracks along the north wall, between the corner towers' reach.
  const bx0 = ix0 + TR + 0.5, bx1 = ix1 - TR - 0.5, bd = 5, bw = bx1 - bx0;
  const cut1 = bx0 + Math.round(bw * r.range(0.4, 0.5)), cut2 = cut1 + Math.round(bw * r.range(0.25, 0.32));
  b.room("dorm", { rect: [bx0, iy0, cut1 - bx0, bd] }, { label: "dormitory", material: "wood" });
  b.room("mess", { rect: [cut1, iy0, cut2 - cut1, bd] }, { label: "mess", material: "wood" });
  b.room("store", { rect: [cut2, iy0, bx1 - cut2, bd] }, { label: "store", material: "wood" });
  // The hall along the west wall.
  const hy0 = iy0 + TR + 2, hd = 7, hl = Math.min(11, iy1 - TR - 1 - hy0);
  const kl = Math.round(hl * 0.3);
  b.room("hall", { rect: [ix0, hy0, hd, hl - kl] }, { label: "great hall", material: "stone" });
  b.room("kitchen", { rect: [ix0, hy0 + hl - kl, hd, kl] }, { label: "kitchen", material: "stone" });

  // ---- the wear ----
  const rubble = [];
  let fallen = null, breachAt = null;
  if (ruin) {
    // A tower down: one of the back corners, so the gate still stands.
    fallen = r.pick(["nw", "ne"]);
    const [, fx, fy] = corners.find(([k]) => k === fallen);
    rubble.push(...fall(b, { mass: "curtain", floor: `tower-${fallen}`, at: [fx, fy], r: TR, keep: r.range(0.3, 0.45) }));
    // A breach in a side wall, away from the fallen tower's side.
    const side = fallen === "nw" ? "e" : "w";
    const by = y0 + S * r.range(0.55, 0.7);
    breachAt = [side === "w" ? x0 + t / 2 : x1 - t / 2, by];
    rubble.push(...breach(b, { mass: "curtain", at: breachAt, width: r.range(3, 4), depth: t + 0.5, spill: 2.5 }).map(([x, y, rr]) => [x, y, rr]));
    rubble.push(...crumble(b, { mass: "curtain", n: 12, r: [0.4, 0.85] }));
  }

  // ---- openings ----
  b.door("gate", "road", { at: [cx, gy + gtD], width: gw, closed: true, margin: 0 });
  b.door("gate", "yard", { at: [cx, gy], width: gw, closed: false, margin: 0 });
  b.door("guard-w", "gate", { at: [cx - gw / 2, gy + gtD / 2] });
  b.door("guard-e", "gate", { at: [cx + gw / 2, gy + gtD / 2] });
  for (const [k] of corners) if (k !== fallen) b.door(`tower-${k}`, "yard", { at: towerDoor[k], margin: 0 });
  b.door("dorm", "yard", { at: [(bx0 + cut1) / 2, iy0 + bd] });
  b.door("mess", "yard", { at: [(cut1 + cut2) / 2, iy0 + bd], width: 2 });
  b.door("store", "yard", { at: [(cut2 + bx1) / 2, iy0 + bd] });
  // Inside the roofless barracks a partition has gone: an arch where a door was.
  if (ruin) b.arch("dorm", "mess", { at: [cut1, iy0 + bd / 2], width: 2 }); else b.door("dorm", "mess", { at: [cut1, iy0 + bd / 2] });
  b.door("hall", "yard", { at: [ix0 + hd, hy0 + (hl - kl) / 2], width: 2 });
  b.door("hall", "kitchen", { at: [ix0 + hd / 2, hy0 + hl - kl] });
  b.door("kitchen", "yard", { at: [ix0 + hd, hy0 + hl - kl / 2] });
  for (const [k, x, y] of corners) if (k !== fallen) b.window(`tower-${k}`, "grass", { width: 0.8, optional: true });
  b.window("hall", "yard", { at: [ix0 + hd, hy0 + 1.5], width: 1.2, optional: true });

  b.keepClear([cx - 2, iy1 - 4, 4, 4]); // in from the gate
  if (ruin) {
    // Overgrowth: grass taking the yard back in patches.
    const gr = r.fork("overgrowth");
    for (let i = 0; i < 5; i++) b.area(`overgrowth-${i}`, "open", { ellipse: [gr.range(ix0 + hd + 2, ix1 - 2), gr.range(iy0 + bd + 2, iy1 - 2), gr.range(2.5, 4.5), gr.range(1.8, 3.2)] }, { material: "grass" });
  }
  b.trace(o.name ?? (ruin ? "Ruined fort" : "Fort"));

  // ---- dressing ----
  for (const [x, y, rr] of rubble) {
    b.item("rubble pile", x, y, { size: Math.max(1, Math.min(3, rr * 1.6)), rotation: b.r.int(0, 359) });
  }
  // Barracks: bunks in the dormitory, a long table in the mess, crates in the store; trees through the roofless dorm.
  for (let x = bx0 + 1; x < cut1 - 0.8; x += 1.6) b.item("bunk bed", x, iy0 + 1.1, { size: 2, rotation: 0 }); // head to the wall
  if (ruin) { b.item("tree", (bx0 + cut1) / 2, iy0 + 3, { size: 4.5, rotation: b.r.int(0, 359), layer: "above" }); b.item("rubble pile", bx0 + 1.5, iy0 + 3.6, { size: 1.5, rotation: 40 }); }
  b.item("table", (cut1 + cut2) / 2, iy0 + 2.2, { size: Math.min(4, cut2 - cut1 - 1.5), rotation: 0 });
  for (const dy of [-0.9, 0.9]) b.item("bench", (cut1 + cut2) / 2, iy0 + 2.2 + dy, { size: Math.min(4, cut2 - cut1 - 1.5), rotation: 0 });
  b.scatter("store", 5, 0.55, (x, y, rr) => b.item(rr.pick(["crate", "barrel", "sack", "weapon rack"]), x, y, { size: 1, rotation: rr.int(0, 359) }));
  // The hall: a long table and a hearth; the kitchen's oven.
  b.item("table", ix0 + hd / 2, hy0 + (hl - kl) / 2, { size: Math.min(5, hl - kl - 1.5), rotation: 90 });
  b.item("fireplace", ix0 + 0.45, hy0 + 1.5, { size: 2.2, rotation: 90 });
  b.light(ix0 + 1, hy0 + 1.5, { bright: 2, dim: 6, color: "#ff9a4a" });
  b.item("oven", ix0 + 1.2, hy0 + hl - kl / 2, { size: 2, rotation: 90 });
  b.item("barrel", ix0 + hd - 1, hy0 + hl - 0.7, { size: 1 });
  // The yard: a well, a cart, a practice post, weeds.
  b.item("well", cx + 2, (iy0 + bd + iy1) / 2, { size: 2 });
  b.item("cart", ix1 - TR - 3, iy1 - 3, { size: 3, rotation: 15 });
  b.item("training dummy", ix0 + hd + 3, iy1 - 3, { size: 1 });
  b.scatter("yard", ruin ? 16 : 6, 0.8, (x, y, rr) => b.item(rr.pick(ruin ? ["bush", "tall grass", "tall grass", "rubble pile"] : ["bush", "bush", "tall grass"]), x, y, { size: rr.range(1, 1.8), rotation: rr.int(0, 359) }));
  // Outside: trees round the walls, the road in.
  b.scatter("void", 12, 1.8, (x, y, rr) => b.item("tree", x, y, { size: rr.range(3.5, 5), rotation: rr.int(0, 359), layer: "above" }), { within: [0, 0, Wm, Hm] });
  // Lights: torches at the gate and the hall door (the rest is dark).
  for (const dx of [-2.3, 2.3]) { b.item("torch", cx + dx, gy + gtD + 0.3, { size: 0.6 }); b.light(cx + dx, gy + gtD + 0.4, { bright: 1, dim: 4, color: "#ffa050" }); }
  b.light(ix0 + hd + 0.6, hy0 + (hl - kl) / 2, { bright: 1, dim: 4, color: "#ffa050" });
  b.mark("entrance", cx, Hm - 1, "the road");
  if (breachAt) b.mark("entrance", breachAt[0], breachAt[1], "the breach");

  const plan = b.done({ name: o.name ?? (ruin ? "Ruined fort" : "Fort"), brief: { recipe: "fort", seed, ruin }, source: { kind: "maker", ref: `fort:${seed}` } });
  const mirror = o.mirror ?? r.chance(0.5);
  return mirror || o.turn ? Object.assign(transformPlan(plan, { mirror, turn: o.turn ?? 0 }), { regions: plan.regions, links: plan.links }) : plan;
}
