/**
 * Atlas renderer — a surveyor's sheet, as an SVG string. Dependency-free (browser and Node share this copy;
 * atlas/render.mjs re-exports it). Russell's pick (2026-10-30, q-style): ink, hatching, depth soundings.
 *
 *   renderPlan(model, opts)     a plan, north up. `model` is an atlas (GM sheet) or a surveyView() (players' sheet;
 *                               pass opts.survey = true). Nothing the model doesn't contain can be drawn, which is
 *                               why the players' sheet is rendered from the survey view and never from the atlas.
 *   renderSection(model, opts)  a cross-section: distance from the centre across, depth down, each band its own height.
 *
 * Passages are drawn as surveyors draw tunnels: two ink walls with the floor left paper-coloured, water hatched in
 * blue inside them. Widths are symbolic (a city-scale sheet can't show a 10 ft gallery to scale).
 *
 * opts: width (px, default 1600), focus [minX, minY, maxX, maxY] in feet, palette ("ink" | "wash" | "sepia"),
 *       title, subtitle, survey (bool), showSections (default true on GM sheets), showDrafts (default true on GM),
 *       idPrefix (scopes the drawing's ids, for several drawings on one page).
 */
import { routePoints, polar, fromPolar } from "./atlas-geometry.mjs";
import { buildCity, citySvg } from "./atlas-city.mjs";

export const PALETTES = {
  ink: { paper: "#f4ecd8", paper2: "#ebe0c6", ink: "#2b2418", faint: "#8c7d62", water: "#3f6f8f", waterFill: "#c9dbe0",
    accent: "#9a3b26", pencil: "#8a8a8a", sand: "#e4cf9c", systems: null },
  wash: { paper: "#f6efdd", paper2: "#ece2c8", ink: "#2a2419", faint: "#8f8066", water: "#3a6d8e", waterFill: "#c7dce3",
    accent: "#9a3b26", pencil: "#8a8a8a", sand: "#e8d39d",
    systems: { feed: "#3f74a8", flood: "#2e8b80", sewer: "#8a7432", body: "#a5463a", seal: "#6c5aa3", drowned: "#2d4f8f", ancient: "#3d8a52" } },
  sepia: { paper: "#efe2c4", paper2: "#e2d0a8", ink: "#3b2a17", faint: "#957a52", water: "#4c6a72", waterFill: "#cfd6c8",
    accent: "#8a2f1c", pencil: "#998a74", sand: "#dcc293", systems: null },
};

const FONT = "'IM Fell English', 'Iowan Old Style', Georgia, serif";
const FONT_SC = "'IM Fell English SC', 'IM Fell English', Georgia, serif";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const f = (n) => (Math.round(n * 10) / 10).toString();

const WIDTH_PX = { crawl: 3.2, walk: 5, cart: 7, canal: 9 };
const WATER_ALPHA = { dry: 0, ankle: 0.25, waist: 0.45, chest: 0.65, full: 0.9 };
const NODE_PX = { cistern: 9, lock: 8, chamber: 8, ancient: 8, gallery: 5, junction: 4.5, "body-road": 5, seal: 5.5, main: 5, surface: 5, belief: 7 };

function bboxOf(model) {
  if (model.frame?.bounds) return model.frame.bounds;
  const xs = model.nodes.map((n) => n.x), ys = model.nodes.map((n) => n.y);
  return [Math.min(...xs) - 300, Math.min(...ys) - 300, Math.max(...xs) + 300, Math.max(...ys) + 300];
}

function insideRect(sec, p) {
  const rot = -(sec.rotation || 0) * Math.PI / 180, dx = p.x - sec.origin.x, dy = p.y - sec.origin.y;
  const x = dx * Math.cos(rot) - dy * Math.sin(rot), y = dx * Math.sin(rot) + dy * Math.cos(rot);
  return x >= 0 && y >= 0 && x <= sec.sizeSq.w * 5 && y <= sec.sizeSq.h * 5;
}

