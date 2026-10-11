import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export const CYC_MARKER = String.fromCharCode(0) + "CYCLOPS" + String.fromCharCode(0);

// The tracer functions are defined once, as source text, and installed onto
// globalThis before the instrumented program runs.
//
// This is what makes multi-file tracing possible. Instrumented neighbours are
// separate ESM modules, and a module-scope binding in the entry is invisible to
// them -- ESM has no shared module scope. globalThis is the one place every
// module can reach, so all of them end up driving the same call stack and
// contributing to the same tree.
const TRACER_NAMES = [
  "__enter", "__ret", "__err", "__sus", "__resume", "__cb", "__aiter",
  "__find", "__remove",
];

export function runtimeSource({ expose = true, dialect = "esm" } = {}) {
  const body = buildRuntime();

  // writeSync has to come from somewhere, and the traced program may be ESM
  // (no `require`) or CommonJS. The setup differs, so it is selected rather
  // than guessed at runtime.
  const writer =
    dialect === "cjs"
      ? `const __cyc_writeSync = require("node:fs").writeSync;`
      : `import { writeSync as __cyc_writeSync } from "node:fs";`;

  const head = `${writer}\n"use strict";\n${body}`;
  if (!expose) return head;

  const installs = TRACER_NAMES.map(
    (name) => `globalThis[${JSON.stringify(name)}] = ${name};`,
  ).join("\n");
  return `${head}\n${installs}\n`;
}

function buildRuntime() {
  const snapshotSrc = readFileSync(join(here, "snapshot.js"), "utf8");
  const snapshotBody = snapshotSrc.replace(/^export\s+/gm, "");

  return `
const __cyc_snap = (function () {
${snapshotBody}
  return snapshot;
})();

const __cyc_stack = [];
const __cyc_roots = [];
const __cyc_frames = new Map();
const __cyc_suspended = new Set();
let __cyc_nextId = 1;

// A ceiling on captured frames.
//
// Every instrumented call allocates a frame that is retained until the trace is
// serialised, so a program in a tight loop is a memory problem before it is a
// file-size problem: 20M calls of a one-argument function is tens of gigabytes
// and an out-of-memory kill, with the trace lost *and* the program taken down
// with it.
//
// Past the cap, counting continues but frames are no longer kept, so the
// numbers in the summary stay true and the run still finishes. A trace that is
// honestly incomplete beats a process that dies.
const __cyc_frameCap =
  Number(
    typeof process !== "undefined" && process.env
      ? process.env.CYCLOPS_MAX_FRAMES
      : globalThis.CYCLOPS_MAX_FRAMES,
  ) || 250000;
let __cyc_dropped = 0;

// Names that belong to the compiler, not to the traced program.
//
// TypeScript and decorator files go through esbuild first, and its output
// contains helper functions (__privateGet, __decorateClass, ...). They are real
// functions, so they would appear as frames and bury the user's own calls under
// a layer of compiler scaffolding. Frames for these are dropped on entry, which
// also leaves their children correctly re-parented to the nearest real caller.
const SYNTHETIC = new Set([
  "__privateAdd", "__privateGet", "__privateSet", "__privateMethod",
  "__publicField", "__accessCheck", "__decorateClass", "__decorateParam",
  "__classPrivateFieldGet", "__classPrivateFieldSet",
  "__export", "__toESM", "__commonJS", "__toCommonJS", "__propKey",
  "__defProp", "__getOwnPropDesc", "__spreadValues", "__read", "__objRest",
]);

function __enter(name, args, loc) {
  if (__cyc_dropped > 0) {
    // Already over the cap: count and return a handle that resolves to nothing,
    // so the instrumented code runs unchanged and __ret/__err are harmless.
    __cyc_dropped++;
    return 0;
  }
  // A synthetic frame is still tracked for stack purposes but is never emitted,
  // so anything it calls hangs off the nearest real caller instead.
  if (typeof name === "string" && SYNTHETIC.has(name)) {
    const prev = __cyc_stack[__cyc_stack.length - 1];
    return { __hidden: true, id: 0, name: name, args: [], loc: loc || null,
             children: [], return: { type: "undefined" }, error: null,
             startedAt: Date.now(), endedAt: null, parentFrame: prev || null };
  }

  if (__cyc_nextId > __cyc_frameCap) {
    __cyc_dropped++;
    return 0;
  }

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
  if (frame && frame.__hidden) return value;
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
  if (frame && frame.__hidden) return;
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

// A hidden frame is not registered in __cyc_frames (its id is always 0 and
// several can be live at once). Routing id 0 to the nearest real ancestor keeps
// __ret/__err working inside the helper without inventing a frame.
function __find(id) {
  if (id === 0) {
    for (let i = __cyc_stack.length - 1; i >= 0; i--) {
      const f = __cyc_stack[i];
      if (!f.__hidden) return f;
    }
    return null;
  }
  return __cyc_frames.get(id) || null;
}

function __remove(frame) {
  const i = __cyc_stack.lastIndexOf(frame);
  if (i !== -1) __cyc_stack.splice(i, 1);
}

// The tree is written with writeSync on fd 2, NOT process.stderr.write.
//
// process.stderr is a stream, and writes to it are asynchronous whenever it is
// a pipe -- which it is, because the CLI spawns this program and reads a pipe.
// On the "exit" event there is nothing left to wait for, so the tail of an
// async write is simply dropped. Measured on a 300 kB payload:
//
//     process.stderr.write      -> 146176 bytes arrived of 307200
//     writeSync(2, ...)         -> 307200 bytes arrived of 307200
//
// A trace that does not parse is a trace that does not exist: splitTree finds
// no closing marker, the CLI reports "no trace captured", and the program's own
// successful exit code makes it look like the program simply did nothing. That
// is the worst possible failure for a profiler -- a silent wrong answer -- so
// the write has to be synchronous.
function __cyc_emit(payload) {
  __cyc_writeSync(2, payload);
}

process.on("exit", function () {
  const M = ${JSON.stringify(CYC_MARKER)};
  try {
    const payload = {
      roots: __cyc_roots,
      // Present only when the cap was hit, so a consumer can tell a complete
      // trace from a truncated one without guessing from the frame count.
      droppedFrames: __cyc_dropped || undefined,
    };
    __cyc_emit(M + JSON.stringify(payload) + M);
  } catch (e) {
    try {
      __cyc_emit(M + JSON.stringify({ roots: __cyc_roots, note: "partial tree" }) + M);
    } catch (e2) {
      // Nothing further can be done; the trace is lost, and losing it quietly
      // is what the try/catch above exists to prevent in every other case.
    }
  }
});
`;
}

