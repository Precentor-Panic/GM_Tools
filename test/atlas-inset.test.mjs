import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPlan } from "../atlas/render.mjs";

const model = {
  name: "T", frame: { centre: { x: 0, y: 0 }, bounds: [-1000, -1000, 1000, 1000] }, strata: [{ id: "S1" }],
  nodes: [
    { id: "a", name: "Pump room", kind: "lock", stratum: "S1", x: 500, y: 500, depth: 50 },
    { id: "b", name: "Gallery", kind: "gallery", stratum: "S1", x: 520, y: 505, depth: 60 },
    { id: "c", name: "The Arena", kind: "surface", stratum: "S1", x: -500, y: -500 },
  ],
  edges: [{ id: "a--b", from: "a", to: "b", kind: "gallery", route: "straight", water: "dry" }],
  areas: [{ id: "ar", name: "The Arena", kind: "arena", shape: { type: "polygon", points: [{ x: -600, y: -600 }, { x: -400, y: -600 }, { x: -400, y: -400 }, { x: -600, y: -400 }] } }],
};

test("an inset draws its places at its own scale and the main sheet drops their labels", () => {
  const svg = renderPlan(model, { insets: [{ focus: [480, 480, 540, 520], title: "The works", corner: "tl" }] });
  assert.equal(svg.match(/>Pump room</g).length, 1, "labelled once, inside the inset");
  assert.match(svg, /The works \(inset A\)/);
  assert.match(svg, /A\. The works/);
  assert.equal(svg.match(/<svg /g).length, 2, "one nested drawing");
  assert.doesNotMatch(svg, /<svg [^>]*width="[^"]*"[^>]*width=/, "no duplicate attributes on the nested svg");
});

test("an arena whose place carries the same name is labelled once", () => {
  const svg = renderPlan(model, {});
  assert.equal(svg.match(/>The Arena</g).length, 1);
});
