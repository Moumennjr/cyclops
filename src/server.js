#!/usr/bin/env node
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

function sendFile(res, file, cacheControl) {
  if (!existsSync(file)) return send(res, 404, "not found");
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    ...(cacheControl ? { "cache-control": cacheControl } : {}),
  });
  createReadStream(file).pipe(res);
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
export async function startServer({ port = 4600, treePath, distDir = DEFAULT_DIST } = {}) {
  const treeFile = treePath || resolve(process.cwd(), "out", "tree.json");
  const indexFile = join(distDir, "index.html");

  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");

    if (pathname === "/tree.json") {
      const tree = readTree(treeFile);
      return send(
        res,
        tree ? 200 : 404,
        tree ? JSON.stringify(tree) : JSON.stringify({ error: "no trace yet" }),
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

    if (pathname === "/whoami") {
      return send(
        res,
        200,
        JSON.stringify({ treePath: treeFile, port: server.address()?.port ?? null }),
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
