import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer as netServer } from "node:net";

import { transform } from "../src/transform.js";
import { runtimeSource, CYC_MARKER } from "../src/runtime.js";
import { splitTree, writeTree } from "../src/treeio.js";
import { buildGraph, computeStats, fmt } from "../src/public/app.js";

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

test("buildGraph emits nodes, edges, and error styling", () => {
  const roots = [
    {
      name: "a",
      args: ["x"],
      return: 1,
      error: null,
      children: [
        {
          name: "b",
          args: [],
          return: { type: "undefined" },
          error: { name: "Error", message: "boom" },
          children: [],
        },
      ],
    },
  ];
  const graph = buildGraph(roots);
  assert.match(graph, /^flowchart TD/);
  assert.match(graph, /n1 --> n2/);
  assert.match(graph, /✗ Error: boom/);
  assert.match(graph, /class n2 err;/);
});

test("buildGraph escapes mermaid syntax characters in labels", () => {
  const roots = [
    {
      name: "obj",
      args: [{ a: 1 }],
      return: { message: "hi", wordCount: 2 },
      error: null,
      children: [
        {
          name: "spl",
          args: [],
          return: ["x", "y"],
          error: { name: "TypeError", message: "not <a> [fn]" },
          children: [],
        },
      ],
    },
  ];
  const graph = buildGraph(roots);
  const labels = graph.split("\n").filter((l) => /n\d/.test(l));
  for (const line of labels) {
    const body = line.slice(line.indexOf('["') + 2, line.lastIndexOf('"]'));
    assert.ok(
      !/[\[\]{}]/.test(body),
      `label must not contain raw mermaid syntax: ${line}`,
    );
    assert.ok(!/["|]/.test(body), `label must escape quotes/pipes: ${line}`);
  }
  assert.match(graph, /&#123;|&#91;/, "special chars should be entity-encoded");
});

test("mermaid parser accepts generated graphs (real parser, jsdom)", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  global.window = dom.window;
  global.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({ startOnLoad: false });

  const { tree } = runCli(join(HERE, "fixtures", "nested.js"));
  await mermaid.parse(buildGraph(tree.roots));

  const harsh = [
    {
      name: "a[name]{b}|p\\q",
      args: [{ a: "v" }, [1, { x: "y" }], "new\nline&<html>\"q\""],
      return: "{ok} [yes]",
      error: null,
      children: [
        {
          name: "err[fn]",
          args: [],
          return: { type: "undefined" },
          error: { name: "TypeError", message: "x is not <a function>" },
          children: [],
        },
      ],
    },
  ];
  await mermaid.parse(buildGraph(harsh));
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