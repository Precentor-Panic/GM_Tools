// A plan's character, computed from its walls (plan.mjs). The same numbers describe our maps, published maps whose
// walls we have, and a rough shape someone sketches, so the shelf can compare them; the play check reads them too.
//
// How: walls are drawn onto a fine grid (R cells per square). Cells cut off by walls that stop movement, with every
// door shut, are regions. A region that touches the map's edge is the outside (open ground, or the void round a
// dungeon); every other region big enough to stand in is a room. Doors join rooms into a graph.
//
// PROFILE v2 (2026-11-03; v1 the same day without bands, features and items) fields, in squares unless named otherwise:
//   size {w, h, area, aspect}         aspect = long side / short side
//   enclosure                         share of the map's area (less its walls) inside rooms (0 open country .. 1 a building cropped to
//                                     its walls; a dungeon in rock sits between, the rest being rock)
//   rooms {count, median, max, small, large, bands}   small < 9 sq, large > 100 sq (counts); bands counts rooms by size
//                                     the way a GM says it: closet < 9, small < 36 (6x6), medium < 100, large < 300, hall
//   building {count, rooms, area}     rooms joined by doors, outside not counted: how many with 2+ rooms; the largest's
//                                     rooms and area
//   graph {links, loops, deadEnds, isolated, doorsOut}   links = doors between rooms or to the outside
//   walls {length, density, squareness, diagonal, organic, meanSegment}   density = length per 100 sq; shares by length
//   openness {median, p90, longest}   share of floor seen within 12 sq (60 ft), sampled; longest sightline seen
//   space {narrowShare, widest}       share of floor within 1.25 sq of a wall; radius of the biggest open space
//   lights {count, density}           per 100 sq
//   features {windows, low, litRooms} length of walls that stop feet but not eyes (windows, fences, bars); length of low
//                                     and terrain walls (counters, hedges, tents, rubble lines); share of rooms with a light
//                                     inside
//   items {count, density, kinds}     things placed on the map (plan.items), per 100 sq of floor, by content kind
//   footprint {n, rooms[], walls[]}   n x n picture of where rooms and walls are, 0..1 per cell, for shape matching
import { segments } from "./plan.mjs";
import { contentsFromItems } from "./theme.mjs";

export const PROFILE_SCHEMA_VERSION = 2;
export const ROOM_BANDS = [["closet", 9], ["small", 36], ["medium", 100], ["large", 300], ["hall", Infinity]];
const band = (sq) => ROOM_BANDS.find(([, max]) => sq < max)[0];
const SIGHT_RADIUS = 12;
const FOOT = 12;

/** Mark every cell a segment passes through. */
function drawSeg(grid, W, H, R, [ax, ay], [bx, by]) {
  const x0 = ax * R, y0 = ay * R, x1 = bx * R, y1 = by * R;
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 4));
  for (let i = 0; i <= n; i++) {
    let x = Math.floor(x0 + ((x1 - x0) * i) / n), y = Math.floor(y0 + ((y1 - y0) * i) / n);
    // A wall on the map's own edge (x = width) falls one cell outside the grid: keep it on the edge cell, or every room
    // cropped tight to the map edge leaks into the outside.
    if (x === W) x = W - 1; else if (x === -1) x = 0;
    if (y === H) y = H - 1; else if (y === -1) y = 0;
    if (x >= 0 && y >= 0 && x < W && y < H) grid[y * W + x] = 1;
  }
}

/** Connected open cells (4-neighbour). Returns labels (0 = blocked) and per-label {cells, border}. */
function label(blocked, W, H) {
  const lab = new Int32Array(W * H), regions = [null];
  const stack = new Int32Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (blocked[s] || lab[s]) continue;
    const id = regions.length; let top = 0, cells = 0, border = false;
    stack[top++] = s; lab[s] = id;
    while (top) {
      const c = stack[--top]; cells++;
      const x = c % W, y = (c - x) / W;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true;
      if (x > 0 && !blocked[c - 1] && !lab[c - 1]) { lab[c - 1] = id; stack[top++] = c - 1; }
      if (x < W - 1 && !blocked[c + 1] && !lab[c + 1]) { lab[c + 1] = id; stack[top++] = c + 1; }
      if (y > 0 && !blocked[c - W] && !lab[c - W]) { lab[c - W] = id; stack[top++] = c - W; }
      if (y < H - 1 && !blocked[c + W] && !lab[c + W]) { lab[c + W] = id; stack[top++] = c + W; }
    }
    regions.push({ cells, border });
  }
  return { lab, regions };
}

