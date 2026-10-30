// The canonical renderer lives in review-ui/public/atlas-render.mjs (the browser loads it as is, no build step);
// the library re-exports it. PNG output is bin/atlas's job (Playwright, already a dev dependency of review-ui).
export * from "../review-ui/public/atlas-render.mjs";