/** A players' sheet frames what they know, padded, never smaller than `min` feet across, 4:3. */
function surveyFocus(model, min = 2600) {
  if (!model.nodes.length) return bboxOf(model);
  const xs = model.nodes.map((n) => n.x), ys = model.nodes.map((n) => n.y);
  let [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  let w = Math.max((x1 - x0) * 1.35, min), h = Math.max((y1 - y0) * 1.35, min * 0.75);
  if (w / h < 4 / 3) w = h * 4 / 3; else h = w * 3 / 4;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
}

function pathD(pts) {
  return pts.map((p, i) => `${i ? "L" : "M"}${f(p.x)} ${f(p.y)}`).join("");
}

/** Smooth a polyline with a light Chaikin pass, so bends read as dug tunnels rather than ruled lines. */
function smooth(pts, rounds = 2) {
  let out = pts;
  for (let r = 0; r < rounds && out.length > 2; r++) {
    const next = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i], b = out[i + 1];
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 }, { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

function defs(P, k) {
  const h = 6 / k, w = 0.7 / k;
  return `<defs>
  <filter id="paper" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7"/>
    <feColorMatrix values="0 0 0 0 0.45  0 0 0 0 0.38  0 0 0 0 0.25  0 0 0 0.07 0"/><feComposite in2="SourceGraphic" operator="over"/></filter>
  <pattern id="lake" width="${f(h * 2.2)}" height="${f(h * 1.4)}" patternUnits="userSpaceOnUse">
    <path d="M0 ${f(h * 0.7)} q${f(h * 0.55)} ${f(-h * 0.35)} ${f(h * 1.1)} 0 t${f(h * 1.1)} 0" fill="none" stroke="${P.water}" stroke-width="${f(w)}" opacity="0.55"/></pattern>
  <pattern id="stipple" width="${f(h * 1.6)}" height="${f(h * 1.6)}" patternUnits="userSpaceOnUse">
    <circle cx="${f(h * 0.4)}" cy="${f(h * 0.5)}" r="${f(w * 0.9)}" fill="${P.faint}" opacity="0.6"/><circle cx="${f(h * 1.2)}" cy="${f(h * 1.2)}" r="${f(w * 0.7)}" fill="${P.faint}" opacity="0.5"/></pattern>
  <pattern id="hatch" width="${f(h * 0.7)}" height="${f(h * 0.7)}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <line x1="0" y1="0" x2="0" y2="${f(h * 0.7)}" stroke="${P.ink}" stroke-width="${f(w * 0.9)}" opacity="0.55"/></pattern>
  <pattern id="waterhatch" width="${f(h * 0.6)}" height="${f(h * 0.6)}" patternUnits="userSpaceOnUse">
    <line x1="0" y1="${f(h * 0.3)}" x2="${f(h * 0.6)}" y2="${f(h * 0.3)}" stroke="${P.water}" stroke-width="${f(w)}"/></pattern>
</defs>`;
}

/** Greedy label placement: try four spots round the anchor, keep the first that doesn't hit a placed label. */
function labeller(k) {
  const placed = [];
  return function place(text, x, y, size, opts = {}) {
    const w = (text.length * size * 0.52) / k, h = (size * 1.1) / k, gap = (opts.gap ?? 7) / k;
    const spots = [[gap, -gap * 0.2, "start"], [-gap, -gap * 0.2, "end"], [0, -gap * 1.2, "middle"], [0, gap * 1.8, "middle"]];
    for (const [dx, dy, anchor] of spots) {
      const x0 = anchor === "start" ? x + dx : anchor === "end" ? x + dx - w : x + dx - w / 2;
      const box = [x0, y + dy - h * 0.8, x0 + w, y + dy + h * 0.2];
      if (placed.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
      placed.push(box);
      return { x: x + dx, y: y + dy, anchor };
    }
    return opts.force ? { x: x + spots[0][0], y: y + spots[0][1], anchor: "start" } : null;
  };
}

function areaSvg(a, P, k, survey) {
  const s = a.shape, sw = (px) => f(px / k);
  if (a.kind === "lake" && s.type === "circle")
    return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${P.waterFill}" opacity="0.55"/><circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="url(#lake)" stroke="${P.water}" stroke-width="${sw(1.2)}"/>`;
  if (a.kind === "island" && s.type === "circle")
    return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${P.paper2}" stroke="${P.ink}" stroke-width="${sw(1)}"/>`;
  if (a.kind === "wall" && s.type === "annulus")
    return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r0}" fill="none" stroke="${P.ink}" stroke-width="${sw(1.4)}"/><circle cx="${s.cx}" cy="${s.cy}" r="${s.r1}" fill="none" stroke="${P.ink}" stroke-width="${sw(2.4)}"/>`;
  if (s.type === "annulus")
    return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r1}" fill="none" stroke="${P.faint}" stroke-width="${sw(0.9)}" stroke-dasharray="${sw(1)} ${sw(4)}" stroke-linecap="round"/>`;
  if (s.type === "sector") {
    const p0 = fromPolar(s.r0, s.from, { x: s.cx, y: s.cy }), p1 = fromPolar(s.r1, s.from, { x: s.cx, y: s.cy });
    const p2 = fromPolar(s.r1, s.to, { x: s.cx, y: s.cy }), p3 = fromPolar(s.r0, s.to, { x: s.cx, y: s.cy });
    const big = ((s.to - s.from + 360) % 360) > 180 ? 1 : 0;
    return `<path d="M${f(p0.x)} ${f(p0.y)}L${f(p1.x)} ${f(p1.y)}A${s.r1} ${s.r1} 0 ${big} 1 ${f(p2.x)} ${f(p2.y)}L${f(p3.x)} ${f(p3.y)}A${s.r0} ${s.r0} 0 ${big} 0 ${f(p0.x)} ${f(p0.y)}Z" fill="url(#stipple)" stroke="${P.faint}" stroke-width="${sw(0.8)}"/>`;
  }
  if (s.type === "polygon" && (a.kind === "arena" || a.kind === "landmark"))
    return `<path d="${pathD(s.points)}Z" fill="${P.sand}" stroke="${P.ink}" stroke-width="${sw(1.1)}"/>`;
  if (s.type === "polygon" && a.kind === "gate-line")
    return `<path d="${pathD(s.points)}Z" fill="none" stroke="${P.ink}" stroke-width="${sw(1.6)}"/>`;
  if (s.type === "polygon") return `<path d="${pathD(s.points)}Z" fill="none" stroke="${P.faint}" stroke-width="${sw(0.8)}" stroke-dasharray="${sw(3)} ${sw(3)}"/>`;
  if (s.type === "circle") return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="none" stroke="${P.faint}" stroke-width="${sw(0.8)}"/>`;
  return "";
}

/** Ring names lettered along the ring, like a city plan. */
function ringLabels(areas, P, k) {
  let out = "";
  for (const a of areas) {
    const s = a.shape;
    if (!(s.type === "annulus" && a.kind === "ring")) continue;
    const r = (s.r0 + s.r1) / 2, id = `ring-${a.id}`;
    out += `<path id="${id}" d="M${s.cx - r} ${s.cy}A${r} ${r} 0 0 1 ${s.cx + r} ${s.cy}" fill="none"/>` +
      `<text font-family="${FONT_SC}" font-size="${f(15 / k)}" letter-spacing="${f(6 / k)}" fill="${P.faint}" opacity="0.9">` +
      `<textPath href="#${id}" startOffset="50%" text-anchor="middle">${esc(a.name.replace(/^The /, "").toUpperCase())}</textPath></text>`;
  }
  // Quarters (sectors) and the lake are named where they lie, upright.
  for (const a of areas) {
    const s = a.shape;
    let at = null;
    if (s.type === "sector") at = fromPolar((s.r0 + s.r1) / 2, s.from + (((s.to - s.from + 360) % 360) / 2), { x: s.cx, y: s.cy });
    else if (a.kind === "lake" && s.type === "circle") at = { x: s.cx, y: s.cy + s.r * 0.62 };
    else if ((a.kind === "arena" || a.kind === "landmark") && s.type === "polygon") {
      const cx = s.points.reduce((t, p) => t + p.x, 0) / s.points.length, cy = s.points.reduce((t, p) => t + p.y, 0) / s.points.length;
      out += `<text x="${f(cx)}" y="${f(cy)}" text-anchor="middle" dominant-baseline="middle" font-family="${FONT}" font-style="italic" font-size="${f(11 / k)}" fill="${P.ink}">${esc(a.name)}</text>`;
      continue;
    }
    if (!at) continue;
    out += `<text x="${f(at.x)}" y="${f(at.y)}" text-anchor="middle" font-family="${FONT_SC}" font-size="${f(13 / k)}" letter-spacing="${f(4 / k)}" fill="${P.faint}">${esc(a.name.replace(/^The /, "").toUpperCase())}</text>`;
  }
  return out;
}

function gateSvg(g, mid, ang, P, k) {
  const L = 7 / k, sw = f(1.4 / k);
  const c = Math.cos(ang + Math.PI / 2), s = Math.sin(ang + Math.PI / 2);
  const bar = (o) => `<line x1="${f(mid.x - c * L + Math.cos(ang) * o)}" y1="${f(mid.y - s * L + Math.sin(ang) * o)}" x2="${f(mid.x + c * L + Math.cos(ang) * o)}" y2="${f(mid.y + s * L + Math.sin(ang) * o)}" stroke="${P.ink}" stroke-width="${sw}"/>`;
  if (g.kind === "seal") return `<circle cx="${f(mid.x)}" cy="${f(mid.y)}" r="${f(4.5 / k)}" fill="${P.accent}" stroke="${P.ink}" stroke-width="${f(0.8 / k)}"/>` + bar(0);
  if (g.kind === "sluice") return bar(-2 / k) + bar(2 / k);
  return bar(0) + (g.state === "locked" ? `<circle cx="${f(mid.x)}" cy="${f(mid.y)}" r="${f(1.8 / k)}" fill="${P.ink}"/>` : "");
}

function midOf(pts) {
  let total = 0;
  const seg = [];
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); seg.push(d); total += d; }
  let half = total / 2;
  for (let i = 0; i < seg.length; i++) {
    if (half <= seg[i]) {
      const t = seg[i] ? half / seg[i] : 0, a = pts[i], b = pts[i + 1];
      return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, ang: Math.atan2(b.y - a.y, b.x - a.x) };
    }
    half -= seg[i];
  }
  return { p: pts[0], ang: 0 };
}

export function renderPlan(model, opts = {}) {
  const P = PALETTES[opts.palette || "ink"];
  const survey = !!opts.survey;
  const showDrafts = opts.showDrafts ?? !survey;
  const box = opts.focus || (survey ? surveyFocus(model) : bboxOf(model));
  const W = opts.width || 1600;
  const bw = box[2] - box[0], bh = box[3] - box[1];
  const k = W / bw;                                    // px per foot
  const H = Math.round(bh * k);
  const centre = model.frame?.centre || { x: 0, y: 0 };
  const strataIdx = Object.fromEntries((model.strata || []).map((s, i) => [s.id, i]));
  const nodes = model.nodes.filter((n) => showDrafts || !n.draft);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const edges = model.edges.filter((e) => byId[e.from] && byId[e.to] && (showDrafts || !e.draft));
  const place = labeller(k);
  const sw = (px) => f(px / k);
  // Sections (GM) or groups (survey) too small to read at this scale draw as one labelled footprint; their places
  // keep their dots but lose their own labels and soundings.
  const groups = (survey ? model.groups : model.sections) || [];
  const collapsed = groups.filter((g) => Math.max(g.sizeSq.w, g.sizeSq.h) * 5 * k < (opts.collapseBelowPx ?? 60));
  const quiet = new Set();
  for (const g of collapsed) for (const n of nodes) if (insideRect(g, n) && !(n.belief || n.partyOnly)) quiet.add(n.id);
  // Places on (nearly) the same spot form a stack: one label, the shallowest place's name.
  const stackOf = {};
  const stacks = [];
  for (const n of [...nodes].sort((x, y) => (x.depth ?? 0) - (y.depth ?? 0))) {
    const belief = !!(n.belief || n.partyOnly);
    const hit = stacks.find((st) => st.belief === belief && Math.hypot(st.x - n.x, st.y - n.y) * k < 7);
    if (hit) { hit.members.push(n); stackOf[n.id] = hit; } else { const st = { x: n.x, y: n.y, belief, members: [n] }; stacks.push(st); stackOf[n.id] = st; }
  }
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box[0]} ${box[1]} ${bw} ${bh}" width="${W}" height="${H}" role="img" aria-label="${esc(model.name)}">`;
  svg += defs(P, k);
  svg += `<rect x="${box[0]}" y="${box[1]}" width="${bw}" height="${bh}" fill="${P.paper}"/><rect x="${box[0]}" y="${box[1]}" width="${bw}" height="${bh}" fill="${P.paper}" filter="url(#paper)"/>`;

  // The city above: areas, then the ring names.
  // Under-the-lines order: plain areas, then the city's houses (opts.city), then arenas and gate lines on top.
  const onTop = (a) => a.kind === "arena" || a.kind === "landmark" || a.kind === "gate-line";
  const areasShown = (model.areas || []).filter((a) => showDrafts || !a.draft);
  svg += `<g class="areas">${areasShown.filter((a) => !onTop(a)).map((a) => areaSvg(a, P, k, survey)).join("")}</g>`;
  if (opts.city && model.city) svg += citySvg(buildCity(model, { focus: opts.focus }), P, k);
  svg += `<g class="areas-top">${areasShown.filter(onTop).map((a) => areaSvg(a, P, k, survey)).join("")}</g>`;
  svg += `<g class="ring-names">${ringLabels(areasShown, P, k)}</g>`;

  // Sections (GM only): the sheets that exist as battle maps.
  if ((survey || (opts.showSections ?? true)) && groups.length) {
    for (const s of groups) {
      const small = collapsed.includes(s);
      const w = s.sizeSq.w * 5, h = s.sizeSq.h * 5;
      const col = survey ? P.ink : P.accent;
      const minPx = small ? Math.max(14 / k, 0) : 0;
      const cx = s.origin.x + w / 2, cy = s.origin.y + h / 2, dw = Math.max(w, minPx), dh = Math.max(h, minPx);
      svg += `<g class="section" data-id="${esc(s.id)}"><rect x="${f(cx - dw / 2)}" y="${f(cy - dh / 2)}" width="${f(dw)}" height="${f(dh)}" fill="${small ? "url(#hatch)" : "none"}" stroke="${col}" stroke-width="${sw(small ? 1.4 : 1)}"${small ? "" : ` stroke-dasharray="${sw(4)} ${sw(3)}"`} transform="rotate(${s.rotation || 0} ${f(cx)} ${f(cy)})"/></g>`;
      const label = survey ? s.name : `Sheet: ${s.name}`;
      const at = place(label, cx, cy, small ? (survey ? 13 : 11.5) : 11, { force: small, gap: small ? dw * k / 2 + 6 : 7 });
      if (at) svg += `<text x="${f(at.x)}" y="${f(at.y)}" text-anchor="${at.anchor}" font-family="${FONT}" font-style="italic" font-size="${sw(small ? (survey ? 13 : 11.5) : 11)}" fill="${col}">${esc(label)}</text>`;
    }
  }

  // Passages, deepest first so shallower ones cross over them.
  const routed = edges.map((e) => {
    const a = byId[e.from], b = byId[e.to];
    const pts = e.kind === "shaft" ? [a, b] : smooth(routePoints(e, a, b, centre));
    const band = Math.max(strataIdx[a.stratum] ?? 0, strataIdx[b.stratum] ?? 0);
    return { e, a, b, pts, band };
  }).sort((x, y) => y.band - x.band);
  let walls = "", floors = "", water = "", centres = "", marks = "";
  for (const { e, a, b, pts, band } of routed) {
    const d = pathD(pts);
    const heard = survey && e.level === "heard";
    const draft = e.draft;
    const vertical = e.kind === "shaft" || e.kind === "stair" || e.kind === "riser";
    if (vertical && Math.hypot(a.x - b.x, a.y - b.y) < 8 / k) continue;  // a shaft straight up: drawn on its node
    const wpx = WIDTH_PX[e.width] ?? WIDTH_PX.walk;
    const deep = band >= 4, drowned = e.water === "full" || band === 3;
    const wallCol = draft ? P.pencil : P.ink;
    const dash = heard ? ` stroke-dasharray="${sw(2)} ${sw(4)}"` : draft ? ` stroke-dasharray="${sw(5)} ${sw(3)}"` : deep ? ` stroke-dasharray="${sw(9)} ${sw(3)}"` : "";
    if (e.kind === "pipe" || e.kind === "riser") {
      walls += `<path d="${d}" fill="none" stroke="${wallCol}" stroke-width="${sw(2)}"${dash} stroke-linecap="round"/>`;
      continue;
    }
    walls += `<path d="${d}" fill="none" stroke="${wallCol}" stroke-width="${sw(wpx + 2.2)}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`;
    floors += `<path d="${d}" fill="none" stroke="${P.paper}" stroke-width="${sw(wpx)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    const wa = heard ? 0 : (WATER_ALPHA[e.water] ?? 0) + (drowned && e.water !== "full" ? 0.2 : 0);
    if (wa > 0) water += `<path d="${d}" fill="none" stroke="url(#waterhatch)" stroke-width="${sw(wpx)}" opacity="${f(Math.min(1, wa))}" stroke-linecap="round"/>` +
      `<path d="${d}" fill="none" stroke="${P.waterFill}" stroke-width="${sw(wpx)}" opacity="${f(Math.min(0.7, wa * 0.6))}" stroke-linecap="round"/>`;
    const sysCol = !survey && P.systems && P.systems[e.systems?.[0]];
    if (sysCol) centres += `<path d="${d}" fill="none" stroke="${sysCol}" stroke-width="${sw(1.6)}" opacity="0.85" stroke-linecap="round"/>`;
    if (e.gate) { const m = midOf(pts); marks += gateSvg(e.gate, m.p, m.ang, P, k); }
    if (e.kind === "breach" || e.kind === "stair") {
      const m = midOf(pts);
      marks += e.kind === "stair"
        ? [-2, 0, 2].map((o) => `<path d="M${f(m.p.x + Math.cos(m.ang) * o / k - Math.sin(m.ang) * 3 / k)} ${f(m.p.y + Math.sin(m.ang) * o / k + Math.cos(m.ang) * 3 / k)}l${f(Math.sin(m.ang) * 6 / k)} ${f(-Math.cos(m.ang) * 6 / k)}" stroke="${P.ink}" stroke-width="${sw(0.8)}"/>`).join("")
        : `<path d="M${f(m.p.x - 4 / k)} ${f(m.p.y - 3 / k)}l${f(3 / k)} ${f(2 / k)} ${f(-1 / k)} ${f(2 / k)} ${f(3 / k)} ${f(2 / k)}" fill="none" stroke="${P.ink}" stroke-width="${sw(0.9)}"/>`;
    }
  }
  svg += `<g class="passages">${walls}${floors}${water}${centres}${marks}</g>`;

  // Places: chambers with wall hatching, shafts as the surveyor's boxed X, beliefs in dashed ink with a query.
  let chambers = "", labels = "", soundings = "";
  const ordered = [...nodes].sort((x, y) => (strataIdx[y.stratum] ?? 0) - (strataIdx[x.stratum] ?? 0));
  for (const n of ordered) {
    const heard = survey && n.level === "heard";
    const belief = n.belief || n.partyOnly;
    const r = (NODE_PX[n.kind] ?? 5.5) / k;
    const col = n.draft ? P.pencil : P.ink;
    const surface = n.kind === "surface" || (strataIdx[n.stratum] ?? 1) === 0;
    let shape = "";
    if (n.shape && n.shape.type === "circle" && n.shape.r * k > 6) shape = `<circle cx="${n.x}" cy="${n.y}" r="${n.shape.r}"`;
    else if (n.shape && n.shape.type === "rect" && n.shape.w * k > 8) shape = `<rect x="${f(n.x - n.shape.w / 2)}" y="${f(n.y - n.shape.h / 2)}" width="${n.shape.w}" height="${n.shape.h}" transform="rotate(${n.shape.rot || 0} ${n.x} ${n.y})"`;
    if (belief) {
      chambers += `<circle cx="${n.x}" cy="${n.y}" r="${f(r * 1.6)}" fill="none" stroke="${P.accent}" stroke-width="${sw(1.2)}" stroke-dasharray="${sw(3)} ${sw(3)}"/>` +
        `<text x="${n.x}" y="${f(n.y + 4 / k)}" text-anchor="middle" font-family="${FONT}" font-size="${sw(12)}" fill="${P.accent}">?</text>`;
    } else if (heard) {
      chambers += `<circle cx="${n.x}" cy="${n.y}" r="${f(r * 1.4)}" fill="none" stroke="${P.ink}" stroke-width="${sw(1)}" stroke-dasharray="${sw(1.5)} ${sw(3)}"/>`;
    } else if (surface) {
      chambers += `<circle cx="${n.x}" cy="${n.y}" r="${f(r * 0.8)}" fill="${P.paper}" stroke="${col}" stroke-width="${sw(1.3)}"/><circle cx="${n.x}" cy="${n.y}" r="${f(r * 0.25)}" fill="${col}"/>`;
    } else if (n.kind === "seal") {
      chambers += `<rect x="${f(n.x - r)}" y="${f(n.y - r)}" width="${f(r * 2)}" height="${f(r * 2)}" fill="${P.accent}" stroke="${col}" stroke-width="${sw(1)}" transform="rotate(45 ${n.x} ${n.y})"/>`;
    } else {
      const outline = shape ? `${shape} fill="${P.paper}" stroke="${col}" stroke-width="${sw(1.4)}"/>` : `<circle cx="${n.x}" cy="${n.y}" r="${f(r)}" fill="${P.paper}" stroke="${col}" stroke-width="${sw(1.4)}"/>`;
      const poche = shape ? "" : `<circle cx="${n.x}" cy="${n.y}" r="${f(r + 2.2 / k)}" fill="none" stroke="url(#hatch)" stroke-width="${sw(3.5)}"/>`;
      const wet = n.kind === "cistern" || (strataIdx[n.stratum] ?? 0) === 3 ? `<circle cx="${n.x}" cy="${n.y}" r="${f(r * 0.72)}" fill="url(#waterhatch)" opacity="0.8"/>` : "";
      const ancient = (strataIdx[n.stratum] ?? 0) >= 4 ? `<circle cx="${n.x}" cy="${n.y}" r="${f(r * 0.35)}" fill="${col}"/>` : "";
      chambers += poche + outline + wet + ancient;
    }
    const hasShaft = edges.some((e) => (e.kind === "shaft") && (e.from === n.id || e.to === n.id) && Math.hypot(byId[e.from].x - byId[e.to].x, byId[e.from].y - byId[e.to].y) < 8 / k);
    if (hasShaft && !surface && !heard) {
      const s2 = r * 0.55;
      chambers += `<rect x="${f(n.x - s2)}" y="${f(n.y - s2)}" width="${f(s2 * 2)}" height="${f(s2 * 2)}" fill="none" stroke="${col}" stroke-width="${sw(0.9)}"/>` +
        `<path d="M${f(n.x - s2)} ${f(n.y - s2)}L${f(n.x + s2)} ${f(n.y + s2)}M${f(n.x + s2)} ${f(n.y - s2)}L${f(n.x - s2)} ${f(n.y + s2)}" stroke="${col}" stroke-width="${sw(0.8)}"/>`;
    }
    const stack = stackOf[n.id];
    if (quiet.has(n.id) || stack.members[0] !== n) continue;
    const below = stack.members.length - 1;
    const name = (n.name || n.id) + (!survey && below ? ` (+${below} below)` : "");
    const big = surface || n.kind === "cistern" || n.kind === "lock";
    const size = survey ? (big ? 14 : 12.5) : (big ? 12.5 : 10.5);
    const at = place(heard || belief ? `${name}?` : name, n.x, n.y, size, { force: survey || surface });
    if (at) {
      const style = belief || heard ? ` font-style="italic"` : "";
      const fill = belief ? P.accent : n.draft ? P.pencil : P.ink;
      labels += `<text x="${f(at.x)}" y="${f(at.y)}" text-anchor="${at.anchor}" font-family="${surface ? FONT_SC : FONT}" font-size="${sw(size)}" fill="${fill}"${style}>${esc(name)}${heard || belief ? "?" : ""}</text>`;
    }
    const depth = survey ? n.depth : n.depth;
    if (depth != null && depth > 0 && !belief) {
      const sat = place(String(depth), n.x, n.y + 1 / k, 8.5, { gap: 5 });
      if (sat) soundings += `<text x="${f(sat.x)}" y="${f(sat.y)}" text-anchor="${sat.anchor}" font-family="${FONT}" font-style="italic" font-size="${sw(8.5)}" fill="${P.water}">${depth}</text>`;
    }
  }
  svg += `<g class="places">${chambers}</g><g class="soundings">${soundings}</g><g class="labels">${labels}</g>`;

  svg += furniture(model, opts, P, k, box, survey);
  return scopeIds(svg + "</svg>", opts.idPrefix);
}

/** Give every id in one drawing a prefix, so several drawings can share a page without borrowing each other's
 *  patterns. */
function scopeIds(svg, prefix) {
  if (!prefix) return svg;
  return svg.replace(/ id="([^"]+)"/g, ` id="${prefix}-$1"`).replace(/url\(#([^)]+)\)/g, `url(#${prefix}-$1)`).replace(/href="#([^"]+)"/g, `href="#${prefix}-$1"`);
}

/** Border, north arrow, scale bar, legend and the title cartouche. */
function furniture(model, opts, P, k, box, survey) {
  const [x0, y0, x1, y1] = box, sw = (px) => f(px / k), m = 18 / k;
  let s = `<rect x="${f(x0 + m)}" y="${f(y0 + m)}" width="${f(x1 - x0 - 2 * m)}" height="${f(y1 - y0 - 2 * m)}" fill="none" stroke="${P.ink}" stroke-width="${sw(2)}"/>` +
    `<rect x="${f(x0 + m + 5 / k)}" y="${f(y0 + m + 5 / k)}" width="${f(x1 - x0 - 2 * m - 10 / k)}" height="${f(y1 - y0 - 2 * m - 10 / k)}" fill="none" stroke="${P.ink}" stroke-width="${sw(0.7)}"/>`;
  // North arrow, top right.
  const nx = x1 - 70 / k, ny = y0 + 80 / k, L = 34 / k;
  s += `<g class="north"><path d="M${f(nx)} ${f(ny - L)}L${f(nx + 9 / k)} ${f(ny + L * 0.4)}L${f(nx)} ${f(ny + L * 0.15)}Z" fill="${P.ink}"/><path d="M${f(nx)} ${f(ny - L)}L${f(nx - 9 / k)} ${f(ny + L * 0.4)}L${f(nx)} ${f(ny + L * 0.15)}Z" fill="${P.paper}" stroke="${P.ink}" stroke-width="${sw(0.8)}"/>` +
    `<text x="${f(nx)}" y="${f(ny - L - 6 / k)}" text-anchor="middle" font-family="${FONT_SC}" font-size="${sw(14)}" fill="${P.ink}">N</text></g>`;
  // Scale bar, bottom left: a round number of feet near 1/6 of the sheet.
  const target = (x1 - x0) / 6, mag = 10 ** Math.floor(Math.log10(target)), step = [1, 2, 2.5, 5, 10].map((v) => v * mag).find((v) => v >= target * 0.6) || mag;
  const bx = x0 + 50 / k, by = y1 - 52 / k, seg = step / 4;
  s += `<g class="scale">`;
  for (let i = 0; i < 4; i++) s += `<rect x="${f(bx + i * seg)}" y="${f(by)}" width="${f(seg)}" height="${sw(6)}" fill="${i % 2 ? P.paper : P.ink}" stroke="${P.ink}" stroke-width="${sw(0.8)}"/>`;
  s += `<text x="${f(bx)}" y="${f(by - 6 / k)}" font-family="${FONT}" font-size="${sw(11)}" fill="${P.ink}">0</text>` +
    `<text x="${f(bx + step)}" y="${f(by - 6 / k)}" text-anchor="middle" font-family="${FONT}" font-size="${sw(11)}" fill="${P.ink}">${step.toLocaleString("en-GB")} feet</text></g>`;
  // Title cartouche, bottom right.
  const title = opts.title || model.name, sub = opts.subtitle || (survey ? "As surveyed" : "GM survey sheet");
  const cw = Math.max(title.length * 13, sub.length * 7.5, 220) / k, ch = 64 / k, cx = x1 - m - 16 / k - cw, cy = y1 - m - 16 / k - ch;
  s += `<g class="cartouche"><rect x="${f(cx)}" y="${f(cy)}" width="${f(cw)}" height="${f(ch)}" fill="${P.paper}" stroke="${P.ink}" stroke-width="${sw(1.4)}"/>` +
    `<rect x="${f(cx + 4 / k)}" y="${f(cy + 4 / k)}" width="${f(cw - 8 / k)}" height="${f(ch - 8 / k)}" fill="none" stroke="${P.ink}" stroke-width="${sw(0.6)}"/>` +
    `<text x="${f(cx + cw / 2)}" y="${f(cy + 30 / k)}" text-anchor="middle" font-family="${FONT_SC}" font-size="${sw(22)}" fill="${P.ink}">${esc(title)}</text>` +
    `<text x="${f(cx + cw / 2)}" y="${f(cy + 50 / k)}" text-anchor="middle" font-family="${FONT}" font-style="italic" font-size="${sw(12)}" fill="${P.faint}">${esc(sub)}</text></g>`;
  // Legend, bottom left above the scale.
  const items = survey
    ? [["walked", "Walked"], ["seen", "Seen"], ["heard", "Heard of"], ["belief", "Believed"]]
    : [["gallery", "Gallery"], ["water", "Water (hatched)"], ["shaft", "Shaft"], ["seal", "Seal"], ["sluice", "Sluice"], ["draft", "Draft (pencil)"]];
  const lx = x0 + 50 / k, ly = by - 40 / k - items.length * 17 / k;
  s += `<g class="legend">`;
  items.forEach(([key, label], i) => {
    const y = ly + i * 17 / k, a = lx, b = lx + 34 / k;
    let sym = "";
    if (key === "gallery" || key === "walked") sym = `<path d="M${f(a)} ${f(y)}H${f(b)}" stroke="${P.ink}" stroke-width="${sw(7)}"/><path d="M${f(a)} ${f(y)}H${f(b)}" stroke="${P.paper}" stroke-width="${sw(5)}"/>`;
    if (key === "water") sym = `<path d="M${f(a)} ${f(y)}H${f(b)}" stroke="${P.ink}" stroke-width="${sw(7)}"/><path d="M${f(a)} ${f(y)}H${f(b)}" stroke="${P.waterFill}" stroke-width="${sw(5)}"/><path d="M${f(a)} ${f(y)}H${f(b)}" stroke="url(#waterhatch)" stroke-width="${sw(5)}"/>`;
    if (key === "seen") sym = `<path d="M${f(a)} ${f(y)}H${f(b)}" stroke="${P.ink}" stroke-width="${sw(7)}"/><path d="M${f(a)} ${f(y)}H${f(b)}" stroke="${P.paper}" stroke-width="${sw(5)}"/><circle cx="${f((a + b) / 2)}" cy="${f(y)}" r="${sw(4)}" fill="${P.paper}" stroke="${P.ink}" stroke-width="${sw(1)}"/>`;
    if (key === "heard") sym = `<path d="M${f(a)} ${f(y)}H${f(b)}" stroke="${P.ink}" stroke-width="${sw(1.2)}" stroke-dasharray="${sw(2)} ${sw(4)}"/>`;
    if (key === "belief") sym = `<circle cx="${f((a + b) / 2)}" cy="${f(y)}" r="${sw(6)}" fill="none" stroke="${P.accent}" stroke-width="${sw(1.2)}" stroke-dasharray="${sw(3)} ${sw(3)}"/>`;
    if (key === "shaft") { const c = (a + b) / 2, r = 5 / k; sym = `<rect x="${f(c - r)}" y="${f(y - r)}" width="${f(2 * r)}" height="${f(2 * r)}" fill="none" stroke="${P.ink}" stroke-width="${sw(0.9)}"/><path d="M${f(c - r)} ${f(y - r)}L${f(c + r)} ${f(y + r)}M${f(c + r)} ${f(y - r)}L${f(c - r)} ${f(y + r)}" stroke="${P.ink}" stroke-width="${sw(0.8)}"/>`; }
    if (key === "seal") sym = `<rect x="${f((a + b) / 2 - 4 / k)}" y="${f(y - 4 / k)}" width="${sw(8)}" height="${sw(8)}" fill="${P.accent}" stroke="${P.ink}" stroke-width="${sw(0.8)}" transform="rotate(45 ${f((a + b) / 2)} ${f(y)})"/>`;
    if (key === "sluice") sym = `<path d="M${f(a)} ${f(y)}H${f(b)}" stroke="${P.ink}" stroke-width="${sw(7)}"/><path d="M${f(a)} ${f(y)}H${f(b)}" stroke="${P.paper}" stroke-width="${sw(5)}"/><path d="M${f((a + b) / 2 - 2 / k)} ${f(y - 7 / k)}v${sw(14)}M${f((a + b) / 2 + 2 / k)} ${f(y - 7 / k)}v${sw(14)}" stroke="${P.ink}" stroke-width="${sw(1.4)}"/>`;
    if (key === "draft") sym = `<path d="M${f(a)} ${f(y)}H${f(b)}" stroke="${P.pencil}" stroke-width="${sw(7)}" stroke-dasharray="${sw(5)} ${sw(3)}"/><path d="M${f(a)} ${f(y)}H${f(b)}" stroke="${P.paper}" stroke-width="${sw(5)}"/>`;
    s += sym + `<text x="${f(b + 8 / k)}" y="${f(y + 4 / k)}" font-family="${FONT}" font-size="${sw(11.5)}" fill="${P.ink}">${esc(label)}</text>`;
  });
  return s + `</g>`;
}

/**
 * Cross-section: distance from the centre across (every bearing folded onto one slice), depth down, each depth band
 * given equal height. Bands are lettered with their names and depths.
 */
export function renderSection(model, opts = {}) {
  const P = PALETTES[opts.palette || "ink"];
  const survey = !!opts.survey;
  const W = opts.width || 1600, bandH = opts.bandHeight || 70, top = 46, left = 150;
  const strata = model.strata.filter((s) => s.bottom > s.top);
  const H = top + strata.length * bandH + 30;
  const rMax = opts.rMax || Math.max(...model.nodes.map((n) => Math.hypot(n.x, n.y))) * 1.06;
  const X = (r) => left + (r / rMax) * (W - left - 20);
  const Y = (n) => {
    const i = strata.findIndex((s) => s.id === n.stratum);
    if (i < 0) return top - 6;
    const s = strata[i];
    return top + i * bandH + 6 + ((Math.min(Math.max(n.depth, s.top), s.bottom) - s.top) / (s.bottom - s.top)) * (bandH - 12);
  };
  const nodes = model.nodes.filter((n) => survey || opts.showDrafts !== false || !n.draft);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(model.name)} cross-section">`;
  s += `<defs><pattern id="xs-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="${P.faint}" stroke-width="0.6" opacity="0.6"/></pattern></defs>`;
  s += `<rect width="${W}" height="${H}" fill="${P.paper}"/>`;
  strata.forEach((b, i) => {
    const y = top + i * bandH;
    s += `<rect x="${left}" y="${y}" width="${W - left - 20}" height="${bandH}" fill="${i % 2 ? P.paper2 : P.paper}" stroke="${P.faint}" stroke-width="0.6"/>` +
      (i >= 3 ? `<rect x="${left}" y="${y}" width="${W - left - 20}" height="${bandH}" fill="url(#xs-hatch)"/>` : "") +
      `<text x="10" y="${y + 22}" font-family="${FONT_SC}" font-size="13" fill="${P.ink}">${esc(b.name.replace(/^The /, ""))}</text>` +
      `<text x="10" y="${y + 38}" font-family="${FONT}" font-style="italic" font-size="11" fill="${P.faint}">${b.top}–${b.bottom} ft</text>`;
  });
  // Ground line with the rings marked on it.
  s += `<path d="M${left} ${top}H${W - 20}" stroke="${P.ink}" stroke-width="2"/>`;
  for (const a of model.areas || []) {
    if (a.shape.type !== "annulus" && a.shape.type !== "circle") continue;
    const r1 = a.shape.r1 ?? a.shape.r;
    if (r1 > rMax) continue;
    s += `<path d="M${f(X(r1))} ${top - 6}V${top + 4}" stroke="${P.ink}" stroke-width="1"/>`;
    if (a.kind === "ring" || a.kind === "lake") s += `<text x="${f(X(((a.shape.r0 ?? 0) + r1) / 2))}" y="${top - 12}" text-anchor="middle" font-family="${FONT_SC}" font-size="11" fill="${P.faint}">${esc(a.name.replace(/^The /, ""))}</text>`;
  }
  for (const e of model.edges) {
    const a = byId[e.from], b = byId[e.to];
    if (!a || !b) continue;
    const pa = { x: X(Math.hypot(a.x, a.y)), y: Y(a) }, pb = { x: X(Math.hypot(b.x, b.y)), y: Y(b) };
    const water = (WATER_ALPHA[e.water] ?? 0) > 0.5;
    s += `<path d="M${f(pa.x)} ${f(pa.y)}L${f(pb.x)} ${f(pb.y)}" stroke="${e.draft ? P.pencil : water ? P.water : P.ink}" stroke-width="${water ? 2 : 1.4}"${e.draft || e.level === "heard" ? ` stroke-dasharray="4 3"` : ""}/>`;
  }
  for (const n of nodes) {
    if ((n.stratum === "S0" || !strata.some((x) => x.id === n.stratum)) && n.kind === "surface") continue;
    const x = X(Math.hypot(n.x, n.y)), y = Y(n);
    s += `<circle cx="${f(x)}" cy="${f(y)}" r="3.6" fill="${n.belief || n.partyOnly ? "none" : P.paper}" stroke="${n.belief || n.partyOnly ? P.accent : n.draft ? P.pencil : P.ink}" stroke-width="1.3"/>`;
  }
  return scopeIds(s + "</svg>", opts.idPrefix);
}