/** Distance in cells from every open cell to the nearest blocked cell (4-neighbour). */
function distanceToWall(blocked, W, H) {
  const d = new Int32Array(W * H).fill(-1), q = new Int32Array(W * H);
  let head = 0, tail = 0;
  for (let c = 0; c < W * H; c++) if (blocked[c]) { d[c] = 0; q[tail++] = c; }
  while (head < tail) {
    const c = q[head++], x = c % W;
    for (const n of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, c - W, c + W]) {
      if (n < 0 || n >= W * H || d[n] >= 0) continue;
      d[n] = d[c] + 1; q[tail++] = n;
    }
  }
  // Open maps with no walls at all: the map edge counts as a wall.
  for (let c = 0; c < W * H; c++) if (d[c] < 0) { const x = c % W, y = (c - x) / W; d[c] = Math.min(x, y, W - 1 - x, H - 1 - y) + 1; }
  return d;
}

function lineClear(blocked, W, x0, y0, x1, y1) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 1; i < n; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / n), y = Math.round(y0 + ((y1 - y0) * i) / n);
    if (blocked[y * W + x]) return false;
  }
  return true;
}

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const quantile = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * The grids and regions behind a profile. `R` defaults to 4 cells per square (2 for maps over 10,000 squares).
 * Returns { R, W, H, move, sight, lab, regions, rooms: Map<label, squares>, outside: Set<label>, links: [[a, b]] }.
 */
export function analyse(plan, { R } = {}) {
  R ??= plan.width * plan.height > 10000 ? 2 : 4;
  const W = Math.ceil(plan.width * R), H = Math.ceil(plan.height * R);
  const segs = segments(plan);
  const move = new Uint8Array(W * H), sight = new Uint8Array(W * H);
  for (const s of segs) {
    const door = s.kind === "door" || s.kind === "secret";
    if (s.move || door) drawSeg(move, W, H, R, s.a, s.b);
    if (s.sight || door) drawSeg(sight, W, H, R, s.a, s.b);
  }
  // Published walls often stop a hair short of each other. Grow the walls by one cell (closing gaps up to two cells,
  // half a square at R = 4) before finding regions, so a room doesn't leak through a gap nobody could walk through.
  const closed = new Uint8Array(move);
  for (let c = 0; c < W * H; c++) {
    if (!move[c]) continue;
    const x = c % W, y = (c - x) / W;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H) closed[yy * W + xx] = 1;
    }
  }
  const { lab, regions } = label(closed, W, H);
  const rooms = new Map(), outside = new Set();
  regions.forEach((r, id) => {
    if (!r) return;
    const sq = r.cells / (R * R);
    if (r.border) outside.add(id);
    else if (sq >= 2) rooms.set(id, sq);
  });
  // Doors: the region on each side of the door's middle. All outside regions are one node, 0.
  const at = (x, y) => { const cx = Math.floor(x * R), cy = Math.floor(y * R); return cx >= 0 && cy >= 0 && cx < W && cy < H ? lab[cy * W + cx] : 0; };
  const node = (id) => (outside.has(id) ? 0 : rooms.has(id) ? id : null);
  const links = [];
  for (const s of segs) {
    if (s.kind !== "door" && s.kind !== "secret") continue;
    const mx = (s.a[0] + s.b[0]) / 2, my = (s.a[1] + s.b[1]) / 2;
    const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) || 1;
    const nx = -(s.b[1] - s.a[1]) / len, ny = (s.b[0] - s.a[0]) / len;
    let a = null, b = null;
    for (const off of [0.5, 0.8, 1.2]) {
      a ??= node(at(mx + nx * off, my + ny * off)); b ??= node(at(mx - nx * off, my - ny * off));
    }
    if (a != null && b != null && a !== b) links.push([a, b]);
  }
  // A walled-in space no door reaches is solid (a pillar mass, a wall cavity), unless it is a big part of the map: a
  // cave or a hall joined only by open arches is one doorless region, and it is the floor.
  const linked = new Set(links.flat()), solid = new Map();
  const total = [...rooms.values()].reduce((s, v) => s + v, 0), biggest = Math.max(0, ...rooms.values());
  for (const [id, sq] of rooms) if (!linked.has(id) && sq !== biggest && sq < 0.2 * total) { solid.set(id, sq); rooms.delete(id); }
  return { R, W, H, move: closed, sight, lab, regions, rooms, solid, outside, links, segs };
}

