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
import { parse } from "@babel/parser";
import { runtimeSource, CYC_MARKER } from "../src/runtime.js";
import { splitTree, writeTree } from "../src/treeio.js";
import {
  computeStats,
  fmt,
  fmtDur,
  fmtAt,
  clock,
  frameTime,
  traceSpan,
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
  const { code, warnings } = transform(source, { filename: "<test>" });
  const dir = mkdtempSync(join(tmpdir(), "cyc-unit-"));
  const file = join(dir, "prog.mjs");
  writeFileSync(file, runtimeSource() + "\n" + code);
  const res = spawnSync(process.execPath, [file], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return { ...res, warnings, code };
}

// run a minimal program and hand back the tree it captured
function runTree(source) {
  const out = runInstrumented(source);
  const { tree, userText } = splitTree(out.stderr);
  return { res: out, warnings: out.warnings, code: out.code, tree, userText };
}

// every frame with this name, anywhere in the tree (execution order)
function findFrames(frames, name) {
  const out = [];
  const walk = (list) => {
    for (const f of list || []) {
      if (f.name === name) out.push(f);
      walk(f.children);
    }
  };
  walk(frames);
  return out;
}

// the same program with nothing done to it: the baseline for comparing
// behaviour (Rule 3 — instrumentation must not change what the program does)
function runPlain(source) {
  const dir = mkdtempSync(join(tmpdir(), "cyc-plain-"));
  const file = join(dir, "prog.mjs");
  writeFileSync(file, source);
  const res = spawnSync(process.execPath, [file], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return res;
}

// first frame with this name
function findFrame(frames, name) {
  return findFrames(frames, name)[0] || null;
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

test("arrow functions are traced under the name they are known by", () => {
  const src = `
    const add = (a, b) => { return a + b; };
    const sq = (x) => x * x;
    add(2, 3);
    sq(5);
  `;
  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "sync arrows must not be skipped");
  assert.equal(res.status, 0);
  assert.ok(tree, "tree captured");
  assert.equal(tree.roots.length, 2, "each top-level arrow call is a root");

  const add = findFrame(tree.roots, "add");
  assert.ok(add, "block-bodied arrow traced");
  assert.equal(add.return, 5);
  assert.equal(add.error, null);

  const sq = findFrame(tree.roots, "sq");
  assert.ok(sq, "expression-bodied arrow traced");
  assert.equal(sq.return, 25);
  assert.equal(sq.endedAt - sq.startedAt >= 0, true, "expression arrow still records timing");
});

test("function expressions take the name they are known by", () => {
  const src = `
    const anon = function (x) { return x + 1; };
    const named = function inner(n) { return n < 1 ? n : inner(n - 1); };
    const viaIife = (function () { return 7; })();
    anon(1);
    named(3);
  `;
  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "sync expressions must not be skipped");
  assert.equal(res.status, 0);
  assert.ok(tree, "tree captured");

  const anon = findFrame(tree.roots, "anon");
  assert.ok(anon, "anonymous expression named after its variable");
  assert.equal(anon.return, 2);

  const named = findFrame(tree.roots, "inner");
  assert.ok(named, "named expression keeps its own name");
  assert.equal(named.return, 0, "self-reference keeps working after wrapping");

  const iife = findFrame(tree.roots, "anonymous");
  assert.ok(iife, "call of a bare function expression falls back to anonymous");
  assert.equal(iife.return, 7);

  const innerCalls = findFrames(tree.roots, "inner");
  assert.equal(innerCalls.length, 4, "inner(3) down to inner(0) = one frame each");
});

test("object and class methods are traced under their method names", () => {
  const src = `
    const api = {
      greet(who) { return "hi " + who; },
      noop() {},
    };
    class Box {
      read() { return 42; }
    }
    api.greet("al");
    api.noop();
    new Box().read();
  `;
  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "methods must not be skipped");
  assert.equal(res.status, 0);
  assert.ok(tree, "tree captured");
  assert.equal(tree.roots.length, 3);

  const greet = findFrame(tree.roots, "greet");
  assert.ok(greet, "method shorthand traced");
  assert.equal(greet.return, "hi al");

  const noop = findFrame(tree.roots, "noop");
  assert.ok(noop, "method with no return traced");
  assert.equal(fmt(noop.return), "undefined", "implicit return is undefined");

  const read = findFrame(tree.roots, "read");
  assert.ok(read, "class method traced");
  assert.equal(read.return, 42);
});

test("every return path records the value that was actually returned", () => {
  const src = `
    function noReturn(x) { const y = x + 1; }
    function early(c) { if (c) return "yes"; return "no"; }
    function loopReturn(n) { for (let i = 0; i < 10; i++) { if (i === n) return i; } return -1; }
    function onlyInIf(c) { if (c) { return 1; } }
    noReturn(1);
    early(true);
    early(false);
    loopReturn(3);
    loopReturn(99);
    onlyInIf(true);
    onlyInIf(false);
  `;
  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "sync functions must not be skipped");
  assert.equal(res.status, 0);
  assert.ok(tree, "tree captured");

  const returns = (name) => findFrames(tree.roots, name).map((f) => fmt(f.return));
  const noReturn = findFrame(tree.roots, "noReturn");
  assert.ok(noReturn, "function without a return is traced");
  assert.equal(fmt(noReturn.return), "undefined", "no return statement ends as undefined");

  assert.deepEqual(returns("early"), [fmt("yes"), fmt("no")], "both branches, in call order");
  assert.deepEqual(returns("loopReturn"), [fmt(3), fmt(-1)], "return inside a loop, and the fall-through");
  assert.deepEqual(
    returns("onlyInIf"),
    [fmt(1), fmt(undefined)],
    "conditional return and the implicit end of the body",
  );
  for (const f of tree.roots) assert.equal(f.error, null, `${f.name} must not look like an error`);
});

