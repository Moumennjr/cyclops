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

export function describeFrame(frame) {
  const errors = [];
  const rows = [];
  if (frame.error) {
    rows.push({ key: "error", value: `${frame.error.name}: ${frame.error.message}`, err: true });
  } else {
    rows.push({ key: "return", value: fmt(frame.return) });
  }
  const argsFmt = fmt({ args: frame.args || [] });
  return {
    name: escapeHtml(frameName(frame)),
    args: argsFmt,
    rows,
    error: frame.error ? `${frame.error.name}: ${frame.error.message}` : null,
  };
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
  const ctr = layout === null ? null : { sib: new Map(), depth: new Map() };
  let row = 0;
  function visit(frames, parentNid, d) {
    for (const f of frames) {
      const nid = `n${++id}`;
      byId.set(nid, f);
      let px, py;
      if (ctr) {
        ctr.depth.set(nid, d);
        px = layout.x(d, row);
        py = layout.y(d, row);
        row++;
      } else {
        px = row * 210;
        py = d * 150;
        row++;
      }
      nodes.push({ id: nid, position: { x: px, y: py }, data: { name: String(f.name || ""), error: !!f.error, frame: f, nid } });
      if (parentNid) edges.push({ id: `${parentNid}-${nid}`, source: parentNid, target: nid });
      visit(f.children || [], nid, d + 1);
    }
  }
  visit(roots, null, 0);
  return { nodes, edges, byId };
}
