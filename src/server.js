#!/usr/bin/env node
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderTree, renderFlat, aggregate } from "./render.js";
import { flattenForEditor } from "./editor.js";
import { summarize, findFrames, stats, errorReport } from "./analyze.js";
import { renderMap, renderMapFlat } from "./maplayout.js";
import { renderMapReport } from "./mapanalyze.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = join(here, "..", "dist");

function argValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

const BUILD_HINT = [
  "<!doctype html>",
  '<meta charset="utf-8" />',
  "<title>Cyclops — viewer not built</title>",
  "<style>",
  'body{font-family:ui-sans-serif,system-ui,sans-serif;background:#fff;color:#1e293b;padding:60px 24px;text-align:center}',
  "code{background:#f1f5f9;padding:2px 6px;border-radius:5px;color:#0369a1}",
  "</style>",
  "<h1>The viewer has not been built yet</h1>",
  "<p>The call tree is being served, but the viewer bundle is missing.</p>",
  "<p>Build it once with: <code>npm install && npm run build</code></p>",
  "",
].join("\n");

function readTree(treeFile) {
  if (!existsSync(treeFile)) return null;
  try {
    return JSON.parse(readFileSync(treeFile, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Reads a JSON file, distinguishing the three states that matter.
 *
 * readTree() collapses "not there" and "there but corrupt" into the same null,
 * so a truncated map.json -- a half-written file, a merge conflict marker, an
 * interrupted write -- is served as 404 {"error": "no map yet"}. The reader is
 * told to go and run `cyclops map .`, which will overwrite whatever was there.
 * That is a wrong instruction sent in response to a recoverable problem.
 *
 * Returns { status: "ok" | "absent" | "broken", data, error }.
 */
function readJsonFile(file) {
  if (!existsSync(file)) return { status: "absent", data: null, error: null };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return { status: "broken", data: null, error: e.message };
  }
  if (!text.trim()) {
    return { status: "broken", data: null, error: "file is empty" };
  }
  try {
    return { status: "ok", data: JSON.parse(text), error: null };
  } catch (e) {
    return { status: "broken", data: null, error: e.message };
  }
}

// The status a client sees, per artefact. 200 is only ever a real artefact.
function artifactStatus(result) {
  return result.status === "ok" ? 200 : 404;
}

function artifactBody(result, what, hint) {
  if (result.status === "ok") return JSON.stringify(result.data);
  if (result.status === "absent") {
    return JSON.stringify({ error: `no ${what} yet`, hint });
  }
  return JSON.stringify({
    error: `the ${what} is unreadable`,
    detail: result.error,
    // Do not say "run cyclops map ." here: that overwrites the file and the
    // damaged content might still be worth looking at.
    hint: `${hint} -- but this file exists and does not parse, so it is not simply absent`,
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

function sendFile(res, file, cacheControl) {
  if (!existsSync(file)) return send(res, 404, "not found");

  // A directory (e.g. a request for "/assets/") makes createReadStream emit
  // EISDIR, and piping that with no error listener takes the whole server down
  // with an unhandled 'error' event. This check has to come *before* writeHead:
  // sending 404 afterwards would mean writing headers twice.
  try {
    if (statSync(file).isDirectory()) return send(res, 404, "not found");
  } catch {
    return send(res, 404, "not found");
  }

  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    ...(cacheControl ? { "cache-control": cacheControl } : {}),
  });

  // A file can still fail mid-stream (permissions, a race with a rebuild), so
  // the listener stays even though the directory case is now handled above.
  const stream = createReadStream(file);
  stream.on("error", () => {
    try {
      res.end();
    } catch {
      // the response is already gone; nothing useful to do
    }
  });
  stream.pipe(res);
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

function listen(server, port) {
  return new Promise((done) => {
    const onError = () => done(false);
    server.once("error", onError);
    server.listen(port, () => {
      server.removeListener("error", onError);
      done(true);
    });
  });
}

// Starts (or reuses) the viewer + trace server. Reuses an existing instance
// serving the same tree, otherwise takes the first free port from `port`.
export async function startServer({
  port = 4600, treePath, distDir = DEFAULT_DIST, mapPath = null,
} = {}) {
  const treeFile = treePath || resolve(process.cwd(), "out", "tree.json");
  // The map is optional. A trace server with no map answers 404 rather than
  // guessing, so the viewer can tell "no map yet" from "no trace yet" -- two
  // very different states for a page that shows both.
  const mapFile = mapPath || resolve(process.cwd(), "out", "map.json");
  const indexFile = join(distDir, "index.html");

  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");

    if (pathname === "/tree.json") {
      const tree = readJsonFile(treeFile);
      return send(
        res,
        artifactStatus(tree),
        artifactBody(tree, "trace", "run: cyclops <file>"),
        { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      );
    }

    // The static project map: what the codebase looks like, without running it.
    if (pathname === "/map.json") {
      const map = readJsonFile(mapFile);
      return send(
        res, artifactStatus(map), artifactBody(map, "map", "run: cyclops map ."),
        { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      );
    }

    if (pathname === "/version") {
      const tree = readTree(treeFile);
      return send(
        res,
        200,
        JSON.stringify({ version: tree ? tree.version : 0 }),
        { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      );
    }

    // Text views of the same tree, for anything that is not the browser:
    // a terminal, an editor, a script, an agent. The viewer gets /tree.json;
    // these are the shapes the rest of the world needs.
    if (pathname === "/summary" || pathname === "/tree" || pathname === "/flat") {
      const tree = readTree(treeFile);
      if (!tree) {
        return send(res, 404, JSON.stringify({ error: "no trace yet" }), {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
      }
      const params = new URL(req.url, "http://localhost").searchParams;
      const focus = params.get("focus");
      const roots = focus
        ? findFrames(tree.roots, focus).map((h) => h.frame)
        : tree.roots;

      const body =
        pathname === "/summary"
          ? summarize(roots, {
            focus,
            title: treePath,
            droppedFrames: tree.droppedFrames || 0,
          })
          : pathname === "/tree"
            ? renderTree(roots, {
              maxDepth: Number(params.get("maxDepth") || 12),
              timing: params.get("timing") !== "0",
            })
            : renderFlat(roots, { timing: params.get("timing") !== "0" });

      return send(res, 200, body, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
    }

    // JSON forms of the same views, for a consumer that wants the same
    // content machine-readable rather than as text.
    if (pathname === "/summary.json" || pathname === "/flat.json") {
      const tree = readTree(treeFile);
      if (!tree) {
        return send(res, 404, JSON.stringify({ error: "no trace yet" }), {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
      }
      const params = new URL(req.url, "http://localhost").searchParams;
      const focus = params.get("focus");
      const roots = focus
        ? findFrames(tree.roots, focus).map((h) => h.frame)
        : tree.roots;

      const payload =
        pathname === "/summary.json"
          ? { stats: stats(roots), aggregate: aggregate(roots), errors: errorReport(roots) }
          : {
            frames: flattenForEditor(roots).map((f) => ({
              name: f.name, depth: f.depth, duration: f.dur,
            })),
          };
      return send(res, 200, JSON.stringify(payload, null, 2), {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
    }

    // Text views of the map, mirroring the tree's /summary and /tree.
    if (pathname === "/map.txt" || pathname === "/map.report" ||
        pathname === "/map.edges") {
      const map = readJsonFile(mapFile);
      if (map.status !== "ok") {
        return send(
          res,
          404,
          map.status === "broken"
            ? `the map at ${mapFile} is unreadable: ${map.error}\n` +
              `It exists but does not parse -- not the same as never having run ` +
              `cyclops map. Delete or repair it, then re-run.`
            : `no map yet; run: cyclops map .`,
          { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        );
      }
      const mapData = map.data;
      const params = new URL(req.url, "http://localhost").searchParams;
      const focus = params.get("focus");
      const body =
        pathname === "/map.txt"
          ? renderMap(mapData)
          : pathname === "/map.edges"
            ? renderMapFlat(mapData)
            : renderMapReport(mapData, { title: focus ? `focus: ${focus}` : null });
      return send(res, 200, body, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
    }

    if (pathname === "/whoami") {
      return send(
        res,
        200,
        JSON.stringify({
          treePath: treeFile,
          treeStatus: readJsonFile(treeFile).status,
          // Absent rather than a path that does not exist: the viewer's mode
          // switch needs to tell "no map yet" from "map at some path".
          mapPath: existsSync(mapFile) ? mapFile : null,
          mapStatus: readJsonFile(mapFile).status,
          port: server.address()?.port ?? null,
        }),
        { "content-type": "application/json; charset=utf-8" },
      );
    }

    // the built viewer: React Flow page at /, hashed bundles under /assets
    if (pathname === "/" || pathname === "/index.html" || pathname === "/vite.html") {
      if (!existsSync(indexFile)) {
        return send(res, 503, BUILD_HINT, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
      }
      return sendFile(res, indexFile, "no-store");
    }

    if (pathname.startsWith("/assets/")) {
      const file = join(distDir, pathname.slice(1));
      if (!file.startsWith(distDir)) return send(res, 404, "not found");
      return sendFile(res, file, "public, max-age=31536000, immutable");
    }

    send(res, 404, "not found");
  });

  for (let p = port; p < port + 20; p++) {
    const url = `http://localhost:${p}`;
    const { up, info } = await probe(url);
    if (up && info && info.treePath === treeFile) {
      server.close();
      return { url, port: p, server: null, close: async () => {} };
    }
    if (up) continue;
    if (await listen(server, p)) {
      return {
        url,
        port: p,
        server,
        // destroy open connections, otherwise close() waits forever on the
        // viewer's keep-alive polls and Ctrl+C never exits
        close: () =>
          new Promise((done) => {
            server.close(done);
            server.closeAllConnections?.();
          }),
      };
    }
  }
  server.close();
  return { url: `http://localhost:${port}`, port, server: null, close: async () => {} };
}

// `node src/server.js --port N --tree F` still runs a standalone instance.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const started = await startServer({
    port: Number(argValue("port") || 4600),
    treePath: argValue("tree") || undefined,
  });
  console.error(`[cyclops] server ${started.url}`);
}