export function profile(plan, opts = {}) {
  const A = analyse(plan, opts);
  const { R, W, H, move, sight, lab, rooms, outside, links, segs } = A;
  const area = plan.width * plan.height;
  let outsideSq = 0, wallCells = 0;
  for (let c = 0; c < W * H; c++) wallCells += move[c];
  for (const id of outside) outsideSq += A.regions[id].cells / (R * R);
  const roomSq = [...rooms.values()];
  const inRooms = roomSq.reduce((s, v) => s + v, 0);

  // Room graph. The outside counts as a node only when a door leads to it.
  const nodes = new Set(rooms.keys());
  if (links.some(([a, b]) => a === 0 || b === 0)) nodes.add(0);
  const parent = new Map([...nodes].map((n) => [n, n]));
  const find = (n) => { while (parent.get(n) !== n) n = parent.get(n); return n; };
  const deg = new Map([...nodes].map((n) => [n, 0]));
  for (const [a, b] of links) { parent.set(find(a), find(b)); deg.set(a, deg.get(a) + 1); deg.set(b, deg.get(b) + 1); }
  const components = new Set([...nodes].map(find)).size;
  // Buildings: rooms joined by doors, not counting the outside. The largest is what a "tavern" or "temple" brief means
  // when the map also holds a street or a yard round it.
  const bpar = new Map([...rooms.keys()].map((n) => [n, n]));
  const bfind = (n) => { while (bpar.get(n) !== n) n = bpar.get(n); return n; };
  for (const [a, b] of links) if (a !== 0 && b !== 0) bpar.set(bfind(a), bfind(b));
  const bld = new Map();
  for (const [id, sq] of rooms) { const r = bfind(id), e = bld.get(r) ?? { rooms: 0, area: 0 }; e.rooms++; e.area += sq; bld.set(r, e); }
  const buildings = [...bld.values()].sort((x, y) => y.area - x.area);
  const roomDeg = [...rooms.keys()].map((id) => deg.get(id));

  // Wall character, by length. Doors count: they are part of the wall line.
  let total = 0, axis = 0, diag = 0;
  const moving = segs.filter((s) => s.move || s.kind === "door" || s.kind === "secret");
  for (const s of moving) {
    const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], len = Math.hypot(dx, dy);
    if (!len) continue;
    const ang = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI; // 0..90
    total += len;
    if (ang < 4 || ang > 86) axis += len; else if (Math.abs(ang - 45) < 4) diag += len;
  }

  // The floor people stand on: the rooms, plus the outside when rooms are a small part of the map (a street, a camp,
  // open country). A dungeon's outside is the void round it and doesn't count.
  const useOutside = inRooms < 0.3 * (inRooms + outsideSq);
  const open = [];
  for (let c = 0; c < W * H; c++) if (!move[c] && (rooms.has(lab[c]) || (useOutside && outside.has(lab[c])))) open.push(c);
  // Openness: sample that floor on a stride, see which other samples are in sight within 12 squares.
  const stride = Math.max(1, Math.floor(open.length / 350));
  const pts = open.filter((_, i) => i % stride === 0).map((c) => [c % W, Math.floor(c / W)]);
  const rad = SIGHT_RADIUS * R, seen = [];
  let longest = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    let near = 0, vis = 0;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const [x1, y1] = pts[j], d = Math.hypot(x1 - x0, y1 - y0);
      const inRad = d <= rad;
      if (!inRad && (i % 3 !== 0 || d / R <= longest)) continue; // longest sightline from a third of the samples
      const clear = lineClear(sight, W, x0, y0, x1, y1);
      if (inRad) { near++; if (clear) vis++; }
      if (clear && d / R > longest) longest = d / R;
    }
    if (near) seen.push(vis / near);
  }

  const dist = distanceToWall(move, W, H);
  let narrow = 0, openCells = 0, widest = 0;
  for (const c of open) { openCells++; if (dist[c] <= 1.25 * R) narrow++; if (dist[c] > widest) widest = dist[c]; }

  // Footprint: where rooms and walls are, on an n x n picture of the map.
  const fr = new Float64Array(FOOT * FOOT), fw = new Float64Array(FOOT * FOOT), fc = new Float64Array(FOOT * FOOT);
  for (let c = 0; c < W * H; c++) {
    const x = c % W, y = (c - x) / W, k = Math.floor((y / H) * FOOT) * FOOT + Math.floor((x / W) * FOOT);
    fc[k]++;
    if (move[c]) fw[k]++; else if (rooms.has(lab[c])) fr[k]++;
  }
  const maxW = Math.max(1e-9, ...fw.map((v, k) => v / (fc[k] || 1)));

  // Features: see-through walls, low and terrain walls, and which rooms have a light in them.
  let windows = 0, low = 0;
  for (const s of segs) {
    const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    if (s.kind === "window") windows += len;
    else if (s.kind === "low" || s.kind === "terrain") low += len;
  }
  const lit = new Set(plan.lights.map((l) => lab[Math.min(H - 1, Math.max(0, Math.floor(l.y * R))) * W + Math.min(W - 1, Math.max(0, Math.floor(l.x * R)))]).filter((id) => rooms.has(id)));
  const bands = Object.fromEntries(ROOM_BANDS.map(([b]) => [b, 0]));
  for (const sq of roomSq) bands[band(sq)]++;
  const items = contentsFromItems(plan.items ?? []);
  const floorSq = openCells / (R * R);

  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    size: { w: r2(plan.width), h: r2(plan.height), area: Math.round(area), aspect: r2(Math.max(plan.width, plan.height) / Math.min(plan.width, plan.height)) },
    enclosure: r2(Math.min(1, inRooms / Math.max(1e-9, area - wallCells / (R * R)))),
    rooms: { count: rooms.size, median: r2(median(roomSq)), max: r2(Math.max(0, ...roomSq)), small: roomSq.filter((v) => v < 9).length, large: roomSq.filter((v) => v > 100).length, bands },
    building: { count: buildings.filter((b) => b.rooms >= 2).length, rooms: buildings[0]?.rooms ?? 0, area: Math.round(buildings[0]?.area ?? 0) },
    graph: { links: links.length, loops: Math.max(0, links.length - nodes.size + components), deadEnds: roomDeg.filter((d) => d === 1).length,
      isolated: roomDeg.filter((d) => d === 0).length, doorsOut: links.filter(([a, b]) => a === 0 || b === 0).length },
    walls: { length: Math.round(total), density: r2((100 * total) / area), squareness: r2(total ? axis / total : 0), diagonal: r2(total ? diag / total : 0),
      organic: r2(total ? 1 - (axis + diag) / total : 0), meanSegment: r2(moving.length ? total / moving.length : 0) },
    openness: { median: r2(median(seen)), p90: r2(quantile(seen, 0.9)), longest: Math.round(longest) },
    space: { narrowShare: r2(openCells ? narrow / openCells : 0), widest: r2(widest / R) },
    lights: { count: plan.lights.length, density: r2((100 * plan.lights.length) / area) },
    features: { windows: Math.round(windows), low: Math.round(low), litRooms: r2(rooms.size ? lit.size / rooms.size : 0) },
    items: { count: items.count, density: r2(floorSq ? (100 * items.count) / floorSq : 0), kinds: items.kinds },
    footprint: { n: FOOT, rooms: [...fr].map((v, k) => r2(v / (fc[k] || 1))), walls: [...fw].map((v, k) => r2(v / (fc[k] || 1) / maxW)) },
  };
}
