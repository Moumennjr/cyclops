import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer as netServer } from "node:net";

import { transform } from "../src/transform.js";
import { runtimeSource, CYC_MARKER } from "../src/runtime.js";
import { splitTree, writeTree } from "../src/treeio.js";
import {
  computeStats,
  fmt,
  describeFrame,
  toFlowModel,
  buildTreeIndex,
  subtreeIds,
  edgesBySource,
} from "../src/public/flow-model.js";
import { startServer } from "../src/server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");

function runInstrumented(source) {
  const { code } = transform(source, { filename: "<test>" });
  const dir = mkdtempSync(join(tmpdir(), "cyc-unit-"));
  const file = join(dir, "prog.mjs");
  writeFileSync(file, runtimeSource() + "\n" + code);
  const res = spawnSync(process.execPath, [file], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return res;
}

function runCli(fixture, args = []) {
  const cwd = mkdtempSync(join(tmpdir(), "cyc-cwd-"));
  const res = spawnSync(process.execPath, [CLI, fixture, "--no-server", ...args], {
    cwd,
    encoding: "utf8",
  });
  const treeFile = join(cwd, "out", "tree.json");
  const tree = existsSync(treeFile)
    ? JSON.parse(readFileSync(treeFile, "utf8"))
    : null;
  rmSync(cwd, { recursive: true, force: true });
  return { res, tree };
}

test("transform instruments sync functions, skips async with warning", () => {
  const { code, warnings } = transform(
    `function f(a){ return a + 1; } async function g(){}`,
    { filename: "x.js" },
  );
  assert.match(code, /__enter\("f"/);
  assert.match(code, /__ret\(_cyc, a \+ 1\)/);
  assert.ok(!code.includes('__enter("g"'));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].name, "g");
  assert.equal(warnings[0].reason, "async function");
});

test("runtime builds a correct nested tree from executed code", () => {
  const src = `
    function outer(x){ return inner(x) + 1; }
    function inner(x){ return x * 2; }
    outer(5);
  `;
  const res = runInstrumented(src);
  assert.equal(res.status, 0);
  const { tree, userText } = splitTree(res.stderr);
  assert.ok(tree, "tree should be present");
  assert.equal(userText, "");
  assert.equal(tree.roots.length, 1);
  const outer = tree.roots[0];
  assert.equal(outer.name, "outer");
  assert.deepEqual(outer.args, [5]);
  assert.equal(outer.return, 11);
  assert.equal(outer.error, null);
  assert.equal(outer.children.length, 1);
  assert.equal(outer.children[0].name, "inner");
  assert.equal(outer.children[0].return, 10);
});

test("escaping errors are recorded on frames and exit code is non-zero", () => {
  const src = `function a(){ b(); } function b(){ throw new Error("boom"); } a();`;
  const res = runInstrumented(src);
  assert.notEqual(res.status, 0);
  const { tree } = splitTree(res.stderr);
  assert.ok(tree, "tree captured even when the program crashes");
  const a = tree.roots[0];
  assert.equal(a.name, "a");
  assert.equal(a.error.name, "Error");
  assert.equal(a.children[0].error.message, "boom");
});

test("splitTree extracts the marked payload and keeps user stderr", () => {
  const userText = "warn: something happened\ntail";
  const text =
    userText + CYC_MARKER + JSON.stringify({ roots: [] }) + CYC_MARKER;
  const { tree, userText: kept } = splitTree(text);
  assert.deepEqual(tree, { roots: [] });
  assert.equal(kept, userText);
  assert.equal(splitTree("no marker anywhere").tree, null);
});

test("writeTree stamps version and generatedAt", () => {
  const dir = mkdtempSync(join(tmpdir(), "cyc-wt-"));
  const file = join(dir, "tree.json");
  writeTree(file, { roots: [{ name: "x" }] });
  const j = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(typeof j.version, "number");
  assert.equal(typeof j.generatedAt, "string");
  assert.equal(j.roots[0].name, "x");
  rmSync(dir, { recursive: true, force: true });
});

