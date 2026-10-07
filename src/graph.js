// Following a program's own imports and instrumenting them too.
//
// The entry file alone is not a call tree. If `main.js` calls `helper.js`, the
// frame for `helper()` is missing, and the caller looks like a leaf -- which is
// exactly the wrong answer for a tool whose whole purpose is showing who calls
// whom.
//
// Node already knows how to resolve module specifiers; reimplementing that
// faithfully (extension probing, directory indexes, package.json "exports",
// node_modules) is a large amount of subtle code. So this module only resolves
// the subset that is unambiguously *local* -- a relative specifier that lands on
// a real file -- and leaves everything else untouched. Bare specifiers
// (`react`, `node:fs`) are the package manager's business and are never
// rewritten.
//
// Each resolved local file is rewritten in place into a sibling
// `.cyclops-<name>-<pid>.mjs`, so it still resolves its *own* imports relative
// to itself and the graph can be followed transitively.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { parseImports } from "./imports.js";

// extensions probed when a specifier has no extension of its own
const PROBE = [
  ".ts", ".mts", ".cts", ".tsx", ".jsx",
  ".js", ".mjs", ".cjs",
];

// tried first when a specifier carries a .js/.jsx extension but names TypeScript
// on disk -- the standard TypeScript import convention
const TS_FIRST = [".ts", ".tsx", ".mts", ".cts"];

// a directory resolves through its index file
const INDEX = [".js", ".mjs", ".cjs", ".ts", ".tsx"];

function isFile(p) {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Turns a relative specifier into the file it names, or null when it names a
// package, a builtin, or something that is not there.
export function resolveLocal(specifier, fromFile) {
  if (typeof specifier !== "string") return null;
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  // "./x.js?raw" style suffixes are a bundler convention, not Node's
  const clean = specifier.split("?")[0].split("#")[0];

  const base = resolvePath(dirname(fromFile), clean);

  if (isFile(base)) return base;

  // TypeScript sources import each other with the *emitted* extension:
  // `./svc.js` is the conventional way to write `import { s } from "./svc"`
  // from a .ts file, because that is what the compiled output will say. Probe
  // the extension that was written, not an appended one.
  const written = /\.[cm]?jsx?$/i.exec(base);
  if (written) {
    const stem = base.slice(0, -written[0].length);
    for (const ext of TS_FIRST) {
      if (isFile(stem + ext)) return stem + ext;
    }
  }

  for (const ext of PROBE) {
    if (isFile(base + ext)) return base + ext;
  }
  if (isDir(base)) {
    for (const ext of INDEX) {
      const candidate = resolvePath(base, "index" + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

// Walks the import graph from `entry`, returning every local file reachable
// through relative specifiers, entry included. Bounded by `maxFiles` so a
// pathological graph (or a cycle through many modules) cannot run away.
export function collectLocalGraph(entry, { maxFiles = 200 } = {}) {
  const seen = new Map(); // absolute path -> source text
  const queue = [resolvePath(entry)];

  while (queue.length && seen.size < maxFiles) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    seen.set(file, source);
    for (const spec of localSpecifiers(source)) {
      const target = resolveLocal(spec, file);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

// The relative specifiers in one file, in source order and de-duplicated.
export function localSpecifiers(source) {
  const found = new Set();
  for (const spec of parseImports(source)) {
    if (spec.startsWith("./") || spec.startsWith("../")) found.add(spec);
  }
  return [...found];
}

// The copy path a file's instrumented twin is written to. Kept beside the
// original so relative imports inside *that* file still resolve.
//
// The extension is decided by the caller: a CommonJS file has to stay CommonJS,
// or its own `require()` calls stop working once the file is renamed to `.mjs`.
export function shadowPath(file, token, ext = "mjs") {
  const dir = dirname(file);
  const name = file.split(/[\\/]/).pop().replace(/\.[^.]*$/, "");
  return resolvePath(dir, `.cyclops-${name}-${token}.${ext}`);
}