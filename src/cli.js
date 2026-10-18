#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { traceToFile } from "./engine.js";
import { watchTrace } from "./watch.js";
import { summarize, findFrames } from "./analyze.js";
import { renderTree, renderFlat } from "./render.js";
import { startServer } from "./server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VITE_ROOT = join(HERE, "..");
const DEFAULT_PORT = 4600;

// dist/ ships with the package; a fresh clone builds it once on first serve.
function ensureBuild() {
  if (existsSync(join(VITE_ROOT, "dist", "index.html"))) return;
  const bin = join(VITE_ROOT, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(bin)) return; // server answers 503 with build instructions
  console.error("[cyclops] building the viewer ...");
  spawnSync(process.execPath, [bin, "--config", join(VITE_ROOT, "vite.config.mjs")], {
    cwd: VITE_ROOT,
    stdio: "ignore",
  });
}

// Fire-and-forget browser launch: not a server, but a hung opener must not
// outlive us — reap it on exit (the browser it spawned is not our child).
function openBrowser(url) {
  if (!process.stderr.isTTY) return;
  const [cmd, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const opener = spawn(cmd, args, { detached: true, stdio: "ignore" });
    opener.on("error", () => {});
    opener.unref();
    process.once("exit", () => {
      if (opener.exitCode === null) {
        try {
          opener.kill("SIGKILL");
        } catch {}
      }
    });
  } catch {}
}

function waitForSignal() {
  return new Promise((done) => {
    process.once("SIGINT", () => done(130));
    process.once("SIGTERM", () => done(143));
    process.once("SIGHUP", () => done(129));
  });
}

// `cyclops map <target>` is a subcommand rather than a flag, because it is a
// different question ("what is this codebase") rather than a different
// formatting of the same one ("what happened when I ran it"). A flag would
// force the map flags to share a namespace with the trace flags and both sets
// would grow.
function isMapCommand(argv) {
  return argv[0] === "map" || argv[0] === "--map";
}

// `cyclops trace-fn <file> <fn>`: run one function instead of a whole program.
// The other half of the bridge -- the map tells you what exists, this tells you
// what it did.
function isTraceFnCommand(argv) {
  return argv[0] === "trace-fn";
}

function printTraceFnUsage() {
  console.log(`usage: cyclops trace-fn <file.js> <function> [options]

  traces one named function instead of running a whole program.

  cyclops needs an entry point, so a function that is not exported is reached
  through its module and the harness will say so if it cannot find it. Callers
  found in the map are reported, because real arguments from a real call beat
  anything this could invent.

  options:
    --arg <literal>   a real argument, repeatable: --arg 1 --arg '"x"'
    --save <file>     write the generated harness here
    --json            print the harness and its confidence, run nothing

  confidence in the result:
    caller   the arguments came from you
    guess    synthesised from parameter names -- the trace may not reflect
             what your code really passes`);
}

function parseMapArgs(argv) {
  const rest = argv[0] === "map" || argv[0] === "--map" ? argv.slice(1) : argv;
  const files = [];
  let format = "report";
  let open = false;
  let noServer = false;
  let port = null;
  let includeTests = false;
  let includeExternal = false;
  let outFile = null;
  let maxFiles = 500;
  let help = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--report") format = "report";
    else if (a === "--map" || a === "--flat") format = "map";
    else if (a === "--edges") format = "edges";
    else if (a === "--open") open = true;
    else if (a === "--no-server") noServer = true;
    else if (a === "--tests") includeTests = true;
    else if (a === "--external") includeExternal = true;
    else if (a === "--max-files") maxFiles = Number(rest[++i]) || 500;
    else if (a === "--out") outFile = rest[++i] || null;
    else if (a === "--port") port = Number(rest[++i]) || null;
    else if (a === "--help" || a === "-h") help = true;
    else if (!a.startsWith("-")) files.push(a);
    else {
      console.error(`unknown map argument: ${a}`);
      process.exit(1);
    }
  }
  return {
    files, format, open, noServer, port,
    includeTests, includeExternal, outFile, maxFiles, help,
  };
}

function printMapUsage() {
  console.log(`usage: cyclops map <dir|file|glob> [options]

  reads a project statically -- without running it -- and draws its structure:
  modules, the functions in them, what imports what, and what calls what.

  output:
    --report          the analysis (default): load-bearing code, blast radius,
                      import cycles, functions with no caller
    --map             the whole map as indented text
    --edges           one line per edge, greppable
    --open            open the drawn map in the browser
    --out <file>      write the map JSON here (default out/map.json)
    --tests           include test files (excluded by default)
    --external        draw external packages as nodes too
    --max-files <n>   stop scanning after n files (default 500)
    --port N          viewer port (default 4600)`);
}