test("a function ending in throw records the error instead of a return", () => {
  const src = `
    function boom(flag) { if (flag) { throw new RangeError("bad"); } return "ok"; }
    function alwaysThrows() { throw new Error("nope"); }
    try { boom(true); } catch (e) {}
    boom(false);
    alwaysThrows();
  `;
  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "sync functions must not be skipped");
  assert.notEqual(res.status, 0, "the program's own exit code is preserved");
  assert.ok(tree, "tree captured despite the crash");
  assert.deepEqual(
    tree.roots.map((f) => f.name),
    ["boom", "boom", "alwaysThrows"],
    "frames still appear in call order",
  );

  const [bad, good] = findFrames(tree.roots, "boom");
  assert.equal(bad.error.name, "RangeError");
  assert.equal(bad.error.message, "bad");
  assert.equal(fmt(bad.return), "undefined", "throwing path records no return value");
  assert.equal(good.error, null, "the non-throwing call is unaffected");
  assert.equal(good.return, "ok");

  const [always] = findFrames(tree.roots, "alwaysThrows");
  assert.equal(always.error.name, "Error");
  assert.equal(always.error.message, "nope");
  assert.ok(always.endedAt, "the frame is still closed when it throws");
});

test("every invocation of the same function is its own frame", () => {
  const src = `
    function tag(n) { return "v" + n; }
    tag(1);
    tag(2);
    tag(3);
  `;
  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "sync functions must not be skipped");
  assert.equal(res.status, 0);
  assert.ok(tree, "tree captured");
  assert.equal(tree.roots.length, 3, "one root frame per call");

  const frames = findFrames(tree.roots, "tag");
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map((f) => f.return), ["v1", "v2", "v3"], "returns belong to their own call");

  const ids = frames.map((f) => f.id);
  assert.equal(new Set(ids).size, 3, "each invocation gets its own id");
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "ids are minted in call order");

  for (const f of frames) {
    assert.equal(typeof f.startedAt, "number", "frame records when it started");
    assert.equal(typeof f.endedAt, "number", "frame records when it ended");
    assert.ok(f.endedAt >= f.startedAt, "the frame is closed before it is written out");
  }
  assert.deepEqual(
    frames.map((f) => f.startedAt),
    [...frames.map((f) => f.startedAt)].sort((a, b) => a - b),
    "call timestamps never go backwards",
  );
  assert.deepEqual(
    frames.map((f) => f.children.length),
    [0, 0, 0],
    "a leaf call stays a leaf no matter how often it runs",
  );
});

test("timestamps bracket a nested run in the order it really executed", () => {
  const src = `
    function leaf() { return 1; }
    function mid() { leaf(); return 2; }
    function top() { mid(); mid(); return 3; }
    top();
  `;
  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "sync functions must not be skipped");
  assert.equal(res.status, 0);
  assert.ok(tree, "tree captured");

  const [top] = findFrames(tree.roots, "top");
  assert.ok(top, "top traced");
  assert.equal(top.children.length, 2, "mid called twice from top");
  for (const mid of top.children) {
    assert.equal(mid.children.length, 1, "each mid calls leaf once");
  }

  // every child starts after its caller started and ends before it ends
  const bracket = (frame) => {
    for (const child of frame.children) {
      assert.equal(typeof frame.startedAt, "number");
      assert.equal(typeof child.startedAt, "number");
      assert.ok(
        frame.startedAt <= child.startedAt,
        `${child.name} must not start before ${frame.name}`,
      );
      assert.ok(
        typeof child.endedAt === "number" && child.endedAt <= frame.endedAt,
        `${child.name} must finish before ${frame.name}`,
      );
      bracket(child);
    }
  };
  bracket(top);

  // two calls from the same site cannot overlap
  const [first, second] = top.children;
  assert.ok(first.endedAt <= second.startedAt, "the second mid starts after the first finished");
  assert.ok(
    first.children[0].endedAt <= second.children[0].startedAt,
    "their leaves never interleave",
  );

  // timestamps are non-decreasing down the tree
  const inOrder = (frame) => {
    let prev = frame.startedAt;
    for (const child of frame.children) {
      assert.ok(child.startedAt >= prev, "call order and timestamp order agree");
      prev = child.startedAt;
      inOrder(child);
    }
  };
  inOrder(top);
});

test("duration is the time between enter and exit, on every frame", () => {
  const src = `
    function tiny() { return 0; }
    function work(n) { let x = 0; for (let i = 0; i < n; i++) x += i; return x; }
    function wrap(n) { work(n); work(n); return n; }
    tiny();
    wrap(10000000);
    wrap(10000000);
  `;
  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "sync functions must not be skipped");
  assert.equal(res.status, 0);
  assert.ok(tree, "tree captured");

  const frames = [];
  const walk = (list) => {
    for (const f of list) {
      frames.push(f);
      walk(f.children);
    }
  };
  walk(tree.roots);
  assert.equal(frames.length, 7, "tiny + 2 wraps + 4 works");

  for (const f of frames) {
    assert.equal(typeof f.duration, "number", `${f.name} records a duration`);
    assert.equal(f.duration, f.endedAt - f.startedAt, `${f.name} duration is exit minus enter`);
    assert.ok(f.duration >= 0, `${f.name} duration is never negative`);
  }

  for (const parent of frames) {
    let childTotal = 0;
    for (const child of parent.children) {
      assert.ok(child.duration <= parent.duration, `${child.name} cannot outlive ${parent.name}`);
      childTotal += child.duration;
    }
    if (childTotal) {
      assert.ok(childTotal <= parent.duration, `${parent.name} spans everything it called`);
    }
  }

  const works = frames.filter((f) => f.name === "work");
  assert.equal(works.length, 4, "one work frame per call");
  assert.ok(
    works.some((f) => f.duration >= 1),
    "a long-running function accumulates at least a millisecond",
  );

  const tiny = frames.find((f) => f.name === "tiny");
  assert.ok(tiny.duration < 50, "a trivial function stays trivially short");

  const wraps = frames.filter((f) => f.name === "wrap");
  assert.equal(wraps.length, 2, "each wrap call carries its own duration");
});

