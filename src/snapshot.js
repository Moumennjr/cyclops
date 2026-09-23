const DEFAULTS = { maxDepth: 3, maxKeys: 8, maxString: 80 };

export function snapshot(value, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  return walk(value, o, 0, new WeakSet());
}

export function walk(value, o, depth, seen) {
  const t = typeof value;
  if (value === null) return null;
  if (t === "undefined") return { type: "undefined" };
  if (t === "number" || t === "boolean") return value;
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