function parseArgs(argv) {
  const files = [];
  let port = null;
  let noServer = false;
  let noOpen = false;
  let serve = false;
  let watch = false;
  let format = null;      // summary | tree | flat -- print and exit
  let baseline = null;    // a tree.json to compare this run against
  let saveBaseline = false;
  let focus = null;
  let maxFrames = 0;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") port = Number(argv[++i]);
    else if (a.startsWith("--port=")) port = Number(a.slice("--port=".length));
    else if (a === "--no-server") noServer = true;
    else if (a === "--no-open") noOpen = true;
    else if (a === "--serve") serve = true;
    else if (a === "--baseline") baseline = argv[++i] || null;
    else if (a === "--watch") watch = true;
    else if (a === "--print" || a === "--summary") format = format || "summary";
    else if (a === "--tree") format = "tree";
    else if (a === "--flat") format = "flat";
    else if (a === "--focus") focus = argv[++i] || null;
    else if (a === "--max-frames") maxFrames = Number(argv[++i]) || 0;
    else if (a === "--save-baseline") saveBaseline = !argv[++i];
    else if (a === "--no-vite") continue; // deprecated no-op: the viewer ships built
    else if (a === "--help" || a === "-h") { help = true; continue; }
    else if (!a.startsWith("-")) files.push(a);
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return {files, port, noServer, noOpen, serve, watch, format, focus, maxFrames, baseline, help, saveBaseline};
}

function printUsage() {
  console.log(`usage: cyclops <file|dir|glob> [more...] [options]

  traces a file, a directory or a glob, writes the call tree to out/tree.json,
  and serves the viewer at http://localhost:${DEFAULT_PORT} until Ctrl+C
  (--serve forces serving in non-interactive runs).

  targets:
    cyclops app.js              one file
    cyclops src/                every traceable file in a directory
    cyclops "src/**/*.ts"       a glob
    cyclops a.js b.ts           the first is the entry, the rest are
                                instrumented so its imports resolve

  output:
    --summary, --tree, --flat   print the trace as text and exit, no browser
    --focus <name>              scope the output to one function's subtree
    --max-frames <n>            stop capturing after n frames (default 250000)
    --save-baseline             keep this run as the reference for next time
    --baseline <tree.json>      compare this run against an earlier one

  --watch re-traces on every change to the program, not just the entry, and
  keeps serving; the viewer already picks the new trace up by itself.

  traced dialects: .js .mjs .cjs .jsx .ts .mts .cts .tsx
  (generators, decorators, top-level await, private fields and async/await are
  all traced; compiler helpers are kept out of the tree)

  the entry must be a module: bare scripts with no import or require are still
  instrumented, but everything they call has to live in that one file.`);
}