test("arguments are snapshotted for every parameter shape", () => {
  const src = `
    function plain(a, b) { return [a, b]; }
    function defaults(a = 7, b = a * 2) { return [a, b]; }
    function rest(...xs) { return xs.length; }
    function destruct({ name, age = 1 }, [first, ...tail]) {
      return name + ":" + age + ":" + first + ":" + tail.length;
    }
    function takes(fn) { return fn(1); }
    function weird(u, n, b, s) { return null; }

    plain(1, "two");
    defaults();
    defaults(3);
    rest(1, 2, 3);
    destruct({ name: "ann" }, ["x", 9, 8]);
    takes(function twice(n) { return n * 2; });
    weird(undefined, null, 10n, Symbol("tag"));
  `;
  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "sync functions must not be skipped");
  assert.equal(res.status, 0, "every parameter shape runs");
  assert.ok(tree, "tree captured");

  const [plain] = findFrames(tree.roots, "plain");
  assert.deepEqual(plain.args, [1, "two"], "primitives pass through untouched");
  assert.deepEqual(plain.return, [1, "two"], "an array return is a real array");

  const defaults = findFrames(tree.roots, "defaults");
  assert.deepEqual(defaults[0].args, [7, 14], "defaults are applied before the frame opens");
  assert.deepEqual(defaults[1].args, [3, 6], "an explicit argument wins");

  const [rest] = findFrames(tree.roots, "rest");
  assert.equal(fmt(rest.args[0]), "[1, 2, 3]", "a rest parameter is the collected array");

  const [destruct] = findFrames(tree.roots, "destruct");
  assert.deepEqual(destruct.args, ["ann", 1, "x", [9, 8]], "each binding of a destructured parameter");
  assert.equal(destruct.return, "ann:1:x:2");

  const [takes] = findFrames(tree.roots, "takes");
  assert.equal(fmt(takes.args[0]), "fn twice", "a function argument is named, not dumped");
  assert.equal(takes.return, 2, "and it still runs");

  const [weird] = findFrames(tree.roots, "weird");
  assert.deepEqual(
    weird.args.map((a) => fmt(a)),
    ["undefined", "null", "10n", "Symbol(tag)"],
    "undefined, null, BigInt and Symbol stay distinguishable",
  );
  assert.equal(fmt(weird.return), "null", "a null return is not an undefined one");
});

test("awkward return values serialize without crashing the tracer", () => {
  const src = `
    function circularRef() { const o = { a: 1 }; o.self = o; return o; }
    function nested() { return { a: { b: { c: { d: 1 } } } }; }
    function longText() { return "x".repeat(500); }
    function bigList() { return Array.from({ length: 50 }, (_, i) => i); }
    function bigObj() { const o = {}; for (let i = 0; i < 100; i++) o["k" + i] = i; return o; }
    function when() { return new Date(0); }
    function pattern() { return /ab+c/gi; }
    function huge() { return 10n ** 30n; }
    function tag() { return Symbol("tag"); }
    function poison() {
      const o = { ok: 1 };
      Object.defineProperty(o, "bad", { enumerable: true, get() { throw new Error("nope"); } });
      return o;
    }

    circularRef(); nested(); longText(); bigList(); bigObj();
    when(); pattern(); huge(); tag(); poison();
  `;
  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "sync functions must not be skipped");
  assert.equal(res.status, 0, "the program runs to completion");
  assert.ok(tree, "tree captured despite every awkward value");

  const ret = (name) => findFrame(tree.roots, name).return;
  assert.equal(fmt(ret("circularRef")), "{a: 1, self: [Circular]}", "a cycle is named, not followed");
  assert.equal(fmt(ret("nested")), "{a: {b: {c: [Object]}}}", "depth is capped at three levels");

  const text = ret("longText");
  assert.equal(text.type, "string");
  assert.equal(text.length, 500, "the original length survives truncation");

  const list = ret("bigList");
  assert.equal(list.length, 9, "eight entries plus the overflow marker");
  assert.deepEqual(list[8], { type: "…", length: 50 });
  assert.match(fmt(list), /50 more/);

  const obj = ret("bigObj");
  assert.equal(obj["…"].length, 100, "an object reports how many keys were dropped");
  assert.match(fmt(obj), /100 more/);

  assert.equal(fmt(ret("when")), "1970-01-01T00:00:00.000Z", "Date renders as an ISO string");
  assert.equal(fmt(ret("pattern")), "/ab+c/gi", "RegExp renders as its literal");
  assert.match(fmt(ret("huge")), /n$/, "BigInt keeps its suffix");
  assert.equal(fmt(ret("tag")), "Symbol(tag)", "Symbol keeps its description");

  const poison = ret("poison");
  assert.equal(poison.type, "unserializable", "a getter that throws degrades instead of taking the tracer down");
  assert.equal(fmt(poison), "Object (unserializable)", "and the viewer can say so");
});

