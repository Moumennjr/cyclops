#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { transform } from "./transform.js";
import { runtimeSource } from "./runtime.js";
import { splitTree, writeTree } from "./treeio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(HERE, "server.js");
const DEFAULT_PORT = 4600;
const VITE_ROOT = join(HERE, "..");

function urlPreview(url) {
  return String(url || "").replace(/\/$/, "");
}

function viteBin() {
  const rel = join(VITE_ROOT, "node_modules", "vite", "bin", "vite.js");
  try {
    return existsSync(rel) ? rel : null;
  } catch {
    return null;
  }
}

async function startViewer(url, { open = false, vite = true } = {}) {
  if (!vite) return false;
  if (!process.stderr.isTTY) return false;
  const bin = viteBin();
  if (!bin) return false樑;
  const child = spawn(
    process.execPath,
    [bin, "--config", join(VITE_ROOT, "vite.config.mjs")],
    {
      cwd: VITE_ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        CYCLOPS_DATA_PORT: String(new URL(url).port || DEFAULT_PORT),
        CYCLOPS_OPEN: open ? "1" : "0",
      },
    },
  );
  await new Promise((resolve) => {
    child.on("exit", resolve);
    child.on("error", resolve);
  });
  return true;
}

async function probe(url) {
  try {
    const res = await fetch(`${url}/whoami`);
    if (!res.ok) return { up: true, info: null };
    return { up: true, info: await res.json() };
  } catch {
    return { up: false, info: null };
  }
}

// the data server is a child of this CLI, not a detached daemon: when we stop
// (exit, Ctrl+C, terminal close) it stops too, so port 4600 can never leak.
let spawnedServer = null;

function reapServer() {
  if (!spawnedServer || spawnedServer.exitCode !== null) return;
  try {
    spawnedServer.kill("SIGKILL");
  } catch {}
}

process.on("exit", reapServer);
process.on("SIGINT", () => {
  reapServer();
  process.exit(130);
});
process.on("SIGTERM", () => {
  reapServer();
  process.exit(143);
});
process.on("SIGHUP", () => {
  reapServer();
  process.exit(129);
});

async function ensureServer(port, treePath) {
  for (let p = port; p < port + 20; p++) {
    const url = `http://localhost:${p}`;
    const { up, info } = await probe(url);
    if (up && info && info.treePath === treePath) return url;
    if (up) continue;

    spawnedServer = spawn(
      process.execPath,
      [SERVER_PATH, "--port", String(p), "--tree", treePath],
      { stdio: "ignore" },
    );
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const check = await probe(url);
      if (check.up && check.info && check.info.treePath === treePath) return url;
    }
    return url;
  }
  return `http://localhost:${port}`;
}

function parseArgs(argv) {
  let file = null;
  let port = null;
  let noServer = false;
  let noVite = false;
  let noOpen = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") port = Number(argv[++i]);
    else if (a.startsWith("--port=")) port = Number(a.slice("--port=".length));
    else if (a === "--no-server") noServer = true;
    else if (a === "--no-vite") noVite = true;
    else if (a === "--no-open") noOpen = true;
    else if (a === "--help" || a === "-h") { help = true; continue; }
    else if (!a.startsWith("-")) file = a;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return {file, port, noServer, noVite, noOpen, help};
}

function printUsage() {
  console.log(`usage: cyclops <file.js> [--port N] [--no-server]
  instruments <file.js>, runs it, writes the call tree to out/tree.json,
  and serves it at http://localhost:${DEFAULT_PORT} (default port).`);
}

async function main() {
  const {file, port, noServer, noVite, noOpen, help} = parseArgs(process.argv.slice(2));
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

  if (!noServer) {
    const url = await ensureServer(port ?? DEFAULT_PORT, outFile);
    console.error(`[cyclops] view the call tree at ${url}`);
    const viewerRan = await startViewer(urlPreview(url), { open: !noOpen, vite: !noVite });
    if (!viewerRan && spawnedServer && spawnedServer.exitCode === null && process.stderr.isTTY) {
      console.error("[cyclops] serving this tree until Ctrl+C ...");
      await new Promise((done) => spawnedServer.once("exit", done));
    }
  }

  process.exit(res.status ?? 0);
}

main().catch((e) => {
  console.error(`cyclops: ${e.message}`);
  process.exit(1);
});