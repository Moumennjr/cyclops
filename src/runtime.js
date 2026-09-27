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
const __cyc_frames = new Map();
const __cyc_suspended = new Set();
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
  let parent = null;
  for (let i = __cyc_stack.length - 1; i >= 0; i--) {
    if (!__cyc_suspended.has(__cyc_stack[i].id)) {
      parent = __cyc_stack[i];
      break;
    }
  }
  if (parent) parent.children.push(frame);
  else __cyc_roots.push(frame);
  __cyc_stack.push(frame);
  __cyc_frames.set(frame.id, frame);
  return frame.id;
}

function __sus(id, value) {
  const frame = __find(id);
  if (frame) __cyc_suspended.add(id);
  return value;
}

function __resume(id, value) {
  const frame = __find(id);
  if (frame) __cyc_suspended.delete(id);
  return value;
}

function __cb(id, fn) {
  if (typeof fn !== "function") return fn;
  return function () {
    const frame = __find(id);
    if (!frame) return fn.apply(this, arguments);
    const wasSuspended = __cyc_suspended.has(id);
    __cyc_suspended.delete(id);
    __cyc_stack.push(frame);
    try {
      return fn.apply(this, arguments);
    } finally {
      __remove(frame);
      if (wasSuspended) __cyc_suspended.add(id);
    }
  };
}

function __aiter(id, iterable) {
  if (iterable == null) return iterable;
  const asyncMethod = iterable[Symbol.asyncIterator];
  const syncMethod = iterable[Symbol.iterator];
  if (typeof asyncMethod !== "function" && typeof syncMethod !== "function") {
    return iterable;
  }
  const isSync = typeof asyncMethod !== "function";
  const inner = (isSync ? syncMethod : asyncMethod).call(iterable);
  if (inner == null || typeof inner.next !== "function") return iterable;
  const wrapped = {
    next: function () {
      const args = arguments;
      if (!isSync) {
        const step = inner.next.apply(inner, args);
        __sus(id, undefined);
        return step;
      }
      let step;
      try {
        step = inner.next.apply(inner, args);
      } catch (e) {
        __sus(id, undefined);
        return Promise.reject(e);
      }
      __sus(id, undefined);
      return Promise.resolve(step.value).then(function (value) {
        return { value: value, done: step.done };
      });
    },
  };
  if (typeof inner.return === "function") {
    wrapped.return = function () {
      const result = inner.return.apply(inner, arguments);
      __sus(id, undefined);
      return Promise.resolve(result).then(
        function (v) { __resume(id, undefined); return v; },
        function (e) { __resume(id, undefined); throw e; }
      );
    };
  }
  wrapped[Symbol.asyncIterator] = function () { return wrapped; };
  return wrapped;
}

function __ret(id, value) {
  const frame = __find(id);
  if (frame) {
    __cyc_suspended.delete(id);
    frame.return = __cyc_snap(value);
    frame.endedAt = Date.now();
    frame.duration = frame.endedAt - frame.startedAt;
    __remove(frame);
  }
  return value;
}

function __err(id, error) {
  const frame = __find(id);
  if (frame) {
    __cyc_suspended.delete(id);
    frame.error = {
      name: (error && error.name) || "Error",
      message: (error && error.message) || String(error)
    };
    frame.endedAt = Date.now();
    frame.duration = frame.endedAt - frame.startedAt;
    __remove(frame);
  }
}

function __find(id) {
  return __cyc_frames.get(id) || null;
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