test("NaN and Infinity survive the trip through JSON", () => {
  const src = `
    function nan() { return NaN; }
    function plusInf() { return Infinity; }
    function minusInf() { return -Infinity; }
    function nanArg(x) { return 0; }
    nan();
    plusInf();
    minusInf();
    nanArg(NaN);
  `;
  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "sync functions must not be skipped");
  assert.equal(res.status, 0);
  assert.ok(tree, "tree captured");

  assert.equal(fmt(findFrame(tree.roots, "nan").return), "NaN", "NaN is not null");
  assert.equal(fmt(findFrame(tree.roots, "plusInf").return), "Infinity", "Infinity is not null");
  assert.equal(fmt(findFrame(tree.roots, "minusInf").return), "-Infinity", "-Infinity keeps its sign");

  const argFrame = findFrame(tree.roots, "nanArg");
  assert.equal(fmt(argFrame.args[0]), "NaN", "NaN survives as an argument too");
});

test("direct recursion nests one frame per invocation", () => {
  const src = `
    function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }
    fact(5);
  `;
  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "sync functions must not be skipped");
  assert.equal(res.status, 0);
  assert.ok(tree, "tree captured");

  const frames = findFrames(tree.roots, "fact");
  assert.equal(frames.length, 5, "fact(5) down to fact(1)");
  assert.deepEqual(
    frames.map((f) => f.return),
    [120, 24, 6, 2, 1],
    "each level returns its own value",
  );
  assert.equal(new Set(frames.map((f) => f.id)).size, 5, "ids are unique per invocation");

  let node = tree.roots[0];
  let depth = 0;
  while (node) {
    depth++;
    node = node.children[0];
  }
  assert.equal(depth, 5, "frames nest parent to child");
});

test("mutual recursion and deep recursion stay correct", () => {
  const src = `
    function isEven(n) { return n === 0 ? true : isOdd(n - 1); }
    function isOdd(n) { return n === 0 ? false : isEven(n - 1); }
    function count(n) { return n === 0 ? 0 : 1 + count(n - 1); }
    isEven(6);
    count(300);
  `;
  const { res, tree } = runTree(src);
  assert.equal(res.status, 0);
  assert.ok(tree, "tree captured");

  assert.equal(findFrames(tree.roots, "isEven").length, 4, "isEven(6), (4), (2), (0)");
  assert.equal(findFrames(tree.roots, "isOdd").length, 3, "isOdd(5), (3), (1)");
  assert.equal(tree.roots[0].return, true);

  let node = tree.roots[0];
  let depth = 0;
  while (node) {
    depth++;
    node = node.children[0];
  }
  assert.equal(depth, 7, "the two functions alternate down the chain");

  const counts = findFrames(tree.roots, "count");
  assert.equal(counts.length, 301, "count(300) down to count(0)");
  assert.equal(counts[0].return, 300, "the outermost call returns the total");
  assert.equal(counts[counts.length - 1].return, 0, "the base case returns 0");
  assert.equal(new Set(counts.map((f) => f.id)).size, 301, "no id is reused at depth 300");
});

test("an error at the bottom of a recursion is recorded on every frame it crosses", () => {
  const src = `
    function deep(n) { if (n === 0) throw new RangeError("bottom"); return deep(n - 1); }
    try { deep(3); } catch (e) { console.log("caught", e.message); }
  `;
  const { res, tree } = runTree(src);
  assert.equal(res.status, 0, "the caller caught it, so the program survives");
  assert.match(res.stdout, /caught bottom/, "the user's own catch still runs");
  assert.ok(tree, "tree captured");

  const frames = findFrames(tree.roots, "deep");
  assert.equal(frames.length, 4, "deep(3) down to deep(0)");
  for (const f of frames) {
    assert.equal(f.error.name, "RangeError", `${f.name} propagates the error`);
    assert.equal(f.error.message, "bottom");
    assert.equal(fmt(f.return), "undefined", "a frame that propagated an error returns nothing");
    assert.equal(typeof f.endedAt, "number", "the frame is closed");
  }
});

test("instrumentation preserves this, evaluation order, closures and arguments", () => {
  const src = `
    const log = [];
    let seq = 0;
    function next(tag) { log.push(tag + ":" + ++seq); return tag; }
    function order(a, b) { return a + b; }

    const api = {
      id: "api",
      method(x) { log.push("this=" + (this && this.id) + ",x=" + x); return this.id + x; },
    };

    function counterFactory() {
      let n = 0;
      return function inc(step) { n += step; return n; };
    }

    function argInfo() { return [arguments.length, arguments[0]].join("|"); }

    function boom() { throw new RangeError("kaboom"); }

    log.push(api.method(next("a")));
    log.push(order(next("b"), next("c")));
    const inc = counterFactory();
    inc(1);
    inc(2);
    log.push("count=" + inc(3));
    log.push(argInfo(7, 8));
    try { boom(); } catch (e) { log.push("err=" + e.constructor.name + ":" + e.message); }
    console.log(JSON.stringify(log));
  `;
  const expected = JSON.stringify([
    "a:1",
    "this=api,x=a",
    "apia",
    "b:2",
    "c:3",
    "bc",
    "count=6",
    "2|7",
    "err=RangeError:kaboom",
  ]);

  const plain = runPlain(src);
  assert.equal(plain.status, 0, "the untouched program runs");

  const { res, warnings, tree, userText } = runTree(src);
  assert.deepEqual(warnings, [], "sync functions must not be skipped");
  assert.equal(res.status, 0, "the instrumented program runs");
  assert.equal(res.stdout, plain.stdout, "byte-for-byte the same output");
  assert.equal(res.stdout, expected + "\n", "and it is the output we expect");
  assert.equal(userText, "", "nothing from the runtime leaks onto the user's stderr");

  assert.ok(tree, "tree captured alongside the output");
  assert.equal(findFrames(tree.roots, "next").length, 3, "each argument evaluation is traced");
  assert.equal(findFrames(tree.roots, "inc").length, 3, "the closure outlives its factory call");
  assert.equal(findFrame(tree.roots, "counterFactory").return.type, "function", "the factory really returns a function");
  assert.equal(findFrame(tree.roots, "boom").error.message, "kaboom", "the same error object reaches the caller");
});

