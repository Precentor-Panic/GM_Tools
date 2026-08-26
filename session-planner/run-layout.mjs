/**
 * Run layout vocabulary + inference — ONE implementation, shared by the
 * stores (this side), the HTTP server, and the browser. The canonical file
 * lives in review-ui/public/run-layout.mjs so the browser imports it with a
 * plain relative path (`./run-layout.mjs`) and Node resolves the same file
 * here; this module is only a re-export so store code keeps importing from
 * `session-planner/`. Never copy the logic — edit the public file.
 */
export * from "../review-ui/public/run-layout.mjs";
