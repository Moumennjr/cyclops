// The tracing engine, with no CLI, no viewer and no console in it.
//
// Everything cyclops does happens here: pick an entry, instrument it and every
// local module it imports, run the result in a child process, and hand back the
// call tree. `src/cli.js` is a thin argument-parsing shell around this.
//
// The split matters because a call tracer is useful to three quite different
// callers, and none of them should have to shell out to a terminal program:
//
//   - the CLI, which wants the viewer and a TTY-aware exit code
//   - an agent plugin, which wants the tree as a value it can summarise
//   - an editor or a test, which wants it synchronously and in-process
//
// So: no `process.exit` anywhere in this module, no writes to stdout or stderr,
// and no reading of `process.argv`. Callers decide what to do with the result.

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { transform } from "./transform.js";
import { stripTypes, shadowExtension } from "./strip.js";
import {
  collectLocalGraph, localSpecifiers, resolveLocal, shadowPath,
} from "./graph.js";
import { rewriteSpecifier } from "./imports.js";
import { resolveTargets } from "./targets.js";
import { runtimeSource } from "./runtime.js";
import { splitTree, writeTree } from "./treeio.js";

// A relative specifier that Node will accept as written.
//
// `relative()` may return a bare filename with no `./`, which ESM rejects with
// ERR_INVALID_MODULE_SPECIFIER ("x" is treated as a package name, not a path).
// `startsWith(".")` is useless as the guard here because every shadow is a
// dotfile (".cyclops-mid.mjs"), so the test is "starts with ./ or ../".
export function toRelativeSpecifier(fromDir, target) {
  const rel = relative(fromDir, target).split("\\").join("/");
  if (rel === "") return ".";
  if (rel.startsWith("./") || rel.startsWith("../")) return rel;
  return "./" + rel;
}

// Resolves what the caller asked for into one entry file plus its neighbours.
export function planEntry(inputs, { cwd = process.cwd() } = {}) {
  const targets = resolveTargets(inputs, { cwd });
  if (targets.message) {
    return { error: targets.message, entry: null, siblings: [] };
  }
  return {
    error: null,
    entry: targets.entries[0],
    siblings: targets.entries.slice(1),
    considered: targets.entries.length,
  };
}

// Builds the runnable program on disk and returns what was written.
//
// The instrumented copy sits *beside the source*, never in a temp directory:
// ESM resolves relative specifiers against the importing file's directory, so a
// copy in /tmp turns `./helper.js` into a lookup in /tmp.
export function prepare(entry, { token = String(process.pid) } = {}) {
  const entryAbs = resolve(entry);
  const source = readFileSync(entryAbs, "utf8");

  const stripped = stripTypes(source, entryAbs);
  const result = transform(stripped, { filename: entryAbs });

  const srcDir = dirname(entryAbs);
  const base = basename(entryAbs).replace(/\.[^.]*$/, "");
  const entryExt = shadowExtension(source, entryAbs);
  const entryShadow = join(srcDir, `.cyclops-${base}-${token}.${entryExt}`);

  const warnings = [...result.warnings];
  const shadowOf = new Map(); // absolute source path -> shadow path
  const files = [];            // every path written, for cleanup

  // Neighbouring local modules are instrumented too. A file the entry imports
  // runs unmodified from disk otherwise, so none of its functions become frames
  // and every cross-file call looks like a leaf. Each neighbour is written
  // beside itself, so its own relative imports keep resolving and the walk is
  // transitive with no path rewriting inside it.
  const graph = collectLocalGraph(entryAbs);

  for (const [abs, neighbourSource] of graph) {
    if (abs === entryAbs) continue;
    let out;
    try {
      out = transform(stripTypes(neighbourSource, abs), { filename: abs });
    } catch (e) {
      warnings.push({
        reason: `neighbour could not be instrumented (${e.message.split("\n")[0]})`,
        name: basename(abs),
        line: null,
        file: abs,
      });
      continue;
    }
    shadowOf.set(abs, shadowPath(abs, token, shadowExtension(neighbourSource, abs)));
  }

  for (const [abs, neighbourSource] of graph) {
    const shadow = shadowOf.get(abs);
    if (!shadow) continue;
    let code;
    try {
      code = transform(stripTypes(neighbourSource, abs), { filename: abs }).code;
    } catch {
      continue;
    }
    // Repoint this neighbour's own relative imports at the other shadows.
    for (const spec of localSpecifiers(neighbourSource)) {
      const target = resolveLocal(spec, abs);
      const dest = target && shadowOf.get(target);
      if (dest) code = rewriteSpecifier(code, spec, toRelativeSpecifier(dirname(abs), dest));
    }
    writeFileSync(shadow, code);
    files.push(shadow);
  }

  // ...and the entry's, the same way. Without this Node resolves `./mid.js` to
  // the original uninstrumented file and the whole exercise achieves nothing.
  let entryCode = result.code;
  for (const spec of localSpecifiers(source)) {
    const target = resolveLocal(spec, entryAbs);
    const dest = target && shadowOf.get(target);
    if (dest) entryCode = rewriteSpecifier(entryCode, spec, toRelativeSpecifier(srcDir, dest));
  }
  writeFileSync(entryShadow, runtimeSource() + "\n" + entryCode);
  files.push(entryShadow);

  return {
    entry: entryAbs,
    shadow: entryShadow,
    extension: entryExt,
    source,
    code: result.code,
    warnings,
    files,
    instrumented: shadowOf.size,
  };
}

