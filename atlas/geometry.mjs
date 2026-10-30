// The canonical copy lives in review-ui/public/atlas-geometry.mjs so the browser can load it (no zod, no build
// step); the library re-exports it rather than mirroring it. Same precedent as session-planner/run-layout.mjs.
export * from "../review-ui/public/atlas-geometry.mjs";
