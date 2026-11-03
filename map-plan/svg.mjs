// A light preview of a plan as SVG, with no renderer and no art: rooms tinted one colour each, the outside dark,
// walls drawn by what they stop, doors in amber, lights as dots. Good enough to see a map's shape and character.
import { analyse } from "./profile.mjs";

const HUES = [32, 200, 140, 280, 10, 90, 240, 330, 170, 55];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function planSvg(plan, { px = 12, analysis, title } = {}) {
  const A = analysis ?? analyse(plan);
  const { R, W, H, lab, rooms } = A;
  const w = Math.round(plan.width * px), h = Math.round(plan.height * px);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`];
  if (title) out.push(`<title>${esc(title)}</title>`);
  out.push(`<rect width="${w}" height="${h}" fill="#24211d"/>`);
  // Rooms: one rect per run of cells in a row with the same room, so a big map stays a small file.
  const ids = [...rooms.keys()], hue = new Map(ids.map((id, i) => [id, HUES[i % HUES.length]]));
  const s = px / R;
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      const id = lab[y * W + x];
      let e = x + 1;
      while (e < W && lab[y * W + e] === id) e++;
      if (rooms.has(id)) out.push(`<rect x="${(x * s).toFixed(1)}" y="${(y * s).toFixed(1)}" width="${((e - x) * s).toFixed(1)}" height="${s.toFixed(1)}" fill="hsl(${hue.get(id)} 32% 72%)"/>`);
      x = e;
    }
  }
  // Grid every square, faint.
  out.push(`<g stroke="#000" stroke-opacity=".12" stroke-width="1">`);
  for (let x = 1; x < plan.width; x++) out.push(`<line x1="${x * px}" y1="0" x2="${x * px}" y2="${h}"/>`);
  for (let y = 1; y < plan.height; y++) out.push(`<line x1="0" y1="${y * px}" x2="${w}" y2="${y * px}"/>`);
  out.push(`</g>`);
  const line = (sg, stroke, width, dash = "") => `<line x1="${(sg.a[0] * px).toFixed(1)}" y1="${(sg.a[1] * px).toFixed(1)}" x2="${(sg.b[0] * px).toFixed(1)}" y2="${(sg.b[1] * px).toFixed(1)}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
  for (const sg of A.segs) {
    if (sg.kind === "door") out.push(line(sg, "#e0a040", 4));
    else if (sg.kind === "secret") out.push(line(sg, "#c070e0", 4, "4 3"));
    else if (sg.move && sg.sight) out.push(line(sg, "#15130f", 3));
    else if (sg.move) out.push(line(sg, "#5a8fb0", 2));          // window: stops feet, not eyes
    else if (sg.sight) out.push(line(sg, "#6b6458", 2, "2 3"));   // stops eyes, not feet
    else out.push(line(sg, "#8a8170", 1.5, "1 3"));               // low wall, terrain
  }
  for (const l of plan.lights) out.push(`<circle cx="${(l.x * px).toFixed(1)}" cy="${(l.y * px).toFixed(1)}" r="${Math.max(2, px / 4)}" fill="#ffd27a" stroke="#6b4a10"/>`);
  out.push(`</svg>`);
  return out.join("");
}
