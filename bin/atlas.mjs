// Atlas command line (plans/atlas-plan.md).
//   bin/atlas list    --world <w>
//   bin/atlas lint    --world <w> --atlas <id>
//   bin/atlas brief   --world <w> --atlas <id> --section <id>
//   bin/atlas render  --world <w> --atlas <id> --out <file.svg|file.png> [--view gm|survey|section] [--palette ink|wash|sepia]
//                     [--insets '[{"focus":[x0,y0,x1,y1],"title":"…","corner":"tl"}]']
//                     [--focus x0,y0,x1,y1] [--width px] [--title t] [--subtitle s] [--city]
// A survey render is drawn from the survey view only (what the table knows); nothing else can reach it. Writing a
// render is local; putting it in front of players (Foundry) is a separate, confirmed step.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { listAtlases, loadAtlas, loadKnown } from "../atlas/store.mjs";
import { lintAtlas } from "../atlas/lint.mjs";
import { sectionBrief } from "../atlas/section-brief.mjs";
import { surveyView } from "../atlas/survey.mjs";
import { renderPlan, renderSection } from "../atlas/render.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const { values: o } = parseArgs({ args: rest, options: {
  world: { type: "string" }, atlas: { type: "string" }, section: { type: "string" }, out: { type: "string" },
  view: { type: "string", default: "gm" }, city: { type: "boolean", default: false }, palette: { type: "string", default: "ink" }, focus: { type: "string" },
  insets: { type: "string" },
  width: { type: "string", default: "1600" }, title: { type: "string" }, subtitle: { type: "string" },
} });
const need = (k) => { if (!o[k]) { console.error(`--${k} is required`); process.exit(2); } return o[k]; };

export async function svgToPng(svg, out) {
  const { chromium } = await import("../review-ui/node_modules/playwright/index.mjs");
  const b = await chromium.launch();
  try {
    const p = await b.newPage();
    await p.setContent(`<html><body style="margin:0">${svg}</body></html>`);
    await (await p.$("svg")).screenshot({ path: out });
  } finally { await b.close(); }
}

switch (cmd) {
  case "list": console.log(listAtlases(need("world")).join("\n")); break;
  case "lint": {
    const w = need("world"), id = need("atlas");
    const f = lintAtlas(loadAtlas(w, id), loadKnown(w, id));
    for (const x of f) console.log(`${x.severity.padEnd(5)} ${x.check.padEnd(16)} ${x.message}`);
    process.exitCode = f.some((x) => x.severity === "error") ? 1 : 0;
    break;
  }
  case "brief": console.log(JSON.stringify(sectionBrief(loadAtlas(need("world"), need("atlas")), need("section")), null, 1)); break;
  case "render": {
    const w = need("world"), id = need("atlas"), out = resolve(need("out"));
    const atlas = loadAtlas(w, id);
    const survey = o.view === "survey";
    const model = survey ? surveyView(atlas, loadKnown(w, id)) : atlas;
    const opts = { survey, palette: o.palette, width: Number(o.width), title: o.title, subtitle: o.subtitle, city: o.city,
      ...(o.focus ? { focus: o.focus.split(",").map(Number) } : {}), ...(o.insets ? { insets: JSON.parse(o.insets) } : {}) };
    const svg = o.view === "section" ? renderSection(model, opts) : renderPlan(model, opts);
    mkdirSync(dirname(out), { recursive: true });
    if (out.endsWith(".png")) await svgToPng(svg, out); else writeFileSync(out, svg);
    console.log(out);
    break;
  }
  default:
    console.error("usage: bin/atlas list|lint|brief|render --world <w> [--atlas <id>] ...");
    process.exitCode = 2;
}
