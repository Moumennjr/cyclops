// Turning what the user typed into one or more entry files.
//
// The CLI used to accept exactly one path, so tracing a project meant
// instrumenting files one at a time and losing the tree each time. That made
// "why is this function slow" unanswerable for anything but a single module,
// which is the case people actually have.
//
// Supported forms:
//
//   cyclops app.js              one file
//   cyclops src/                every traceable file in a directory, in order
//   cyclops "src/**/*.ts"       a glob
//   cyclops a.js b.ts           several files: the first is the entry, the rest
//                               are instrumented so its imports resolve
//
// A directory or glob with more than one candidate does not silently pick one.
// It asks which entry to run, because guessing wrong produces a trace of code
// the user did not mean to look at -- and a call tree is only as useful as the
// entry it started from.

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

// extensions cyclops knows how to trace
export const TRACEABLE = [
  ".js", ".mjs", ".cjs",
  ".jsx",
  ".ts", ".mts", ".cts",
  ".tsx",
];

// directories never worth walking into
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage",
  ".next", ".nuxt", ".cache", ".venv", "__pycache__",
]);

// A file worth offering as an entry point.
export function isTraceable(file) {
  return TRACEABLE.includes(extname(file).toLowerCase());
}

// Depth-first list of traceable files under `dir`, sorted so runs are
// reproducible. Symlinked directories are not followed: a cycle through one
// would never terminate.
export function walkDir(dir, { maxDepth = 12, maxFiles = 2000 } = {}) {
  const out = [];
  const visit = (current, depth) => {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    // Directories last within a level, so a top-level entry point is offered
    // before anything nested in it.
    entries.sort((a, b) => {
      const aDir = a.isDirectory() ? 1 : 0;
      const bDir = b.isDirectory() ? 1 : 0;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".js") {
        if (entry.name !== ".") continue;
      }
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(full, depth + 1);
      } else if (entry.isFile() && isTraceable(full)) {
        out.push(full);
      }
    }
  };
  visit(resolve(dir), 0);
  return out;
}

function isDir(p) {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Minimal glob support: `**`, `*`, and `?`, over forward-slash paths.
//
// A full glob engine is a dependency cyclops does not need. What it does need is
// to expand the shapes people actually type for a source tree, and to expand
// them without pulling in a package.
function globToRegExp(pattern) {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` crosses directories (including none at all);
        // a bare `**` matches the rest of the path.
        if (pattern[i + 2] === "/") {
          re += "(?:[^/]+/)*";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp(re + "$");
}

// Expands a glob relative to `cwd`. The non-magic prefix is walked as real
// directories, so `src/**/*.ts` does not scan the whole repository.
export function expandGlob(pattern, { cwd = process.cwd(), maxFiles = 2000 } = {}) {
  const norm = pattern.split("\\").join("/");
  const segments = norm.split("/");
  const magicAt = segments.findIndex((s) => /[*?]/.test(s));
  if (magicAt === -1) {
    const direct = resolve(cwd, norm);
    return isTraceable(direct) && !isDir(direct) ? [direct] : [];
  }

  const base = resolve(cwd, ...segments.slice(0, magicAt)) || cwd;
  const roots = existsSync(base) ? [base] : [];

  // The pattern is anchored at `base`, and the walk starts there, so the
  // matcher has to see paths relative to `base` too -- otherwise an absolute
  // match is compared against a pattern that begins with "src/" and never
  // fires.
  const tail = segments.slice(magicAt).join("/");
  const re = globToRegExp(tail);

  const found = [];
  const visit = (current) => {
    if (found.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(full);
      } else if (entry.isFile()) {
        const rel = full.slice(base.length).replace(/^[\\/]/, "").split("\\").join("/");
        if (re.test(rel) && isTraceable(full)) found.push(full);
      }
    }
  };
  for (const root of roots) visit(root);
  return found.sort();
}

// The result of interpreting the command line.
export function resolveTargets(inputs, { cwd = process.cwd() } = {}) {
  const out = {
    kind: "none",
    entries: [],
    others: [],
    message: null,
  };
  if (!inputs.length) return out;

  const expanded = [];
  for (const input of inputs) {
    const abs = resolve(cwd, input);
    if (isDir(abs)) {
      expanded.push(...walkDir(abs));
    } else if (/[*?]/.test(input)) {
      expanded.push(...expandGlob(input, { cwd }));
    } else if (existsSync(abs)) {
      expanded.push(abs);
    } else {
      out.message = `cyclops: no such file or directory: ${input}`;
      return out;
    }
  }

  // de-duplicate while keeping order
  const unique = [...new Set(expanded)];
  if (!unique.length) {
    out.message = "cyclops: nothing traceable was found";
    return out;
  }

  if (unique.length === 1) {
    out.kind = "single";
    out.entries = unique;
    return out;
  }

  // Several files. Rank the ones that plausibly *are* an entry: a root-level
  // file, or one whose name marks it as a starting point.
  const ranked = [...unique].sort((a, b) => entryScore(b) - entryScore(a));
  out.kind = "multi";
  out.entries = ranked;
  return out;
}

// How likely a file is to be the intended entry point.
function entryScore(file) {
  const name = basename(file).toLowerCase();
  const depth = file.split("/").length;
  let score = 10 - Math.min(depth, 9);
  if (/^(index|main|app|cli|server|run|program)\.[cm]?[jt]sx?$/.test(name)) {
    score += 20;
  }
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) score -= 25;
  if (/\.(config|d)\.[cm]?[jt]sx?$/.test(name)) score -= 15;
  return score;
}

export { entryScore };