test("fmt renders tagged snapshots readably", () => {
  assert.equal(fmt({ type: "circular" }), "[Circular]");
  assert.equal(fmt({ type: "function", name: "go" }), "fn go");
  assert.equal(fmt({ type: "…", length: 200 }), "…200 more");
  assert.equal(fmt([1, "a", { type: "circular" }]), '[1, "a", [Circular]]');
  assert.equal(
    fmt({ type: "string", value: "hello world", length: 100 }),
    '"hello world"…',
  );
});

test("cli traces a fixture end to end", () => {
  const fixture = join(HERE, "fixtures", "nested.js");
  const { res, tree } = runCli(fixture);
  assert.equal(res.status, 0);
  assert.ok(tree, "out/tree.json should exist");
  assert.equal(typeof tree.version, "number");
  const names = tree.roots.map((r) => r.name);
  assert.ok(names.includes("fib"), "expected fib root");
  assert.ok(names.includes("greet"), "expected greet root");
  const fib = tree.roots.find((r) => r.name === "fib");
  assert.equal(fib.return, 5, "fib(5) should return 5");
  assert.ok(fib.children.length > 0, "fib should recurse");
  assert.match(res.stdout, /fib\(5\) = 5/);
});

test("cli preserves non-zero exit and still emits a tree on crash", () => {
  const fixture = join(HERE, "fixtures", "errors.js");
  const { res, tree } = runCli(fixture);
  assert.notEqual(res.status, 0);
  assert.ok(tree, "partial tree captured despite the crash");
  assert.match(res.stderr, /Error: boom/);
  const outer = tree.roots[0];
  assert.equal(outer.name, "outer");
  assert.equal(outer.children[0].name, "inner");
  assert.equal(outer.children[0].error.message, "boom");
});

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = netServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

async function waitForFetch(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {}
  }
  return null;
}

test("computeStats aggregates call counts and depth", () => {
  const roots = [
    {
      name: "a",
      args: [],
      return: 1,
      error: null,
      children: [{ name: "b", args: [], return: 2, error: null, children: [] }],
    },
  ];
  const stats = computeStats(roots);
  assert.equal(stats.calls, 2);
  assert.equal(stats.maxDepth, 2);
  assert.equal(stats.roots, 1);
});

test("toFlowModel emits nodes in call order, parent before child", () => {
  const roots = [
    {
      name: "a",
      args: [],
      return: 1,
      error: null,
      children: [
        { name: "a1", args: [], return: 1, error: null, children: [
          { name: "a2", args: [], return: 2, error: null, children: [] },
        ] },
        { name: "a3", args: [], return: 3, error: null, children: [] },
      ],
    },
    { name: "b", args: [], return: 4, error: null, children: [] },
  ];
  const { nodes, edges, byId } = toFlowModel(roots, null);
  const order = nodes.map((n) => n.data.name);
  assert.deepEqual(order, ["a", "a1", "a2", "a3", "b"], "pre-order DFS = real call order");
  assert.equal(nodes.length, 5);
  assert.equal(edges.length, 3, "one edge per non-root frame");
  for (const e of edges) {
    const src = Number(e.source.slice(1));
    const tgt = Number(e.target.slice(1));
    assert.ok(src < tgt, `edge ${e.id} must go from earlier to later frame`);
  }
  assert.equal(byId.get("n3").name, "a2");
  assert.equal(nodes[0].data.error, false);
});

test("describeFrame reports return values, args, and errors", () => {
  const ok = describeFrame({ name: "f", args: [1, "x"], return: 42, error: null });
  assert.equal(ok.name, "f");
  assert.equal(ok.error, null);
  assert.equal(ok.rows[0].key, "return");
  assert.equal(ok.rows[0].value, "42");

  const bad = describeFrame({ name: "g", args: [], error: { name: "TypeError", message: "nope" } });
  assert.equal(bad.error, "TypeError: nope");
  assert.equal(bad.rows[0].key, "error");
  assert.equal(bad.rows[0].err, true);

  const esc = describeFrame({ name: "a<b>&c", args: [], return: 1, error: null });
  assert.equal(esc.name, "a&lt;b&gt;&amp;c", "names are html-escaped");
});

