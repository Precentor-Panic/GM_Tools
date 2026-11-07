// The sewer recipe: brick tunnels meeting at a junction. Drawn with the main channel running west to east.
//
//   junction     an octagonal chamber, a deep pool in the middle where the channels meet, walkways round it
//   tunnels      west (the way in) and east carry the main channel between walkways; north (a dead end with a
//                ladder up to a street grate) and south (running on) are side drains behind iron gates
//   sluice       on the east tunnel: a gate across the channel, piers that pinch the walkways to one square
//   workers' room   off the west tunnel and the junction, two doors: a way round
//
// opts: {width 6 (tunnel), south?: true, mirror?, turn?}
import { Build, rng } from "./build.mjs";
import { transformPlan } from "./transform.mjs";

export function makeSewer(o = {}, seed = 1) {
  const r = rng(seed);
  const Wm = 40, tw = o.width ?? 6, ch = 2.5, h = r.pick([5, 5.5]), c = r.pick([1.5, 2]);
  const cx = r.int(18, 21), cy = 15 + r.int(0, 1), south = o.south ?? r.chance(0.7);
  const Hm = south ? 32 : Math.ceil(cy + h + 3);                       // no south drain: the map stops below the junction
  const b = new Build(Wm, Hm, { seed, voidKind: "rock", organicRock: false, outerWall: "brick", innerWall: "brick" });
  const mat = { material: "brick" };
  // The junction and the four arms.
  b.room("junction", { polygon: [[cx - h + c, cy - h], [cx + h - c, cy - h], [cx + h, cy - h + c], [cx + h, cy + h - c], [cx + h - c, cy + h], [cx - h + c, cy + h], [cx - h, cy + h - c], [cx - h, cy - h + c]] }, { label: "junction", ...mat });
  b.room("junction", { rect: [0, cy - tw / 2, cx, tw] });              // the west tunnel runs into the junction: one space
  b.room("east", { rect: [cx + h, cy - tw / 2, Wm - cx - h, tw] }, { label: "east tunnel", ...mat });
  b.room("north", { rect: [cx - 2, 3, 4, cy - h - 3] }, { label: "north drain", ...mat });
  b.room("north", { rect: [cx - 2.5, 2, 5, 3] });                       // the ladder bay at its end
  if (south) b.room("south", { rect: [cx - 2, cy + h, 4, Hm - cy - h] }, { label: "south drain", ...mat });
  // The workers' room, above the west tunnel and against the junction.
  const rw = 6, rd = 5, rx = cx - h - rw, ry = cy - tw / 2 - rd;
  b.room("workers", { rect: [rx, ry, rw, rd] }, { label: "workers' room", ...mat });
  // Sluice piers on the east tunnel.
  const xs = cx + h + r.int(4, 6), pier = (tw - ch) / 2 - 1;
  b.solid("pier-n", { rect: [xs, cy - tw / 2, 1, pier] }, mat);
  b.solid("pier-s", { rect: [xs, cy + tw / 2 - pier, 1, pier] }, mat);
  // Brick pillars holding up the junction's vault, on the walkway ring.
  const pr = h - 1.6;
  for (const a of [45, 135, 225, 315].map((d) => (d * Math.PI) / 180)) b.solid(`pillar-${a.toFixed(2)}`, { rect: [cx + Math.cos(a) * pr - 0.5, cy + Math.sin(a) * pr - 0.5, 1, 1] }, mat);

  // ---- openings ----
  b.open("junction", "east");
  b.door("junction", "north", { at: [cx, cy - h], width: 4, margin: 0, closed: r.chance(0.5) });
  if (south) b.door("junction", "south", { at: [cx, cy + h], width: 4, margin: 0, closed: true });
  b.door("workers", "junction", { at: [rx + rw / 2, cy - tw / 2] });
  b.door("workers", "junction", { at: [cx - h, ry + rd - 0.75] });
  // The sluice gate: across the channel only, between the piers. Stops a swimmer, not a look.
  const gate = [[xs + 0.5, cy - ch / 2], [xs + 0.5, cy + ch / 2]];
  b.walls.push({ points: gate, kind: "window", move: true, sight: false, material: "iron" });
  b.keepClear([0, cy - ch / 2 - 0.2, Wm, ch + 0.4]);                 // the channel
  b.keepClear([cx - 2.7, cy - 2.7, 5.4, 5.4]);                         // the pool
  b.trace(o.name ?? "Sewer junction");

  // ---- water ----
  b.area("channel-w", "water", { rect: [0, cy - ch / 2, cx - 2.5, ch] }, { depth: "chest", label: "channel" });
  b.area("channel-e", "water", { rect: [cx + 2.5, cy - ch / 2, Wm - cx - 2.5, ch] }, { depth: "chest", label: "channel" });
  b.area("pool", "water", { circle: [cx, cy, 2.6] }, { depth: "deep", label: "the pool" });
  b.area("drain-n", "water", { rect: [cx - 0.5, cy - h + 0.2, 1, h - 3.4] }, { depth: "shallow", label: "drain" });
  if (south) b.area("drain-s", "water", { rect: [cx - 0.5, cy + 3, 1, Hm - cy - 3] }, { depth: "shallow", label: "drain" });
  // The plan's areas were fixed at trace(); add these to it.
  b.plan.areas.push(...b.areas.map((a) => ({ ...a })));

  // ---- dressing ----
  // Bridges where the walkways cross the channel, at the junction's west and east sides.
  for (const x of [cx - h + 0.9, cx + h - 0.9]) b.item("plank bridge", x, cy, { size: ch + 1, rotation: 90 });
  b.item("winch", xs + 0.5, cy - tw / 2 + pier + 0.6, { size: 1 });
  b.item("sluice gate", xs + 0.5, cy, { size: ch, rotation: 90 });
  for (const [x, y] of [[cx - 4.5, cy - 3.5], [cx + 4.2, cy + 3.8]]) b.item("grate", x, y, { size: 1.2, layer: "floor" });
  // Outflow pipes from the tunnel walls into the channel.
  for (let x = 3; x < cx - h - 1; x += r.int(5, 7)) b.item("pipe", x, cy + tw / 2 - 0.4, { size: 1, rotation: 270 });
  for (let x = xs + 4; x < Wm - 2; x += r.int(5, 7)) b.item("pipe", x, cy - tw / 2 + 0.4, { size: 1, rotation: 90 });
  b.item("ladder", cx, 2.6, { size: 2, rotation: 0 });
  b.light(cx, 3, { bright: 1, dim: 4, color: "#a8c8ff" }); // street light down the shaft
  // The workers' room: a table, bunks, tools, a lantern.
  b.item("table", rx + rw / 2, ry + rd / 2, { size: 2, rotation: 0 });
  b.item("bunk bed", rx + 0.6, ry + 1.3, { size: 2, rotation: 90 });
  b.item("tool rack", rx + rw - 0.4, ry + 1.2, { size: 1.5, rotation: 270 });
  b.item("crate", rx + rw - 0.8, ry + rd - 0.8, { size: 1 });
  b.light(rx + rw / 2, ry + rd / 2, { bright: 1, dim: 4, color: "#ffcf8a" });
  b.light(xs + 1.5, cy - tw / 2 + 0.6, { bright: 1, dim: 4, color: "#ffa050" }); // a torch at the sluice
  // Clutter on the walkways: barrels, rubble, bones, moss.
  for (const key of ["junction", "east", ...(south ? ["south"] : [])]) {
    b.scatter(key, key === "junction" ? 6 : 3, 0.45, (x, y, rr) => b.item(rr.pick(["barrel", "crate", "rubble pile", "bones", "puddle"]), x, y, { size: rr.range(0.7, 1.1), rotation: rr.int(0, 359), ...(rr.chance(0.3) ? { layer: "floor" } : {}) }));
  }
  b.mark("entrance", 0.5, cy - tw / 2 + 0.8, "west tunnel");
  b.mark("exit", Wm - 0.5, cy - tw / 2 + 0.8, "east tunnel");
  b.mark("exit", cx, 2.6, "ladder up", "street");
  if (south) b.mark("exit", cx, Hm - 0.5, "south drain");

  const plan = b.done({ name: o.name ?? "Sewer junction", brief: { recipe: "sewer", seed }, source: { kind: "maker", ref: `sewer:${seed}` } });
  const mirror = o.mirror ?? r.chance(0.5);
  return mirror || o.turn ? Object.assign(transformPlan(plan, { mirror, turn: o.turn ?? 0 }), { regions: plan.regions, links: plan.links }) : plan;
}