test("closures and higher-order functions are traced", () => {
  const src = `
    const log = [];
    function makeCounter(start) {
      let n = start;
      return function step(by) { n += by; return n; };
    }
    function apply(fn, x) { return fn(x); }
    function twice(fn) { return function (x) { return fn(fn(x)); } }
    function inc(n) { return n + 1; }

    const c = makeCounter(10);
    log.push(c(1));
    log.push(c(2));
    log.push(apply(inc, 1));
    const doubled = twice(inc);
    log.push(doubled(5));
    console.log(JSON.stringify(log));
  `;
  const expected = JSON.stringify([11, 13, 2, 7]);

  const plain = runPlain(src);
  assert.equal(plain.status, 0, "the untouched program runs");

  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "sync functions must not be skipped");
  assert.equal(res.status, 0, "the instrumented program runs");
  assert.equal(res.stdout, plain.stdout, "byte-for-byte the same output");
  assert.equal(res.stdout, expected + "\n", "and the closure state really advances");
  assert.ok(tree, "tree captured");

  assert.deepEqual(
    tree.roots.map((f) => f.name),
    ["makeCounter", "step", "step", "apply", "twice", "anonymous"],
    "a closure invoked after its factory returned is its own root frame; it is anonymous where it is created, so it keeps the name the syntax gave it",
  );

  const [step1, step2] = tree.roots.filter((f) => f.name === "step");
  assert.equal(step1.return, 11, "first call sees the captured start value");
  assert.equal(step2.return, 13, "the second sees the state the first left behind");
  assert.ok(
    step1.endedAt <= step2.startedAt,
    "the factory frame is long closed before the closure runs",
  );

  const [applyFrame] = tree.roots.filter((f) => f.name === "apply");
  assert.equal(applyFrame.children.length, 1, "a callback invoked from inside its caller nests");
  assert.equal(applyFrame.children[0].name, "inc");
  assert.equal(applyFrame.children[0].return, 2);

  const doubled = findFrame(tree.roots, "anonymous");
  assert.equal(doubled.children.length, 2, "twice() runs the inner function twice");
  assert.deepEqual(
    doubled.children.map((f) => f.name),
    ["inc", "inc"],
    "each pass is a frame of its own",
  );
  assert.equal(doubled.return, 7);

  assert.equal(
    findFrames(tree.roots, "inc").length,
    3,
    "inc runs once through apply and twice through the composed function",
  );
});

test("callbacks invoked from native methods are traced on their own", () => {
  const src = `
    const log = [];
    function isActive(u) { return u.age >= 18; }
    function label(u) { return u.name.toUpperCase(); }
    const users = [
      { name: "al", age: 30 },
      { name: "bo", age: 12 },
      { name: "cy", age: 21 },
    ];
    const adults = users.filter(isActive);
    log.push(adults.length);
    log.push(adults.map(label).join(","));
    log.push(users.reduce((sum, u) => sum + u.age, 0));
    console.log(JSON.stringify(log));
  `;
  const expected = JSON.stringify([2, "AL,CY", 63]);

  const plain = runPlain(src);
  assert.equal(plain.status, 0, "the untouched program runs");

  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "sync callbacks must not be skipped");
  assert.equal(res.status, 0, "the instrumented program runs");
  assert.equal(res.stdout, plain.stdout, "byte-for-byte the same output");
  assert.equal(res.stdout, expected + "\n");
  assert.ok(tree, "tree captured");

  assert.deepEqual(
    tree.roots.map((f) => f.name),
    ["isActive", "isActive", "isActive", "label", "label", "anonymous", "anonymous", "anonymous"],
    "one frame per callback invocation, in call order",
  );
  assert.deepEqual(
    tree.roots.slice(0, 3).map((f) => f.return),
    [true, false, true],
    "filter runs the predicate once per element",
  );
  assert.deepEqual(
    tree.roots.slice(5).map((f) => f.return),
    [30, 42, 63],
    "the reduce callback carries its accumulator between calls",
  );
  assert.ok(
    tree.roots.every((f) => f.children.length === 0),
    "native methods are not frames, so the callbacks hang from the top",
  );
  const names = new Set(tree.roots.map((f) => f.name));
  assert.ok(!names.has("filter") && !names.has("map") && !names.has("reduce"),
    "native methods are not instrumented — only the user's code is");
});

