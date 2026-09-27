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

// ---- timing -------------------------------------------------------------
// frames carry wall-clock ms; the viewer shows them relative to the first
// call in the trace (+12ms) with the duration alongside, so a tree of calls
// reads as a sequence instead of a wall of epoch numbers

export function fmtDur(ms) {
  if (typeof ms !== "number" || !isFinite(ms)) return "";
  const v = Math.max(0, ms);
  if (v === 0) return "0ms";
  if (v < 1) return "<1ms";
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60000) return `${(v / 1000).toFixed(2)}s`;
  const m = Math.floor(v / 60000);
  return `${m}m ${Math.round((v % 60000) / 1000)}s`;
}

// offset from the first call: +0ms on the root
export function fmtAt(ms, t0) {
  if (typeof ms !== "number" || typeof t0 !== "number" || !isFinite(ms) || !isFinite(t0)) {
    return "";
  }
  return `+${fmtDur(ms - t0)}`;
}

// HH:MM:SS.mmm in local time, for the detail card's absolute column
export function clock(ms) {
  if (typeof ms !== "number" || !isFinite(ms)) return "";
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// the trace's wall-clock span: first call in, last call out; null when the
// trace predates timestamps
export function traceSpan(roots) {
  let start = null;
  let end = null;
  const walk = (frames) => {
    for (const f of frames || []) {
      const s = f && f.startedAt;
      if (typeof s === "number" && isFinite(s) && (start === null || s < start)) start = s;
      const e = f && f.endedAt;
      if (typeof e === "number" && isFinite(e) && (end === null || e > end)) end = e;
      walk(f && f.children);
    }
  };
  walk(roots);
  return start === null ? null : { start, end };
}

// what the node chip and the detail card show for one frame
export function frameTime(frame, t0) {
  if (!frame || typeof frame.startedAt !== "number" || !isFinite(frame.startedAt)) return null;
  const end = typeof frame.endedAt === "number" && isFinite(frame.endedAt) ? frame.endedAt : null;
  return {
    at: fmtAt(frame.startedAt, t0),
    endAt: end === null ? "" : fmtAt(end, t0),
    dur: end === null ? null : fmtDur(end - frame.startedAt),
    startAbs: clock(frame.startedAt),
    endAbs: end === null ? null : clock(end),
    open: end === null,
  };
}

// one shared geometry for layout + rendering, so nodes can never overlap and
// every level sits on the same horizontal band
export const NODE_W = 184;
export const LEVEL = 152;
export const H_GAP = 36;
export const GROUP_GAP = 30;

function frameName(frame) {
  return String((frame && frame.name) || "?");
}

// what a frame produced, short enough to pin under its own node
function frameOutput(frame) {
  if (!frame) return "";
  if (frame.error) return `${frame.error.name}: ${frame.error.message}`;
  return fmt(frame.return);
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
  return { input, output: frameOutput(frame), err: !!frame.error };
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

// Deterministic tidy tree: every leaf owns a slot, a parent centres over its
// children, sibling subtrees get an extra gutter so call groups stay visually
// separate. Same trace in => same picture out.
export function toFlowModel(roots, layout) {
  const nodes = [];
  const edges = [];
  const byId = new Map();
  let id = 0;

  const W = (layout && layout.width) || NODE_W;
  const LV = (layout && layout.level) || LEVEL;
  const HG = (layout && layout.gap) || H_GAP;
  const GG = (layout && layout.groupGap) || GROUP_GAP;

  const pos = new Map();
  if (layout !== null) {
    const isGroup = (f) => (f.children || []).length > 0;
    const gapBetween = (a, b) => HG + (isGroup(a) || isGroup(b) ? GG : 0);
    const wcache = new Map();
    const widthOf = (f) => {
      if (wcache.has(f)) return wcache.get(f);
      const kids = f.children || [];
      let w = W;
      if (kids.length) {
        w = 0;
        for (let i = 0; i < kids.length; i++) {
          if (i) w += gapBetween(kids[i - 1], kids[i]);
          w += widthOf(kids[i]);
        }
        w = Math.max(W, w);
      }
      wcache.set(f, w);
      return w;
    };
    const kidsWidth = (kids) => {
      let t = 0;
      for (let i = 0; i < kids.length; i++) {
        if (i) t += gapBetween(kids[i - 1], kids[i]);
        t += widthOf(kids[i]);
      }
      return t;
    };
    const place = (f, left, d) => {
      const kids = f.children || [];
      const cx = left + widthOf(f) / 2;
      pos.set(f, { x: cx - W / 2, y: d * LV });
      if (!kids.length) return;
      let cur = cx - kidsWidth(kids) / 2;
      for (let i = 0; i < kids.length; i++) {
        place(kids[i], cur, d + 1);
        cur += widthOf(kids[i]) + (i + 1 < kids.length ? gapBetween(kids[i], kids[i + 1]) : 0);
      }
    };
    let cursor = 0;
    for (const r of roots) {
      place(r, cursor, 0);
      cursor += widthOf(r) + HG + GG;
    }
  }

  function visit(frames, parentNid, d) {
    for (const f of frames) {
      const nid = `n${++id}`;
      byId.set(nid, f);
      const p = pos.get(f);
      const px = p ? p.x : row * (W + 44);
      const py = p ? p.y : d * LV;
      if (!p) row++;
      const kids = f.children || [];
      nodes.push({
        id: nid,
        position: { x: px, y: py },
        style: { width: W },
        data: {
          name: String(f.name || ""),
          error: !!f.error,
          frame: f,
          nid,
          depth: d,
          parent: parentNid,
          isRoot: !parentNid,
          childCount: kids.length,
          argCount: Array.isArray(f.args) ? f.args.length : 0,
          line: f.loc && typeof f.loc.line === "number" ? f.loc.line : null,
          output: frameOutput(f),
        },
      });
      if (parentNid) {
        edges.push({
          id: `${parentNid}-${nid}`,
          source: parentNid,
          target: nid,
          sourceHandle: "out",
          targetHandle: "in",
          type: "call",
        });
      }
      visit(kids, nid, d + 1);
    }
  }
  let row = 0;
  visit(roots, null, 0);
  return { nodes, edges, byId };
}
