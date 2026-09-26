export function fmt(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  const t = typeof v;
  if (t === "number" || t === "boolean") return String(v);
  if (t === "string") {
    const s = v.length > 60 ? v.slice(0, 57) + "…" : v;
    return JSON.stringify(s);
  }
  if (t === "object") {
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      return `[${v.map(fmt).join(", ")}]`;
    }
    if (v.type) {
      switch (v.type) {
        case "undefined": return "undefined";
        case "bigint":
        case "symbol":
        case "date":
        case "regexp": return v.value;
        case "function": return `fn ${v.name}`;
        case "string": return `${JSON.stringify(v.value)}…`;
        case "circular": return "[Circular]";
        case "truncated": return `[${v.ctor ?? "…"}]`;
        case "error": return `${v.name}: ${v.message}`;
        case "…": return `…${v.length} more`;
      }
    }
    const keys = Object.keys(v);
    if (keys.length === 0) return "{}";
    return `{${keys.map((k) => `${k}: ${fmt(v[k])}`).join(", ")}}`;
  }
  return String(v);
}

function frameName(frame) {
  return String((frame && frame.name) || "?");
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// JS-ish type name for a traced value, incl. the serializer's {type} tags
export function valueType(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") {
    if (v.type) {
      switch (v.type) {
        case "undefined": return "undefined";
        case "bigint": return "bigint";
        case "symbol": return "symbol";
        case "date": return "Date";
        case "regexp": return "RegExp";
        case "function": return "function";
        case "string": return "string";
        case "number": return "number";
        case "boolean": return "boolean";
        case "circular": return "object";
        case "truncated": return v.ctor ? String(v.ctor) : "object";
        case "error": return "Error";
        case "…": return "array";
        default: return v.type;
      }
    }
    return "object";
  }
  return typeof v;
}

export function describeFrame(frame) {
  const rows = [];
  if (frame.error) {
    rows.push({
      key: "error",
      value: `${frame.error.name}: ${frame.error.message}`,
      err: true,
      type: "Error",
    });
  } else {
    rows.push({ key: "return", value: fmt(frame.return), type: valueType(frame.return) });
  }
  const argVals = Array.isArray(frame.args) ? frame.args : [];
  const argRows = argVals.map((v, i) => ({
    key: String(i),
    value: fmt(v),
    type: valueType(v),
  }));
  return {
    name: escapeHtml(frameName(frame)),
    argRows,
    rows,
    error: frame.error ? `${frame.error.name}: ${frame.error.message}` : null,
  };
}

// input/output for the arrow into a frame: its args in, its return or error out
export function edgeIO(frame) {
  if (!frame) return { input: "()", output: "" };
  const args = Array.isArray(frame.args) ? frame.args : [];
  const input = `(${args.map(fmt).join(", ")})`;
  if (frame.error) {
    return { input, output: `${frame.error.name}: ${frame.error.message}`, err: true };
  }
  return { input, output: fmt(frame.return) };
}

export function buildTreeIndex(edges) {
  const parent = new Map();
  const children = new Map();
  const attach = (from, to) => {
    if (!children.has(from)) children.set(from, []);
    children.get(from).push(to);
    parent.set(to, from);
  };
  for (const e of edges) {
    const [from, to] = e.split(" --> ");
    attach(from, to);
  }
  return { parent, children };
}

export function subtreeIds(nodeId, index) {
  const seen = new Set();
  const todo = [...(index.children.get(nodeId) || [])];
  while (todo.length) {
    const cur = todo.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    todo.push(...(index.children.get(cur) || []));
  }
  return seen;
}

export function edgesBySource(edges, index) {
  const map = new Map();
  for (const from of index.children.keys()) map.set(from, []);
  for (const e of edges) {
    const from = e.split(" --> ")[0];
    map.set(from, [...(map.has(from) ? map.get(from) : []), e]);
  }
  return map;
}

export function computeStats(roots) {
  let calls = 0;
  let maxDepth = 0;
  function walk(frames, depth) {
    for (const frame of frames) {
      calls++;
      maxDepth = Math.max(maxDepth, depth);
      walk(frame.children || [], depth + 1);
    }
  }
  walk(roots, 1);
  return { calls, maxDepth, roots: roots.length };
}

export function toFlowModel(roots, layout) {
  const nodes = [];
  const edges = [];
  const byId = new Map();
  let id = 0;

  // tidy top-down placement: every leaf owns a column, parents centre over
  // their children, so subtrees stay disjoint and branches never collide
  const pos = new Map();
  let row = 0;
  if (layout !== null) {
    let maxLen = 0;
    const measure = (frames) => {
      for (const f of frames) {
        maxLen = Math.max(maxLen, String(f.name || "").length);
        measure(f.children || []);
      }
    };
    measure(roots);
    const width = layout.width ?? Math.max(170, maxLen * 8 + 28);
    const slot = layout.slot ?? width + 44;
    const level = layout.level ?? 160;
    let cursor = 0;
    const assign = (frames, d) => {
      const centres = [];
      for (const f of frames) {
        const kids = f.children || [];
        let cx;
        if (kids.length) {
          const ks = assign(kids, d + 1);
          cx = (ks[0] + ks[ks.length - 1]) / 2;
        } else {
          cx = cursor + slot / 2;
          cursor += slot;
        }
        pos.set(f, { x: cx - width / 2, y: d * level });
        centres.push(cx);
      }
      return centres;
    };
    assign(roots, 0);
  }

  function visit(frames, parentNid, d) {
    for (const f of frames) {
      const nid = `n${++id}`;
      byId.set(nid, f);
      const p = pos.get(f);
      const px = p ? p.x : row * 210;
      const py = p ? p.y : d * 150;
      if (!p) row++;
      nodes.push({ id: nid, position: { x: px, y: py }, data: { name: String(f.name || ""), error: !!f.error, frame: f, nid } });
      if (parentNid) edges.push({ id: `${parentNid}-${nid}`, source: parentNid, target: nid });
      visit(f.children || [], nid, d + 1);
    }
  }
  visit(roots, null, 0);
  return { nodes, edges, byId };
}