test("comments, ASI, unicode and odd keys survive instrumentation (Phase 29)", () => {
  const src = `#!/usr/bin/env node
    // leading comment on the file
    /* leading comment on the function */
    function /* inline */ quoted() { return "ok"; }
    const weird = {
      "not-an-identifier"() { return 1; },
      鍵() { return 2; },
    };
    function asI() {
      const n = 1
      if (n) return n
      return 0
    }
    function español(ñ) { return ñ + 1 }
    export default function def() { return "d"; }
    console.log(JSON.stringify([
      quoted(),
      weird["not-an-identifier"](),
      weird["鍵"](),
      asI(),
      español(1),
      def(),
    ]));
  `;
  const expected = JSON.stringify(["ok", 1, 2, 1, 2, "d"]);

  const plain = runPlain(src);
  assert.equal(plain.status, 0, "the untouched program runs");

  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "sync functions must not be skipped");
  assert.equal(res.status, 0, "the instrumented program runs");
  assert.equal(res.stdout, plain.stdout, "byte-for-byte the same output");
  assert.equal(res.stdout, expected + "\n");
  assert.ok(tree, "tree captured");

  assert.deepEqual(
    tree.roots.map((f) => f.name),
    ["quoted", "not-an-identifier", "鍵", "asI", "español", "def"],
    "odd keys, unicode names and a default export all keep the name they answer to",
  );
  assert.equal(findFrame(tree.roots, "quoted").return, "ok", "comments in the source do not disturb it");
});

test("the directive prologue of an instrumented function is kept (Phase 29)", () => {
  const src = `
    "use strict";
    function probe() { "use strict"; return this; }
    const api = {
      strict() { "use strict"; return this; },
    };
    console.log(probe() === undefined, api.strict() === undefined);
  `;
  const { code, warnings } = transform(src, { filename: "<test>" });
  assert.deepEqual(warnings, [], "sync functions must not be skipped");

  const ast = parse(code, { sourceType: "unambiguous" });
  const seen = [];
  const walkAst = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walkAst);
    if (node.type === "BlockStatement") {
      for (const d of node.directives || []) seen.push(d.value.value);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== "loc") walkAst(value);
    }
  };
  walkAst(ast);

  assert.deepEqual(
    ast.program.directives.map((d) => d.value.value),
    ["use strict"],
    "the program-level directive is untouched",
  );
  assert.deepEqual(
    seen,
    ["use strict", "use strict"],
    "every function keeps \"use strict\" as the first statement of its body — moving it behind __enter would silently drop it",
  );
});

test("loops, labels and switches add no frames and keep semantics", () => {
  const src = `
    const log = [];
    function tick(n) { return n * 2; }
    let acc = 0;
    for (let i = 0; i < 5; i++) { if (i === 2) continue; acc += tick(i); }
    while (acc > 10) { acc -= 3; }
    do { acc++; } while (acc < 12);
    for (const v of [1, 2, 3]) { acc += v; }
    const seen = [];
    for (const k in { a: 1, b: 2 }) seen.push(k);
    outer: for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (j === 1) continue outer;
        if (i === 2) break outer;
        log.push(i + ":" + j);
      }
    }
    switch (acc % 3) {
      case 0: log.push("div3:" + acc); break;
      case 1: log.push("one:" + acc); break;
      default: log.push("other:" + acc);
    }
    log.push(seen.join("-"));
    console.log(JSON.stringify(log));
  `;
  const expected = JSON.stringify(["0:0", "1:0", "div3:18", "a-b"]);

  const plain = runPlain(src);
  assert.equal(plain.status, 0, "the untouched program runs");

  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "sync functions must not be skipped");
  assert.equal(res.status, 0, "the instrumented program runs");
  assert.equal(res.stdout, plain.stdout, "byte-for-byte the same output");
  assert.equal(res.stdout, expected + "\n", "every loop, label and switch really ran");
  assert.ok(tree, "tree captured");

  const all = [];
  (function walk(frames) {
    for (const f of frames) { all.push(f); walk(f.children); }
  })(tree.roots);
  assert.equal(all.length, 4, "control flow is not a frame — only the calls are");
  assert.deepEqual(all.map((f) => f.name), ["tick", "tick", "tick", "tick"]);
  assert.deepEqual(all.map((f) => f.return), [0, 2, 6, 8], "the skipped iteration really skipped");
});

test("modern syntax still parses, runs and traces (Phase 27)", () => {
  const src = `
    const log = [];
    function pick({ id, meta: { tag = "none" } = {} }, ...rest) {
      return id + "/" + tag + "/" + rest.length;
    }
    function elvis(o) { return o?.deep?.value ?? "fallback"; }
    function spreadCall(...args) { return args.join("+"); }
    const Pow = (a, b) => a ** b;
    function templates(n) { return "v=" + n; }
    function defaults(store) {
      store.a ??= 1;
      store.b ||= 2;
      store.c &&= 3;
      return JSON.stringify(store);
    }
    class Counter {
      #n = 0;
      static tag = "ctr";
      bump() { this.#n++; return this.#n; }
    }
    log.push(pick({ id: 1 }, 7, 8));
    log.push(pick({ id: 2, meta: { tag: "t" } }, 9));
    log.push(elvis({}));
    log.push(elvis({ deep: { value: 0 } }));
    log.push(spreadCall(...[1, 2, 3]));
    log.push(Pow(2, 10));
    log.push(templates("x"));
    log.push(defaults({ b: 9 }));
    const c = new Counter();
    c.bump();
    log.push(c.bump() + "/" + Counter.tag);
    console.log(JSON.stringify(log));
  `;
  const expected = JSON.stringify([
    "1/none/2",
    "2/t/1",
    "fallback",
    0,
    "1+2+3",
    1024,
    "v=x",
    '{"b":9,"a":1}',
    "2/ctr",
  ]);

  const plain = runPlain(src);
  assert.equal(plain.status, 0, "the untouched program runs");

  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "sync functions must not be skipped");
  assert.equal(res.status, 0, "the instrumented program runs");
  assert.equal(res.stdout, plain.stdout, "byte-for-byte the same output");
  assert.equal(res.stdout, expected + "\n");
  assert.ok(tree, "tree captured");

  assert.deepEqual(
    tree.roots.map((f) => f.name),
    ["pick", "pick", "elvis", "elvis", "spreadCall", "Pow", "templates", "defaults", "bump", "bump"],
    "every call is a frame, in call order",
  );
  assert.deepEqual(
    tree.roots[0].args,
    [1, "none", [7, 8]],
    "each binding of the destructured pattern, then the rest",
  );
  assert.deepEqual(tree.roots[1].args, [2, "t", [9]], "an explicit value beats the default");
  assert.equal(tree.roots[8].return, 1, "a private field survives the wrapping");
});

