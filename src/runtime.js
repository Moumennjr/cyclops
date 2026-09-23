import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export const CYC_MARKER = String.fromCharCode(0) + "CYCLOPS" + String.fromCharCode(0);

export function runtimeSource() {
  const snapshotSrc = readFileSync(join(here, "snapshot.js"), "utf8");
  const snapshotBody = snapshotSrc.replace(/^export\s+/gm, "");

  return `"use strict";
const __cyc_snap = (function () {
${snapshotBody}
  return snapshot;
})();

const __cyc_stack = [];
const __cyc_roots = [];
let __cyc_nextId = 1;

function __enter(name, args, loc) {
  const frame = {
    id: __cyc_nextId++,
    name: name,
    args: args.map(function (a) { return __cyc_snap(a); }),
    loc: loc || null,
    children: [],
    return: { type: "undefined" },
    error: null,
    startedAt: Date.now(),
    endedAt: null
  };
  const parent = __cyc_stack[__cyc_stack.length - 1];
  if (parent) parent.children.push(frame);
  else __cyc_roots.push(frame);
  __cyc_stack.push(frame);
  return frame.id;
}

function __ret(id, value) {
  const frame = __find(id);
  if (frame) {
    frame.return = __cyc_snap(value);
    frame.endedAt = Date.now();
    __remove(frame);
  }
  return value;
}

function __err(id, error) {
  const frame = __find(id);
  if (frame) {
    frame.error = {
      name: (error && error.name) || "Error",
      message: (error && error.message) || String(error)
    };
    frame.endedAt = Date.now();
    __remove(frame);
  }
}

function __find(id) {
  for (let i = __cyc_stack.length - 1; i >= 0; i--) {
    if (__cyc_stack[i].id === id) return __cyc_stack[i];
  }
  return null;
}

function __remove(frame) {
  const i = __cyc_stack.lastIndexOf(frame);
  if (i !== -1) __cyc_stack.splice(i, 1);
}

process.on("exit", function () {
  try {
  const payload = JSON.stringify({ roots: __cyc_roots });
    process.stderr.write(${JSON.stringify(CYC_MARKER)} + payload + ${JSON.stringify(CYC_MARKER)});
  } catch (e) {
    process.stderr.write(${JSON.stringify(CYC_MARKER)} + JSON.stringify({ roots: __cyc_roots, note: "partial tree" }) + ${JSON.stringify(CYC_MARKER)});
  }
});
`;
}
