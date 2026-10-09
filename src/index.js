// The library surface.
//
// The CLI is one caller of this; an agent plugin is another; a test or an
// editor is a third. This file is what all of them import, and it is
// deliberately small -- re-exporting whole modules reads as convenience but
// hides which names a caller depends on, and an accidental export becomes an
// accidental API.

export { trace, traceFile, traceToFile, planEntry, prepare, cleanup } from "./engine.js";

export {
  renderTree, renderFlat, aggregate, selfDuration, locationOf,
} from "./render.js";

export {
  summarize, stats, errorReport, deepestPaths, duplicateDefinitions,
  findFrames, subtree,
} from "./analyze.js";

export { computeStats, fmt, valueType, toFlowModel } from "./public/flow-model.js";
export { snapshot } from "./snapshot.js";
export { splitTree, writeTree } from "./treeio.js";
export { TRACEABLE, isTraceable, resolveTargets } from "./targets.js";
export { startServer } from "./server.js";

// The version cyclops reports about itself, from package.json.
//
// Read rather than hard-coded so it cannot drift from the published package
// when the version is bumped.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const version = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
).version;
