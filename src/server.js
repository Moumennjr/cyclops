#!/usr/bin/env node
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, "public");
const TREE_FILE = () => resolve(process.cwd(), "out", "tree.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function readTree() {
  const file = TREE_FILE();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

function sendFile(res, file) {
  if (!existsSync(file)) return send(res, 404, "not found");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");

  if (pathname === "/" || pathname === "/index.html")
    return sendFile(res, join(PUBLIC_DIR, "index.html"));
  if (pathname === "/app.js") return sendFile(res, join(PUBLIC_DIR, "app.js"));

  if (pathname === "/tree.json") {
    const tree = readTree();
    return send(
      res,
      tree ? 200 : 404,
      tree ? JSON.stringify(tree) : JSON.stringify({ error: "no trace yet" }),
      { "content-type": "application/json; charset=utf-8" },
    );
  }

  if (pathname === "/version") {
    const tree = readTree();
    return send(
      res,
      200,
      JSON.stringify({ version: tree ? tree.version : 0 }),
      { "content-type": "application/json; charset=utf-8" },
    );
  }

  send(res, 404, "not found");
});

function main() {
  const idx = process.argv.indexOf("--port");
  const port = Number(idx !== -1 ? process.argv[idx + 1] : 4600);
  server.listen(port, () => {
    console.error(`[cyclops] server http://localhost:${port}`);
  });
}

main();