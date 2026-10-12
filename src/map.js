// Turning a directory of scans into one graph.
//
// scanFile() reports what each file contains, in isolation. This resolves those
// per-file facts into a single graph: which module imports which, and -- the
// part that actually takes work -- which function calls which *across* a module
// boundary.
//
// Resolution is name-based and therefore fallible, so it is done in tiers and
// every edge keeps its confidence. The tiers, in order of how much they prove:
//
//   same file, exact name         EXTRACTED  nothing else could be meant
//   imported binding -> export    EXTRACTED  the module exports that name
//   unique global match           INFERRED   nothing local could be meant
//   ambiguous                     AMBIGUOUS  kept, not guessed at
//
// The last tier is the important one. "There is exactly one `parse` in the
// project" is a good guess and a bad fact -- it is wrong the moment there is a
// second one, and the failure is invisible. Marking it INFERRED means a reader
// can see how much of the map is guesswork, which is the difference between a
// map and a rumour.

import { scanFile, EXTRACTED, INFERRED, AMBIGUOUS } from "./scan.js";
import { resolveTargets, isTraceable } from "./targets.js";
import { resolveLocal } from "./graph.js";
import { basename, dirname, relative, resolve } from "node:path";

// Call targets that are built-ins or language features. They are never edges:
// `String(x)` is not a fact about this codebase, and including it would put a
// node for every global in the language next to the project's own code.
const GLOBALS = new Set([
  "String", "Number", "Boolean", "Object", "Array", "Set", "Map", "WeakMap",
  "WeakSet", "JSON", "Math", "Date", "RegExp", "Error", "TypeError",
  "RangeError", "SyntaxError", "Promise", "Symbol", "BigInt", "Proxy",
  "Reflect", "URL", "URLSearchParams", "Intl", "console", "process",
  "Buffer", "structuredClone", "queueMicrotask", "setTimeout", "setInterval",
  "setImmediate", "clearTimeout", "clearInterval", "clearImmediate",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "eval", "fetch",
  "Function", "WeakRef", "FinalizationRegistry", "AggregateError",
  "globalThis", "undefined", "NaN", "Infinity",
]);

// Imports that are never part of a project's own map.
const EXTERNAL_PREFIX = /^(node:|bun:|deno:|data:)/;

/**
 * Scans a target and builds the project graph.
 *
 * options:
 *   cwd            root for relative output
 *   maxFiles       cap on files scanned     (default 500)
 *   includeTests   keep *.test.js / *.spec  (default false)
 *   includeExternal draw edges to packages   (default false)
 */