async function main() {
  const argv = process.argv.slice(2);

  if (isTraceFnCommand(argv)) return traceFnMain(argv);

  // The map is a subcommand and runs no program at all, so it returns before
  // any of the trace machinery is touched -- no spawn, no instrumentation, no
  // exit-code semantics to inherit.
  if (isMapCommand(argv)) return mapMain(argv);

  const {files, port, noServer, noOpen, serve, watch, format, focus, maxFrames,
    baseline, help, saveBaseline} = parseArgs(argv);
  if (help || !files.length) {
    printUsage();
    process.exit(help ? 0 : 1);
  }

  // Target resolution, instrumentation and the child-process run all live in
  // engine.js. This function is argument parsing and presentation only, so the
  // same pipeline can be driven from a plugin or a test without a terminal.
  const result = traceToFile(files, {
    cwd: process.cwd(),
    keepShadows: false,
    maxFrames,
  });

  if (!result.ok) {
    console.error(result.error || "cyclops: no trace captured");
    process.exit(result.exitCode ?? 1);
  }
  if (result.entry) {
    if (result.considered > 1) {
      console.error(
        `[cyclops] ${result.considered} files match; entered at ${result.entry}`,
      );
    }
    if (result.extension === "cjs") {
      console.error("[cyclops] commonjs entry detected, tracing it as .cjs");
    }
  }

  for (const w of result.warnings || []) {
    console.warn(
      `[cyclops] skipped ${w.reason} "${w.name}" at ${w.file}:${w.line}`,
    );
  }

  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  console.error(`[cyclops] trace written to ${result.outFile}`);
  if (result.instrumented > 0) {
    console.error(`[cyclops] instrumented ${result.instrumented} imported file(s) too`);
  }

  // --watch keeps re-tracing while serving. The viewer polls /tree.json every
  // second and rebuilds when `version` changes, so it picks up each new trace
  // with no reload -- this only has to re-run the tracer and write the file.
  let controller = null;
  if (watch) {
    controller = watchTrace(files, {
      cwd: process.cwd(),
      outFile: result.outFile,
      // The trace above already happened and its result is in hand, so starting
      // with initial:false would leave the watcher with nothing to watch --
      // watchTrace learns what to watch from the files a trace instrumented.
      // Passing them through keeps the two from running the program twice.
      initial: true,
      knownSources: result.sourceFiles,
      onResult: (r, reason) => {
        if (!r.ok) {
          console.error(`[cyclops] re-trace failed (${reason}): ${r.error}`);
          return;
        }
        process.stdout.write(r.stdout ?? "");
        const s = summarize(r.tree.roots);
        const head = s.split("\n")[0];
        console.error(`[cyclops] ${reason} → ${head}`);
      },
      onError: (err, reason) => {
        console.error(`[cyclops] ${reason}: ${err}`);
      },
    });
    console.error(`[cyclops] watching ${controller.watchedFiles().length} file(s)`);
  }

  // --baseline <tree.json> answers "did my change help?", and --save-baseline
  // captures the run to compare against next time. Both are opt-in: saving a
  // baseline by default would quietly overwrite the reference the next run
  // compares to.
  if (baseline) {
    try {
      const { diffTrees, renderDiff } = await import("./diff.js");
      const previous = JSON.parse(readFileSync(baseline, "utf8"));
      process.stdout.write(
        renderDiff(diffTrees(previous.roots || [], result.tree.roots)) + "\n",
      );
    } catch (e) {
      console.error(`[cyclops] could not compare against ${baseline}: ${e.message}`);
    }
    process.exit(result.exitCode ?? 0);
  }

  // --summary/--tree/--flat print the trace as text and stop. The same
  // renderers the agent plugin and the HTTP views use, so the three surfaces
  // cannot disagree about what a trace says.
  if (format) {
    const roots = focus
      ? findFrames(result.tree.roots, focus).map((h) => h.frame)
      : result.tree.roots;
    process.stdout.write(
      format === "tree"
        ? renderTree(roots, { maxDepth: 20, timing: true })
        : format === "flat"
          ? renderFlat(roots, { timing: true })
          : summarize(roots, {
              focus,
              title: result.entry,
              droppedFrames: result.droppedFrames,
            }) + "\n",
    );
    process.exit(result.exitCode ?? 0);
  }

  // interactive runs serve until Ctrl+C; piped/CI runs never hang
  const shouldServe = !noServer && (process.stderr.isTTY || serve || watch);
  if (!shouldServe) process.exit(result.exitCode ?? 0);

  ensureBuild();
  const { url, server, close } = await startServer({
    port: port ?? DEFAULT_PORT,
    treePath: result.outFile,
  });
  console.error(`[cyclops] view the call tree at ${url}`);
  if (!noOpen) openBrowser(url);

  let exitCode = result.exitCode ?? 0;
  if (server) {
    console.error(
      watch
        ? "[cyclops] serving, and re-tracing on every change, until Ctrl+C ..."
        : "[cyclops] serving this tree until Ctrl+C ...",
    );
    exitCode = await waitForSignal();
    if (controller) controller.stop();
    await close();
  }
  process.exit(exitCode);
}

