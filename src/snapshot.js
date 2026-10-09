const DEFAULTS = { maxDepth: 3, maxKeys: 8, maxString: 80 };

// Objects whose internals are pure noise once they cross into a trace.
//
// Returning a Node timer handle from a traced function is completely ordinary --
// `return new Promise(r => setTimeout(r, 10))` returns one of these -- and its
// snapshot is ~40 fields of underscored internals with a self-referential node
// list. It says nothing about what the call did and it dominates the rendered
// value.
//
// The constructor name is kept, because "it returned a Timeout" is the useful
// half; only the guts are dropped. Structural depth and key caps already apply
// to everything else, so this is a small targeted carve-out rather than a second
// set of limits.
const NOISY_CTORS = new Set([
  "Timeout", "Immediate",
  "Socket", "ClientRequest", "ServerResponse", "Server",
  "WriteStream", "ReadStream", "FSWatcher", "Stats",
  "ChildProcess", "X509Certificate", "Buffer", "ArrayBuffer",
  "SharedArrayBuffer", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry",
  "AbortSignal", "AbortController", "MessagePort",
]);

// A plain object whose keys are all underscore-prefixed and which carries the
// hallmark fields of a Node handle. Catches host objects this list has not
// heard of, without touching ordinary data objects that merely have one
// underscore key.
function looksLikeHostInternals(value) {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length < 4) return false;
  if (!keys.every((k) => k.startsWith("_") || k === "expiry" || k === "msecs")) {
    return false;
  }
  return "_idleTimeout" in value || "_idleStart" in value ||
    "_handle" in value || "_events" in value || "_maxListeners" in value;
}

export function snapshot(value, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  return walk(value, o, 0, new WeakSet());
}

export function walk(value, o, depth, seen) {
  const t = typeof value;
  if (value === null) return null;
  if (t === "undefined") return { type: "undefined" };
  if (t === "number") {
    // JSON turns these into null, so tag them and keep them distinguishable
    if (Number.isNaN(value)) return { type: "nan" };
    if (!Number.isFinite(value))
      return { type: "infinity", value: value > 0 ? "Infinity" : "-Infinity" };
    return value;
  }
  if (t === "boolean") return value;
  if (t === "bigint") return { type: "bigint", value: String(value) + "n" };
  if (t === "symbol") return { type: "symbol", value: String(value) };
  if (t === "function")
    return { type: "function", name: value.name || "(anonymous)" };
  if (t === "string")
    return value.length > o.maxString
      ? {
          type: "string",
          value: value.slice(0, o.maxString) + "…",
          length: value.length,
        }
      : value;
  if (seen.has(value)) return { type: "circular" };
  if (depth >= o.maxDepth)
    return { type: "truncated", ctor: value?.constructor?.name };
  seen.add(value);

  try {
    if (Array.isArray(value))
      return value
        .slice(0, o.maxKeys)
        .map((v) => walk(v, o, depth + 1, seen))
        .concat(
          value.length > o.maxKeys ? [{ type: "…", length: value.length }] : [],
        );

    if (value instanceof Date)
      return { type: "date", value: value.toISOString() };
    if (value instanceof RegExp)
      return { type: "regexp", value: String(value) };
    if (value instanceof Error)
      return { type: "error", name: value.name, message: value.message };

    // Host handles are named, not dumped. See NOISY_CTORS above.
    const ctor = value?.constructor?.name;
    if (ctor && NOISY_CTORS.has(ctor)) {
      return { type: "opaque", ctor: ctor };
    }
    if (looksLikeHostInternals(value)) {
      return { type: "opaque", ctor: ctor ?? "Object" };
    }

    const keys = Object.keys(value).slice(0, o.maxKeys);
    const out = {};
    for (const k of keys) out[k] = walk(value[k], o, depth + 1, seen);
    if (Object.keys(value).length > o.maxKeys)
      out["…"] = { type: "…", length: Object.keys(value).length };
    return out;
  } catch {
    return { type: "unserializable", ctor: value?.constructor?.name };
  } finally {
    seen.delete(value);
  }
}