test("getters, setters and this-carrying methods are traced", () => {
  const src = `
    const log = [];
    const counter = {
      n: 0,
      get value() { return this.n; },
      set value(v) { this.n = v; },
      add(by) { this.n += by; return this.n; },
      double: function () { return this.add(this.n); },
    };
    counter.value = 5;
    log.push(counter.value);
    log.push(counter.add(3));
    log.push(counter.value);
    log.push(counter.double());
    console.log(JSON.stringify(log));
  `;
  const expected = JSON.stringify([5, 8, 8, 16]);

  const plain = runPlain(src);
  assert.equal(plain.status, 0, "the untouched program runs");

  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "accessors must not be skipped");
  assert.equal(res.status, 0, "the instrumented program runs");
  assert.equal(res.stdout, plain.stdout, "byte-for-byte the same output");
  assert.equal(res.stdout, expected + "\n");
  assert.ok(tree, "tree captured");

  assert.deepEqual(
    tree.roots.map((f) => f.name),
    ["value", "value", "add", "value", "double"],
    "setter, getter, method, getter, method — in the order they ran",
  );

  const roots = tree.roots;
  assert.equal(fmt(roots[0].return), "undefined", "a setter returns nothing");
  assert.equal(roots[1].return, 5, "the getter reads through this");
  assert.equal(roots[2].return, 8, "the method mutates through this");
  assert.equal(roots[3].return, 8, "and the getter sees the mutation");
  assert.equal(roots[4].return, 16, "a method stored as a property still carries this");

  const double = roots[4];
  assert.equal(double.children.length, 1, "this.add() nests under the caller");
  assert.equal(double.children[0].name, "add", "the nested call keeps its method name");
  assert.equal(double.children[0].return, 16);
});

test("classes, inheritance, super and private methods are traced", () => {
  const src = `
    const log = [];
    class Animal {
      constructor(name) { this.name = name; }
      speak() { return this.name + " makes a sound"; }
      static kind() { return "animal"; }
      #tag() { return "tag:" + this.name; }
      describe() { return this.#tag(); }
    }
    class Dog extends Animal {
      constructor(name) { super(name); this.legs = 4; }
      speak() { return super.speak() + " (woof)"; }
      describe() { return super.describe() + "/" + this.legs; }
    }
    const d = new Dog("rex");
    log.push(d.speak());
    log.push(d.describe());
    log.push(Animal.kind());
    log.push(Dog.kind());
    console.log(JSON.stringify(log));
  `;
  const expected = JSON.stringify([
    "rex makes a sound (woof)",
    "tag:rex/4",
    "animal",
    "animal",
  ]);

  const plain = runPlain(src);
  assert.equal(plain.status, 0, "the untouched program runs");

  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "class members must not be skipped");
  assert.equal(res.status, 0, "the instrumented program runs");
  assert.equal(res.stdout, plain.stdout, "byte-for-byte the same output");
  assert.equal(res.stdout, expected + "\n", "and inheritance really works");
  assert.ok(tree, "tree captured");

  assert.deepEqual(
    tree.roots.map((f) => f.name),
    ["constructor", "speak", "describe", "kind", "kind"],
    "constructing and each top-level call is a root, in call order",
  );

  const ctor = tree.roots[0];
  assert.equal(ctor.children.length, 1, "super() runs the base constructor inside the derived one");
  assert.equal(ctor.children[0].name, "constructor");

  const speak = tree.roots[1];
  assert.equal(speak.children.length, 1, "super.speak() nests under the overriding method");
  assert.equal(speak.children[0].name, "speak");
  assert.equal(speak.children[0].return, "rex makes a sound");

  const describe = tree.roots[2];
  assert.equal(describe.children.length, 1, "super.describe() nests under the override");
  const base = describe.children[0];
  assert.equal(base.name, "describe");
  assert.equal(base.children.length, 1, "and the private method it calls nests under it");
  assert.equal(base.children[0].name, "#tag", "a private method is named with its private name");
  assert.equal(base.children[0].return, "tag:rex");

  assert.equal(tree.roots[3].return, "animal");
  assert.equal(tree.roots[4].return, "animal", "a static method called through a subclass still runs");
});