export function buildMap(target, options = {}) {
  const {
    cwd = process.cwd(),
    maxFiles = 500,
    includeTests = false,
    includeExternal = false,
  } = options;

  const plan = resolveTargets([target], { cwd });
  if (plan.message) {
    return { error: plan.message, nodes: [], edges: [], files: [], skipped: [] };
  }

  // Scan every traceable file under the target, not just the entry: the point
  // of a map is the whole picture.
  const files = [];
  const collect = (p) => {
    if (files.length >= maxFiles) return;
    files.push(resolve(p));
  };
  for (const entry of plan.entries) {
    if (includeTests || !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry)) collect(entry);
  }
  // The target was a directory: resolveTargets already expanded it.
  const all = plan.entries.filter(
    (p) => includeTests || !/\.(test|spec)\.[cm]?[jt]sx?$/.test(p),
  );

  const scans = new Map();
  const skipped = [];
  for (const file of all.slice(0, maxFiles)) {
    const scan = scanFile(file);
    if (scan.error) {
      skipped.push({ file, reason: scan.error });
      continue;
    }
    scans.set(file, scan);
  }

  // ---- nodes --------------------------------------------------------------
  const nodes = [];
  const nodeById = new Map();

  const addNode = (node) => {
    if (nodeById.has(node.id)) return nodeById.get(node.id);
    nodes.push(node);
    nodeById.set(node.id, node);
    return node;
  };

  const externalNodes = new Map();

  for (const [file, scan] of scans) {
    const short = relative(cwd, file).split("\\").join("/");

    addNode({
      id: `m:${short}`,
      kind: "module",
      label: basename(file),
      file: short,
      lines: scan.lineCount,
      exported: scan.exports.length,
      imported: scan.imports.length,
      functions: scan.functions.length,
      isTest: scan.isTest,
      isEntry: scan.isEntry,
    });

    for (const fn of scan.functions) {
      addNode({
        id: `f:${short}::${fn.name}`,
        kind: fn.kind === "class" ? "class" : "function",
        label: fn.name,
        file: short,
        line: fn.line,
        exported: fn.exported,
        async: fn.async,
        generator: fn.generator,
        params: fn.params,
        owner: fn.owner || null,
      });
    }
  }

  // ---- edges --------------------------------------------------------------
  const edges = [];
  const edgeKey = new Set();
  const addEdge = (source, target, relation, confidence, line = null) => {
    if (!source || !target || source === target) return;
    const key = `${source}|${target}|${relation}`;
    if (edgeKey.has(key)) return;
    edgeKey.add(key);
    edges.push({ source, target, relation, confidence, line });
  };

  // A module node for an outside package, so `import "react"` is visible as
  // something external rather than silently missing.
  const externalNode = (spec) => {
    if (externalNodes.has(spec)) return externalNodes.get(spec);
    const id = `x:${spec}`;
    externalNodes.set(spec, id);
    nodes.push({ id, kind: "external", label: spec, file: null });
    return id;
  };

  for (const [file, scan] of scans) {
    const short = relative(cwd, file).split("\\").join("/");
    const modId = `m:${short}`;

    // contains
    for (const fn of scan.functions) {
      addEdge(modId, `f:${short}::${fn.name}`, "contains", EXTRACTED, fn.line);
    }

    // imports
    for (const imp of scan.imports) {
      if (EXTERNAL_PREFIX.test(imp.spec)) {
        if (includeExternal) addEdge(modId, externalNode(imp.spec), "imports", EXTRACTED);
        continue;
      }
      const target = resolveLocal(imp.spec, file);
      if (target && scans.has(resolve(target))) {
        addEdge(modId, `m:${relative(cwd, resolve(target)).split("\\").join("/")}`,
          "imports", EXTRACTED);
      } else {
        // A bare specifier that is not a builtin is a package.
        if (includeExternal && !imp.spec.startsWith(".")) {
          addEdge(modId, externalNode(imp.spec), "imports", EXTRACTED);
        }
      }
    }
  }

  // ---- calls --------------------------------------------------------------
  // A name index across every scanned function, so a cross-file call can be
  // resolved. Maps name -> [{file, exported}].
  const byName = new Map();
  for (const [file, scan] of scans) {
    const short = relative(cwd, file).split("\\").join("/");
    for (const fn of scan.functions) {
      if (!byName.has(fn.name)) byName.set(fn.name, []);
      byName.get(fn.name).push({
        file,
        short,
        node: `f:${short}::${fn.name}`,
        exported: fn.exported,
        owner: fn.owner || null,
      });
    }
  }

  // Which names each file imports, and from where. This is what turns
  // `helper(x)` in app.js into an edge to helper.js's `helper`.
  //
  // Built in its own pass because the call resolution below needs every file's
  // bindings, not just the one being walked -- resolving them lazily would mean
  // rescanning per call.
  const importBindings = new Map(); // file -> Map(localName -> {file, exported})
  for (const [file, scan] of scans) {
    const bindings = new Map();
    for (const [local, info] of scan.importedBindings) {
      const target = resolveLocal(info.source, file);
      if (target) {
        bindings.set(local, { file: resolve(target), exported: info.exported });
      }
    }
    importBindings.set(file, bindings);
  }

  const localNames = (file, scan) =>
    new Set(scan.functions.map((f) => f.name));

  for (const [file, scan] of scans) {
    const short = relative(cwd, file).split("\\").join("/");
    const own = localNames(file, scan);
    const bindings = importBindings.get(file) || new Map();
    const modId = `m:${short}`;

    for (const call of scan.calls) {
      const fromId = call.from
        ? `f:${short}::${call.from}`
        : modId; // a call at module top level
      const target = call.to;
      if (!target) continue;

      // 1. local, exact -- nothing else could be meant
      if (own.has(target)) {
        addEdge(fromId, `f:${short}::${target}`, "calls", EXTRACTED, call.line);
        continue;
      }

      // 2. a bare name that came from an import
      if (bindings.has(target)) {
        const dest = bindings.get(target);
        const destScan = scans.get(dest.file);
        if (destScan) {
          const destShort = relative(cwd, dest.file).split("\\").join("/");
          if (dest.exported === "*") {
            // namespace import: we know the module, not the function
            addEdge(fromId, `m:${destShort}`, "calls-module", EXTRACTED, call.line);
            continue;
          }
          const matches = destScan.functions.filter((f) => f.name === dest.exported);
          if (matches.length) {
            addEdge(fromId, `f:${destShort}::${dest.exported}`, "calls", EXTRACTED, call.line);
          } else if (dest.exported === "default") {
            // default export whose local name may differ
            const def = destScan.functions.find((f) => f.exported && f.name === "default");
            if (def) addEdge(fromId, `f:${destShort}::default`, "calls", EXTRACTED, call.line);
            else addEdge(fromId, `m:${destShort}`, "calls-module", INFERRED, call.line);
          } else {
            addEdge(fromId, `m:${destShort}`, "calls-module", INFERRED, call.line);
          }
          continue;
        }
        continue;
      }

      // 3. a method call: `ns.fn()` where ns is an imported namespace
      if (call.via && bindings.has(call.via)) {
        const dest = bindings.get(call.via);
        const destScan = scans.get(dest.file);
        if (destScan) {
          const destShort = relative(cwd, dest.file).split("\\").join("/");
          const member = target.slice(call.via.length + 1);
          const match = destScan.functions.find(
            (f) => f.name === member || f.name.endsWith(`.${member}`),
          );
          if (match) {
            addEdge(fromId, `f:${destShort}::${match.name}`, "calls", EXTRACTED, call.line);
          } else {
            addEdge(fromId, `m:${destShort}`, "calls-module", INFERRED, call.line);
          }
          continue;
        }
      }

      // 4. a global: not an edge at all
      if (GLOBALS.has(target) || GLOBALS.has(target.split(".")[0])) continue;

      // 5. unique across the project -- a good guess, marked as one
      const candidates = byName.get(target);
      if (candidates && candidates.length === 1) {
        addEdge(fromId, candidates[0].node, "calls", INFERRED, call.line);
        continue;
      }

      // 6. ambiguous: keep it, do not guess
      if (candidates && candidates.length > 1) {
        addEdge(fromId, candidates[0].node, "calls", AMBIGUOUS, call.line);
      }
    }
  }

  return {
    error: null,
    cwd,
    target,
    files: [...scans.keys()].map((f) => relative(cwd, f).split("\\").join("/")),
    skipped,
    truncated: all.length > maxFiles,
    totalFiles: all.length,
    nodes,
    edges,
  };
}

export { GLOBALS, isTraceable, dirname };