#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { traceToFile } from "./engine.js";
import { watchTrace } from "./watch.js";
import { summarize } from "./analyze.js";
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

function parseArgs(argv) {
  const files = [];
  let port = null;
  let noServer = false;
  let noOpen = false;
  let serve = false;
  let watch = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") port = Number(argv[++i]);
    else if (a.startsWith("--port=")) port = Number(a.slice("--port=".length));
    else if (a === "--no-server") noServer = true;
    else if (a === "--no-open") noOpen = true;
    else if (a === "--serve") serve = true;
    else if (a === "--watch") watch = true;
    else if (a === "--no-vite") continue; // deprecated no-op: the viewer ships built
    else if (a === "--help" || a === "-h") { help = true; continue; }
    else if (!a.startsWith("-")) files.push(a);
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return {files, port, noServer, noOpen, serve, watch, help};
}

function printUsage() {
  console.log(`usage: cyclops <file|dir|glob> [more...] [--port N] [--serve] [--watch] [--no-server] [--no-open]

  traces a file, a directory or a glob, writes the call tree to out/tree.json,
  and serves the viewer at http://localhost:${DEFAULT_PORT} until Ctrl+C
  (--serve forces serving in non-interactive runs).

  targets:
    cyclops app.js              one file
    cyclops src/                every traceable file in a directory
    cyclops "src/**/*.ts"       a glob
    cyclops a.js b.ts           the first is the entry, the rest are
                                instrumented so its imports resolve

  --watch re-traces on every change to the program, not just the entry, and
  keeps serving; the viewer already picks the new trace up by itself.

  traced dialects: .js .mjs .cjs .jsx .ts .mts .cts .tsx
  (generators, decorators, top-level await, private fields and async/await are
  all traced; compiler helpers are kept out of the tree)

  the entry must be a module: bare scripts with no import or require are still
  instrumented, but everything they call has to live in that one file.`);
}

async function main() {
  const {files, port, noServer, noOpen, serve, watch, help} = parseArgs(process.argv.slice(2));
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

main().catch((e) => {
  console.error(`cyclops: ${e.message}`);
  process.exit(1);
});