// The bridge: pick a function out of the map, give it arguments, trace it.
async function traceFnMain(argv) {
  const rest = argv.slice(1);
  if (!rest.length || rest.includes("--help") || rest.includes("-h")) {
    printTraceFnUsage();
    return;
  }

  const positional = rest.filter((a) => !a.startsWith("--"));
  const file = positional[0];
  const fn = positional[1];
  if (!file || !fn) {
    printTraceFnUsage();
    process.exit(1);
  }

  const args = [];
  let save = null;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--arg") {
      // Evaluated as JS so `--arg '"hello"'` and `--arg '[1,2]'` both mean what
      // they look like. The user typed this; it is not attacker input.
      args.push(evaluateLiteral(rest[++i]));
    } else if (rest[i] === "--save") save = rest[++i];
    else if (rest[i] === "--json") json = true;
  }

  const { harnessFor, callersInMap } = await import("./harness.js");
  const { buildMap } = await import("./map.js");

  const harness = harnessFor(resolve(process.cwd(), file), fn, {
    args: args.length ? args : null,
  });
  if (harness.error) {
    console.error(harness.error);
    process.exit(1);
  }

  // Real arguments from a real caller are the best input available, so say
  // where they could come from rather than leaving the guess unexplained.
  let callersNote = "";
  try {
    // The map covers the target's own project, not the cwd. Scanning cwd gave
    // "called by: main (test/fixtures/async.js:15)" for a file that has nothing
    // to do with that fixture -- confidently wrong, which is worse than silent.
    const projectRoot = dirname(resolve(process.cwd(), file));
    const map = buildMap(projectRoot, { maxFiles: 300 });
    const found = callersInMap(map, fn);
    if (found.callers.length) {
      const list = found.callers
        .slice(0, 5)
        .map((c) => `${c.name}${c.file ? ` (${c.file}:${c.line ?? "?"})` : ""}`)
        .join(", ");
      // Only worth saying when the harness did not already use a real call.
      callersNote =
        `  called by: ${list}\n` +
        (harness.confidence === "call-site"
          ? "  its arguments were replayed from one of those calls\n"
          : "  re-run with --arg to use a real call's arguments instead of a guess\n");
    } else if (found.note) {
      callersNote = `  ${found.note}\n`;
    }
  } catch {
    // the map is a convenience here, never a precondition
  }

  if (json) {
    process.stdout.write(JSON.stringify({
      function: harness.functionName,
      kind: harness.kind,
      confidence: harness.confidence,
      signature: harness.signature ?? null,
      notes: harness.notes,
      source: harness.source,
    }, null, 2) + "\n");
    return;
  }

  const harnessPath = save
    ? resolve(process.cwd(), save)
    : join(dirname(resolve(process.cwd(), file)), `.cyclops-fn-${fn}.mjs`);
  writeFileSync(harnessPath, harness.source);

  console.error(`[cyclops] harness for ${harness.functionName}() — confidence: ${harness.confidence}`);
  if (callersNote) process.stderr.write(callersNote);
  for (const note of harness.notes) console.error(`[cyclops] ${note}`);

  const result = traceToFile([harnessPath], { cwd: process.cwd() });
  try {
    unlinkSync(harnessPath);
  } catch {}

  if (!result.ok) {
    console.error(result.error || "could not trace it");
    process.exit(result.exitCode ?? 1);
  }

  process.stdout.write(result.stdout ?? "");
  process.stderr.write(
    renderTree(result.tree.roots, { maxDepth: 12, timing: true }) + "\n",
  );
  console.error(`[cyclops] trace written to ${result.outFile}`);
}

// Accepts a JS literal typed on the command line.
function evaluateLiteral(text) {
  try {
    return Function(`"use strict"; return (${text});`)();
  } catch {
    // Not a literal -- take it as a plain string rather than failing, so
    // `--arg someName` means the string rather than a syntax error.
    return text;
  }
}

// The static half of v2: read a project, write its map, optionally draw it.
async function mapMain(argv) {
  const opts = parseMapArgs(argv);
  if (opts.help || !opts.files.length) {
    printMapUsage();
    return;
  }

  const cwd = process.cwd();
  const target = opts.files[0];

  const { buildMap } = await import("./map.js");
  const { layoutMap } = await import("./maplayout.js");
  const { renderMapReport } = await import("./mapanalyze.js");
  const { renderMap, renderMapFlat } = await import("./maplayout.js");

  let map = buildMap(target, {
    cwd,
    maxFiles: opts.maxFiles,
    includeTests: opts.includeTests,
    includeExternal: opts.includeExternal,
  });
  if (map.error) {
    console.error(map.error);
    process.exit(1);
  }

  map = layoutMap(map);

  const outFile = opts.outFile ? resolve(cwd, opts.outFile) : join(cwd, "out", "map.json");
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(map, null, 2));

  if (opts.format === "edges") {
    process.stdout.write(renderMapFlat(map) + "\n");
  } else if (opts.format === "map") {
    process.stdout.write(renderMap(map) + "\n");
  } else {
    process.stdout.write(renderMapReport(map, { title: target }) + "\n");
  }

  console.error(`[cyclops] map written to ${outFile}`);

  if (opts.skipped && map.skipped.length) {
    console.error(
      `[cyclops] ${map.skipped.length} file(s) could not be parsed and are absent from the map`,
    );
  }
  if (map.truncated && map.truncationReason) {
    console.error(`[cyclops] ${map.truncationReason}`);
  }

  if (opts.open && !opts.noServer) {
    ensureBuild();
    const { url, server, close } = await startServer({
      port: opts.port ?? DEFAULT_PORT,
      treePath: outFile,
      mapPath: outFile,
    });
    console.error(`[cyclops] view the map at ${url}`);
    if (!server) return;
    await waitForSignal();
    await close();
    return;
  }
  // --open without a server means "print the URL and let the CLI die", which is
  // never what anyone wants; say so rather than silently ignoring the flag.
  if (opts.open) {
    console.error("[cyclops] --open needs the server; dropping --no-server");
  }
}

main().catch((e) => {
  console.error(`cyclops: ${e.message}`);
  process.exit(1);
});
