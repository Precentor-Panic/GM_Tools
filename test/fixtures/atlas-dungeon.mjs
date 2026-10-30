// A small made-up dungeon for atlas tests: a ruined mill above, a cellar, an old drain, a flooded cistern below,
// and one sealed vault. Campaign-free on purpose (GM_Tools stays generic).
export function millAtlas() {
  return {
    id: "old-mill", name: "Under the Old Mill",
    frame: { north: 0, bounds: [-400, -400, 400, 400], centre: { x: 0, y: 0 } },
    areas: [
      { id: "millyard", name: "Millyard", kind: "district", shape: { type: "circle", cx: 0, cy: 0, r: 150 } },
      { id: "village", name: "Village", kind: "ring", shape: { type: "annulus", cx: 0, cy: 0, r0: 150, r1: 380 } },
    ],
    strata: [
      { id: "S0", name: "Street", top: 0, bottom: 0 },
      { id: "S1", name: "Cellars", top: 0, bottom: 20 },
      { id: "S2", name: "Drains", top: 20, bottom: 60 },
      { id: "S3", name: "Cistern", top: 60, bottom: 120 },
    ],
    systems: [
      { id: "drain", name: "Drains", who: "the miller" },
      { id: "smuggle", name: "Smugglers' way", who: "the Gullet gang" },
    ],
    nodes: [
      { id: "mill", name: "The mill", kind: "surface", stratum: "S0", x: 0, y: 0, depth: 0 },
      { id: "cellar", name: "Mill cellar", kind: "chamber", stratum: "S1", x: 10, y: 5, depth: 12, systems: ["drain"],
        shape: { type: "rect", w: 40, h: 25, rot: 0 }, tells: ["flour dust on the steps"] },
      { id: "drain-head", name: "Drain head", kind: "junction", stratum: "S2", x: 60, y: 40, depth: 30, systems: ["drain"],
        tells: ["water runs away to the south-east"] },
      { id: "outfall", name: "Outfall by the river", kind: "outfall", stratum: "S2", x: 200, y: 200, depth: 25, systems: ["drain"] },
      { id: "cistern", name: "The old cistern", kind: "chamber", stratum: "S3", x: -120, y: 90, depth: 90, systems: ["drain", "smuggle"],
        shape: { type: "circle", r: 30 }, note: "The Gullet keep their boat here." },
      { id: "vault", name: "Sealed vault", kind: "seal", stratum: "S3", x: -200, y: 160, depth: 110, systems: ["smuggle"],
        note: "GM only: the miller's father's hoard." },
      { id: "rumour-vault", name: "Treasure under the well (rumour)", kind: "belief", stratum: "S3", x: 20, y: -30, depth: 100,
        partyOnly: true, standsFor: "vault" },
    ],
    edges: [
      { id: "cellar-shaft", from: "mill", to: "cellar", kind: "stair", route: "straight" },
      { id: "cellar-drain", from: "cellar", to: "drain-head", kind: "crawl", systems: ["drain"], width: "crawl", flow: "forward" },
      { id: "drain-main", from: "drain-head", to: "outfall", kind: "gallery", systems: ["drain"], water: "ankle", flow: "forward",
        route: "path", path: [{ x: 120, y: 60 }, { x: 160, y: 150 }], tells: ["the smell of the river"] },
      { id: "drain-cistern", from: "drain-head", to: "cistern", kind: "shaft", systems: ["drain"], water: "full",
        gate: { kind: "grate", state: "locked", controlledBy: "the miller" } },
      { id: "cistern-vault", from: "cistern", to: "vault", kind: "gallery", systems: ["smuggle"], water: "waist",
        gate: { kind: "seal", state: "sealed" }, note: "GM only" },
    ],
    sections: [
      { id: "cellar-map", name: "The mill cellar", origin: { x: -40, y: -40 }, rotation: 0, sizeSq: { w: 18, h: 14 } },
    ],
  };
}