test("try/catch/finally inside a traced function keeps JS semantics", () => {
  const src = `
    const log = [];
    function caught() {
      try { throw new Error("inside"); } catch (e) { return "caught:" + e.message; }
    }
    function withFinally() {
      try { return "from-try"; } finally { log.push("finally-ran"); }
    }
    function finallyWins() {
      try { throw new Error("swallowed"); } finally { return "finally-wins"; }
    }
    function fallThrough() {
      try { log.push("body"); } catch (e) { log.push("never"); }
      return "after";
    }
    log.push(caught());
    log.push(withFinally());
    log.push(finallyWins());
    log.push(fallThrough());
    console.log(JSON.stringify(log));
  `;
  const expected = JSON.stringify([
    "caught:inside",
    "finally-ran",
    "from-try",
    "finally-wins",
    "body",
    "after",
  ]);

  const plain = runPlain(src);
  assert.equal(plain.status, 0, "the untouched program runs");

  const { res, warnings, tree, userText } = runTree(src);
  assert.deepEqual(warnings, [], "sync functions must not be skipped");
  assert.equal(res.status, 0, "the instrumented program runs");
  assert.equal(res.stdout, plain.stdout, "byte-for-byte the same output");
  assert.equal(res.stdout, expected + "\n", "and it is the output JS specifies");
  assert.equal(userText, "", "no stray stderr");
  assert.ok(tree, "tree captured");

  const frame = (name) => findFrame(tree.roots, name);
  assert.equal(frame("caught").error, null, "an error the function caught is not an error of the function");
  assert.equal(frame("caught").return, "caught:inside");

  assert.equal(frame("withFinally").return, "from-try", "finally runs, the return value stands");
  assert.equal(frame("withFinally").error, null);

  assert.equal(
    frame("finallyWins").return,
    "finally-wins",
    "return in finally beats the throw, as in plain JS",
  );
  assert.equal(
    frame("finallyWins").error,
    null,
    "and the frame must not be marked as an error the program never saw",
  );

  assert.equal(frame("fallThrough").return, "after", "a try that never throws falls through");
  for (const f of tree.roots) {
    assert.equal(typeof f.duration, "number", `${f.name} closes with a duration`);
    assert.equal(f.endedAt - f.startedAt, f.duration);
  }
});

test("errors propagate, rethrow and keep their class", () => {
  const src = `
    const log = [];
    class AppError extends Error {
      constructor(msg) { super(msg); this.name = "AppError"; }
    }
    function leaf() { throw new TypeError("boom"); }
    function middle() { try { leaf(); } catch (e) { throw e; } }
    function top() { try { middle(); } catch (e) { return "top-caught:" + e.name; } }
    log.push(top());

    function inner() { throw new AppError("nope"); }
    function outer() { try { inner(); } catch (e) { return e.name + "/" + e.message; } }
    log.push(outer());

    function raw() { throw "just-a-string"; }
    try { raw(); } catch (e) { log.push("raw:" + typeof e + ":" + e); }
    console.log(JSON.stringify(log));
  `;
  const expected = JSON.stringify(["top-caught:TypeError", "AppError/nope", "raw:string:just-a-string"]);

  const plain = runPlain(src);
  assert.equal(plain.status, 0, "the untouched program runs");

  const { res, warnings, tree } = runTree(src);
  assert.deepEqual(warnings, [], "sync functions must not be skipped");
  assert.equal(res.status, 0, "the instrumented program runs");
  assert.equal(res.stdout, plain.stdout, "byte-for-byte the same output");
  assert.equal(res.stdout, expected + "\n");
  assert.ok(tree, "tree captured");

  const byName = (name) => findFrame(tree.roots, name);
  assert.deepEqual(byName("leaf").error, { name: "TypeError", message: "boom" });
  assert.deepEqual(
    byName("middle").error,
    { name: "TypeError", message: "boom" },
    "a rethrow marks the frame it crossed",
  );
  assert.equal(byName("top").error, null, "the frame that caught it is clean");
  assert.equal(byName("top").return, "top-caught:TypeError");

  assert.deepEqual(byName("inner").error, { name: "AppError", message: "nope" }, "subclass keeps its name");
  assert.equal(byName("outer").error, null);
  assert.equal(byName("outer").return, "AppError/nope");

  assert.deepEqual(
    byName("raw").error,
    { name: "Error", message: "just-a-string" },
    "a thrown non-Error is still recorded",
  );
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

test("timing helpers show relative offsets and durations", () => {
  assert.equal(fmtDur(0), "0ms");
  assert.equal(fmtDur(0.4), "<1ms");
  assert.equal(fmtDur(14), "14ms");
  assert.equal(fmtDur(1234), "1.23s");
  assert.equal(fmtDur(90500), "1m 31s");
  assert.equal(fmtDur(NaN), "");

  assert.equal(fmtAt(1000, 985), "+15ms");
  assert.equal(fmtAt(1000, 1000), "+0ms");
  assert.equal(fmtAt(null, 0), "");

  assert.match(clock(1790470100228), /^\d{2}:\d{2}:\d{2}\.\d{3}$/);

  const roots = [
    {
      name: "a",
      startedAt: 600,
      endedAt: 720,
      children: [{ name: "b", startedAt: 400, endedAt: 520, children: [] }],
    },
  ];
  assert.deepEqual(traceSpan(roots), { start: 400, end: 720 });
  assert.equal(traceSpan([{ name: "x" }]), null, "a trace without timestamps has no span");

  const tm = frameTime(roots[0], 400);
  assert.equal(tm.at, "+200ms");
  assert.equal(tm.endAt, "+320ms");
  assert.equal(tm.dur, "120ms");
  assert.equal(tm.open, false);
  assert.equal(frameTime({ name: "late" }, 400), null, "frames without startedAt show nothing");

  const open = frameTime({ startedAt: 400, endedAt: null }, 400);
  assert.equal(open.at, "+0ms");
  assert.equal(open.dur, null);
  assert.equal(open.open, true);
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