// Removes every file prepare() wrote.
//
// The shadows must outlive the child process or its imports dangle, so this is
// called after the run, never from the same finally that unlinks the entry.
export function cleanup(prepared) {
  if (!prepared || !prepared.files) return;
  for (const file of prepared.files) {
    try {
      unlinkSync(file);
    } catch {
      // already gone, or never written; nothing to do
    }
  }
}

// Traces one entry file and returns the tree.
//
// Resolves rather than rejects on a program that runs and throws: the tree is
// more useful than the error, and the child process's own exit code is
// reported separately as `exitCode`.
//
// Rejects only when the trace could not be produced at all (unreadable file,
// unparseable source) or when `keepShadows` is false and the caller asked for
// cleanup to be unconditional.
export function traceFile(entry, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    timeout = options.timeoutMs ?? 60_000,
    keepShadows = false,
    input,
  } = options;

  let prepared;
  try {
    prepared = prepare(entry, { token: options.token ?? String(process.pid) });
  } catch (e) {
    return {
      ok: false,
      error: `cyclops: ${e.message}`,
      tree: null,
      exitCode: null,
      stdout: "",
      stderr: "",
      warnings: [],
      entry: null,
    };
  }

  let run;
  try {
    run = spawnSync(process.execPath, [prepared.shadow], {
      encoding: "utf8",
      cwd,
      env,
      timeout,
      input,
    });
  } catch (e) {
    if (!keepShadows) cleanup(prepared);
    return {
      ok: false,
      error: `cyclops: failed to run the instrumented file: ${e.message}`,
      tree: null,
      exitCode: null,
      stdout: "",
      stderr: "",
      warnings: prepared.warnings,
      entry: prepared.entry,
    };
  } finally {
    if (!keepShadows) cleanup(prepared);
  }

  const { tree, userText } = splitTree(run.stderr ?? "");

  return {
    ok: tree !== null,
    // A run that crashed still yields a tree; saying so is better than
    // pretending the program failed outright.
    error: tree
      ? null
      : (run.stderr || "").trim().split("\n").slice(-1)[0] ||
        "cyclops: no trace captured (no instrumented call ran)",
    tree,
    exitCode: run.status,
    signal: run.signal ?? null,
    stdout: run.stdout ?? "",
    stderr: userText,
    rawStderr: run.stderr ?? "",
    warnings: prepared.warnings,
    entry: prepared.entry,
    instrumented: prepared.instrumented,
    timedOut: run.signal === "SIGTERM" && run.error === undefined
      ? false
      : Boolean(run.error && run.error.code === "ETIMEDOUT"),
  };
}

// Traces whatever the caller named -- a file, a directory, a glob, or several.
//
// Returns `entry` even when the trace failed, so a caller can report which file
// was chosen rather than only that something went wrong.
export function trace(inputs, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  if (typeof inputs === "string") inputs = [inputs];

  const plan = planEntry(inputs, { cwd });
  if (plan.error) {
    return {
      ok: false, error: plan.error, tree: null, exitCode: null,
      stdout: "", stderr: "", warnings: [], entry: null, instrumented: 0,
    };
  }

  const result = traceFile(plan.entry, { ...options, cwd });
  if (!result.ok) return result;

  return {
    ...result,
    considered: plan.considered,
    siblings: plan.siblings,
  };
}

// Traces and writes out/tree.json, the artefact the viewer reads.
export function traceToFile(inputs, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const outFile = options.outFile ?? join(cwd, "out", "tree.json");
  const result = trace(inputs, { ...options, cwd });
  if (!result.ok || !result.tree) return { ...result, outFile: null };

  writeTree(outFile, result.tree);
  return { ...result, outFile };
}