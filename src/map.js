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
import { statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
 * A path relative to the scan root, or just the tail when the file sits
 * outside it.
 *
 * The tail rather than a "../../../elsewhere" chain: node ids end up in URLs,
 * in the map JSON, and in React Flow's DOM, and a wall of `../` in all three
 * helps nobody. The file field keeps the full relative path for the label.
 */
function shortPath(file, cwd) {
  const rel = relative(cwd, file).split(sep).join("/");
  if (!rel.startsWith("..")) return rel;
  const parts = file.split(/[\\/]/);
  return parts.length > 2 ? parts.slice(-3).join("/") : file.split(/[\\/]/).pop();
}

/**
 * Scans a target and builds the project graph.
 *
 * options:
 *   cwd            root for relative output
 *   maxFiles       cap on files scanned     (default 500)
 *   includeTests   keep *.test.js / *.spec  (default false)
 *   includeExternal draw edges to packages   (default false)
 */
/**
 * Node ids for functions and shadowing locals.
 *
 * The path is included, not just the basename: two `helper` functions in
 * different files would otherwise share an id, which put them on top of each
 * other in the layout and merged their edges. A basename is fine for a label,
 * where a collision is invisible, and wrong for an identity, where it is not.
 */
/**
 * Asks whether a built map still matches the files it was built from.
 *
 * A map is a photograph, and photographs go stale. The viewer will happily show
 * a map of a project that has since been rewritten, with no indication that the
 * edges no longer correspond to any line of code. This compares each source
 * file's modification time against the map's own build time.
 *
 * Returns { stale, checked, changed, note }:
 *   stale    -- at least one source file is newer than the map
 *   checked  -- how many files were stat()ed
 *   changed  -- which ones, first 10, so the reader can look
 *
 * A file that has been *deleted* counts as changed: a map claiming to describe
 * a file that is not there is more wrong than one describing an old file.
 *
 * Caveat, honestly: this is mtime-based. A file rewritten within the same
 * filesystem timestamp tick as the map build is invisible to it, and a file
 * touched without changing its contents counts as stale. The first is a rare
 * false negative, the second a harmless false positive; neither is worth
 * hashing the whole tree to avoid.
 */
export function mapStaleness(map, options = {}) {
  const cwd = options.cwd ?? map?.cwd ?? process.cwd();
  const files = Array.isArray(map?.files) ? map.files : [];
  if (!map?.generatedAt || !files.length) {
    return {
      stale: false,
      checked: 0,
      changed: [],
      note: map?.generatedAt ? null : "this map predates the staleness check",
    };
  }
  const builtAt = Date.parse(map.generatedAt);
  if (Number.isNaN(builtAt)) {
    return { stale: false, checked: 0, changed: [], note: "unparseable build time" };
  }
  const changed = [];
  for (const rel of files) {
    const abs = isAbsolute(rel) ? rel : join(cwd, rel);
    try {
      if (statSync(abs).mtimeMs > builtAt) changed.push(rel);
    } catch {
      // Gone counts as changed -- see above.
      changed.push(rel);
    }
  }
  return {
    stale: changed.length > 0,
    checked: files.length,
    changed: changed.slice(0, 10),
    changedCount: changed.length,
  };
}

export function functionNodeId(shortFile, name) {
  return `f:${shortFile}::${name}`;
}

export function localNodeId(shortFile, name) {
  return `l:${shortFile}::${name}`;
}

export function buildMap(target, options = {}) {
  const {
    // A target outside cwd would otherwise produce ids like
    // "../../../elsewhere/app.js" -- unreadable in a URL, in a JSON file, and in
    // the browser's node ids. The common root of cwd and every scanned file is
    // used instead, so ids stay short and a viewer can label them with the tail.
    cwd: requestedCwd = process.cwd(),
    maxFiles = 500,
    includeTests = false,
    includeExternal = false,
  } = options;

  const cwd = resolve(requestedCwd);
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
    const short = shortPath(file, cwd);

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
        id: functionNodeId(short, fn.name),
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
    const short = shortPath(file, cwd);
    const modId = `m:${short}`;

    // contains
    for (const fn of scan.functions) {
      addEdge(modId, functionNodeId(short, fn.name), "contains", EXTRACTED, fn.line);
    }

    // imports
    for (const imp of scan.imports) {
      if (EXTERNAL_PREFIX.test(imp.spec)) {
        if (includeExternal) addEdge(modId, externalNode(imp.spec), "imports", EXTRACTED);
        continue;
      }
      const target = resolveLocal(imp.spec, file);
      if (target && scans.has(resolve(target))) {
        addEdge(modId, `m:${shortPath(resolve(target), cwd)}`,
          "imports", EXTRACTED);
      } else {
        // A bare specifier that is not a builtin is a package.
        if (includeExternal && !imp.spec.startsWith(".")) {
          addEdge(modId, externalNode(imp.spec), "imports", EXTRACTED);
        }
      }
    }
  }

  // A node for each shadowing local, so a call to one has something to point
  // at. Kept visible rather than dropped: "this calls a function defined right
  // here" is a real relationship, and hiding it makes the map look simpler than
  // it is -- which is how a map starts lying.
  for (const [file, scan] of scans) {
    const short = shortPath(file, cwd);
    for (const call of scan.calls) {
      if (call.confidence !== "SHADOWED") continue;
      addNode({
        id: localNodeId(short, call.to),
        kind: "local",
        label: `${call.to} (local)`,
        file: short,
        line: call.shadow?.line ?? null,
        owner: call.from || null,
      });
    }
  }

  // ---- calls --------------------------------------------------------------
  // A name index across every scanned function, so a cross-file call can be
  // resolved. Maps name -> [{file, exported}].
  const byName = new Map();
  for (const [file, scan] of scans) {
    const short = shortPath(file, cwd);
    for (const fn of scan.functions) {
      if (!byName.has(fn.name)) byName.set(fn.name, []);
      byName.get(fn.name).push({
        file,
        short,
        node: functionNodeId(short, fn.name),
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
    const short = shortPath(file, cwd);
    const own = localNames(file, scan);
    const bindings = importBindings.get(file) || new Map();
    const modId = `m:${short}`;

    for (const call of scan.calls) {
      const fromId = call.from
        ? functionNodeId(short, call.from)
        : modId; // a call at module top level
      const target = call.to;
      if (!target) continue;

      // 0. a name that is shadowed by a local binding is not the import.
      //
      // `const helper = (y) => y * 99; helper(1)` inside a function that also
      // imports `helper` is a call to a *local*, in a different function, in
      // this file. Attaching it to the import draws a confident arrow to
      // something that was never called -- so instead it is recorded as an
      // unresolved local, which is the truth.
      if (call.confidence === "SHADOWED") {
        // Unless the local *is* the function being defined, in which case this
        // is a normal local call and the tier below handles it correctly.
        if (!(call.from && own.has(target))) {
          addEdge(fromId, localNodeId(short, target), "calls", AMBIGUOUS, call.line);
        }
        continue;
      }

      // 1. local, exact -- nothing else could be meant
      if (own.has(target)) {
        addEdge(fromId, functionNodeId(short, target), "calls", EXTRACTED, call.line);
        continue;
      }

      // 2. a bare name that came from an import
      if (bindings.has(target)) {
        const dest = bindings.get(target);
        const destScan = scans.get(dest.file);
        if (destScan) {
          const destShort = shortPath(dest.file, cwd);
          if (dest.exported === "*") {
            // namespace import: we know the module, not the function
            addEdge(fromId, `m:${destShort}`, "calls-module", EXTRACTED, call.line);
            continue;
          }
          const matches = destScan.functions.filter((f) => f.name === dest.exported);
          if (matches.length) {
            addEdge(fromId, functionNodeId(destShort, dest.exported), "calls", EXTRACTED, call.line);
          } else if (dest.exported === "default") {
            // default export whose local name may differ
            const def = destScan.functions.find((f) => f.exported && f.name === "default");
            if (def) addEdge(fromId, functionNodeId(destShort, "default"), "calls", EXTRACTED, call.line);
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
          const destShort = shortPath(dest.file, cwd);
          const member = target.slice(call.via.length + 1);
          const match = destScan.functions.find(
            (f) => f.name === member || f.name.endsWith(`.${member}`),
          );
          if (match) {
            addEdge(fromId, functionNodeId(destShort, match.name), "calls", EXTRACTED, call.line);
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
    files: [...scans.keys()].map((f) => shortPath(f, cwd)),
    skipped,
    truncated: all.length > maxFiles,
    totalFiles: all.length,
    nodes,
    edges,
  };
}

export { GLOBALS, isTraceable, dirname };