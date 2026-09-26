#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { transform } from "./transform.js";
import { runtimeSource } from "./runtime.js";
import { splitTree, writeTree } from "./treeio.js";
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
  let file = null;
  let port = null;
  let noServer = false;
  let noOpen = false;
  let serve = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") port = Number(argv[++i]);
    else if (a.startsWith("--port=")) port = Number(a.slice("--port=".length));
    else if (a === "--no-server") noServer = true;
    else if (a === "--no-open") noOpen = true;
    else if (a === "--serve") serve = true;
    else if (a === "--no-vite") continue; // deprecated no-op: the viewer ships built
    else if (a === "--help" || a === "-h") { help = true; continue; }
    else if (!a.startsWith("-")) file = a;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return {file, port, noServer, noOpen, serve, help};
}

function printUsage() {
  console.log(`usage: cyclops <file.js> [--port N] [--serve] [--no-server] [--no-open]
  instruments <file.js>, runs it, writes the call tree to out/tree.json,
  and serves the viewer at http://localhost:${DEFAULT_PORT} until Ctrl+C
  (--serve forces serving in non-interactive runs).`);
}

async function main() {
  const {file, port, noServer, noOpen, serve, help} = parseArgs(process.argv.slice(2));
  if (help || !file) {
    printUsage();
    process.exit(help ? 0 : 1);
  }

  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch (e) {
    console.error(`cyclops: cannot read ${file}: ${e.message}`);
    process.exit(1);
  }

  let result;
  try {
    result = transform(source, { filename: file });
  } catch (e) {
    console.error(`cyclops: transform failed: ${e.message}`);
    process.exit(1);
  }

  for (const w of result.warnings) {
    console.warn(
      `[cyclops] skipped ${w.reason} "${w.name}" at ${w.file}:${w.line}`,
    );
  }

  const tmp = join(tmpdir(), `cyclops-${basename(file)}-${process.pid}.mjs`);
  writeFileSync(tmp, runtimeSource() + "\n" + result.code);

  let res;
  try {
    res = spawnSync(process.execPath, [tmp], { encoding: "utf8" });
  } catch (e) {
    console.error(`cyclops: failed to run instrumented file: ${e.message}`);
    process.exit(1);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }

  process.stdout.write(res.stdout ?? "");

  const stderrText = res.stderr ?? "";
  const { tree, userText } = splitTree(stderrText);
  process.stderr.write(userText);

  if (!tree) {
    console.error("[cyclops] no trace captured (no instrumented call ran)");
    process.exit(res.status ?? 1);
  }

  const outFile = resolve(process.cwd(), "out", "tree.json");
  writeTree(outFile, tree);
  console.error(`[cyclops] trace written to ${outFile}`);

  // interactive runs serve until Ctrl+C; piped/CI runs never hang
  const shouldServe = !noServer && (process.stderr.isTTY || serve);
  if (!shouldServe) process.exit(res.status ?? 0);

  ensureBuild();
  const { url, server, close } = await startServer({
    port: port ?? DEFAULT_PORT,
    treePath: outFile,
  });
  console.error(`[cyclops] view the call tree at ${url}`);
  if (!noOpen) openBrowser(url);

  let exitCode = res.status ?? 0;
  if (server) {
    console.error("[cyclops] serving this tree until Ctrl+C ...");
    exitCode = await waitForSignal();
    await close();
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(`cyclops: ${e.message}`);
  process.exit(1);
});