test("reveal gating: subtree walk and outgoing edges by source", () => {
  const edges = ["n1 --> n2", "n1 --> n3", "n2 --> n4"];
  const index = buildTreeIndex(edges);
  assert.deepEqual([...index.children.get("n1")], ["n2", "n3"]);
  assert.equal(index.parent.get("n4"), "n2");

  assert.deepEqual([...subtreeIds("n2", index)], ["n4"], "descendants, not self");
  assert.equal(subtreeIds("n3", index).size, 0, "leaf has no subtree");

  const bySrc = edgesBySource(edges, index);
  assert.deepEqual(bySrc.get("n1"), ["n1 --> n2", "n1 --> n3"]);
  assert.deepEqual(bySrc.get("n2"), ["n2 --> n4"]);
  assert.equal(bySrc.get("n3"), undefined, "no outgoing edges, no bucket");
});

test("server serves the tree file passed via --tree and advertises it in /whoami", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cyc-srv-"));
  const treeFile = join(dir, "tree.json");
  writeTree(treeFile, { roots: [{ name: "z" }] });
  const port = await getFreePort();
  const child = spawn(
    process.execPath,
    [join(HERE, "..", "src", "server.js"), "--port", String(port), "--tree", treeFile],
    { stdio: "ignore" },
  );
  try {
    const whoami = await waitForFetch(`http://localhost:${port}/whoami`);
    assert.ok(whoami, "server should come up");
    const info = await whoami.json();
    assert.equal(info.treePath, treeFile);
    assert.equal(info.port, port);

    const version = await (
      await waitForFetch(`http://localhost:${port}/version`)
    ).json();
    assert.equal(typeof version.version, "number");
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startServer serves the built viewer and 503s with instructions when missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cyc-www-"));
  try {
    const distDir = join(dir, "dist");
    mkdirSync(join(distDir, "assets"), { recursive: true });
    writeFileSync(
      join(distDir, "index.html"),
      '<!doctype html><html><body><script type="module" src="/assets/app.js"></script></body></html>',
    );
    writeFileSync(join(distDir, "assets", "app.js"), "console.log(1)");
    const treeFile = join(dir, "tree.json");
    writeTree(treeFile, { roots: [{ name: "z" }] });

    const started = await startServer({ port: await getFreePort(), treePath: treeFile, distDir });
    try {
      const page = await fetch(`${started.url}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type"), /text\/html/);
      assert.match(await page.text(), /\/assets\/app\.js/);

      const asset = await fetch(`${started.url}/assets/app.js`);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get("content-type"), /javascript/);

      assert.equal((await fetch(`${started.url}/vite.html`)).status, 200, "old links keep working");

      const info = await (await fetch(`${started.url}/whoami`)).json();
      assert.equal(info.treePath, treeFile);
      assert.equal(info.port, started.port);

      const tree = await (await fetch(`${started.url}/tree.json`)).json();
      assert.equal(tree.roots[0].name, "z");
    } finally {
      await started.close();
    }

    // no dist/ at all: trace endpoints still work, the page explains how to build
    const bare = await startServer({
      port: await getFreePort(),
      treePath: treeFile,
      distDir: join(dir, "missing"),
    });
    try {
      const page = await fetch(`${bare.url}/`);
      assert.equal(page.status, 503);
      assert.match(await page.text(), /npm run build/);
      assert.equal((await fetch(`${bare.url}/tree.json`)).status, 200);
      assert.equal((await fetch(`${bare.url}/assets/app.js`)).status, 404);
    } finally {
      await bare.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});