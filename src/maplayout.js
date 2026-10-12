// Laying out the project map, and rendering it as text.
//
// The trace's layout (flow-model.js `toFlowModel`) is a tidy tree: every leaf
// owns a slot, a parent centres over its children. That is exactly right for a
// call tree and exactly wrong for a module map, which is a graph with cycles
// and no root. A tree layout on a cyclic graph either drops edges or overlaps
// everything.
//
// So the map gets its own layout: **layered by longest path from a source**,
// which is the standard answer for dependency graphs and the one that makes an
// import structure legible at a glance. A module sits one row below the deepest
// module that imports it, and cycles break at the first repeat rather than
// recursing forever.
//
// Position is computed here, once, server-side. The viewer gets coordinates and
// does nothing but draw them -- the same contract flow-model.js has, and for the
// same reason: a layout that only exists in the browser cannot be tested.

import { EXTRACTED, INFERRED, AMBIGUOUS } from "./scan.js";

// Same tuning vocabulary as the trace layout, so the two pictures feel like one
// tool rather than two that happen to share a colour scheme.
export const NODE_W = 220;
export const LEVEL = 132;
export const H_GAP = 40;
export const V_GAP = 56;

// Past this the map is a wall, and no layout makes it readable. Said out loud
// rather than silently truncated.
export const MAX_NODES = 400;

/**
 * Assigns every node an x/y, and returns the same nodes with `position` added.
 *
 * options:
 *   width, height, level, hGap, vGap   geometry overrides
 *   roots        node ids to treat as sources (default: modules nothing imports)
 */
export function layoutMap(map, options = {}) {
  const {
    width = NODE_W, height = 74, level = LEVEL, hGap = H_GAP, vGap = V_GAP,
    roots = null,
  } = options;

  const nodes = map.nodes || [];
  const edges = map.edges || [];

  if (nodes.length > MAX_NODES) {
    return {
      ...map,
      nodes: nodes.slice(0, MAX_NODES).map((n) => ({
        ...n,
        position: { x: 0, y: 0 },
      })),
      truncated: true,
      truncationReason:
        `${map.nodes.length} nodes exceeds the ${MAX_NODES} a readable map can hold; ` +
        `narrow the target.`,
    };
  }

  // Only dependency edges position anything. A `contains` edge is a
  // file-to-function relation, not a data-flow one, and laying modules out by
  // "which of my functions does this import" is meaningless.
  const flowEdges = edges.filter(
    (e) => e.relation === "imports" || e.relation === "calls" ||
      e.relation === "calls-module",
  );

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outgoing = new Map();
  const incoming = new Map();
  for (const n of nodes) { outgoing.set(n.id, []); incoming.set(n.id, []); }
  for (const e of flowEdges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    outgoing.get(e.source).push(e.target);
    incoming.get(e.target).push(e.source);
  }

  // Depth by longest path from a source, with cycle protection.
  //
  // Longest-path rather than shortest: a module's row should be below
  // everything it can reach from, so an import chain reads top-to-bottom
  // without an edge pointing upward.
  const depth = new Map();
  const visiting = new Set();

  const compute = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0; // a cycle: stop here rather than recurse
    visiting.add(id);

    let best = 0;
    for (const next of outgoing.get(id) || []) {
      best = Math.max(best, compute(next) + 1);
    }
    visiting.delete(id);
    depth.set(id, best);
    return best;
  };

  const sourceIds = roots ||
    nodes.filter((n) => (incoming.get(n.id) || []).length === 0).map((n) => n.id);

  // A component where everything has an incoming edge (a pure cycle) has no
  // source, so seed it explicitly -- otherwise nothing gets a depth.
  for (const n of nodes) {
    if (!sourceIds.includes(n.id)) continue;
    compute(n.id);
  }
  for (const n of nodes) compute(n.id);

  // Group into rows by depth. A node's depth is the longest path *out* of it,
  // so a module sits below everything it can reach from and no dependency edge
  // points upward.
  const rows = new Map();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    if (!rows.has(d)) rows.set(d, []);
    rows.get(d).push(n);
  }

  // Lay each row out left to right, modules first: the structural skeleton
  // reads left to right and the detail follows it.
  const kindRank = { module: 0, class: 1, function: 2, external: 3 };
  for (const row of rows.values()) {
    row.sort((a, b) => {
      const r = (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9);
      if (r !== 0) return r;
      return String(a.label).localeCompare(String(b.label));
    });
  }

  // Two zones: modules in layered rows, functions stacked *under the module
  // that declares them*.
  //
  // Putting every function in the global layered rows was tried and is wrong:
  // a project has far more functions than modules, so they all queue up in one
  // enormous row and the picture comes out ~11,000px wide -- technically a
  // layout, practically unreadable.
  //
  // Stacking functions under their module also matches how anyone reads the
  // project: the file is the unit, and its contents belong to it. The
  // dependency structure stays visible because module-to-module edges are what
  // the layering was computed from.
  const moduleIds = nodes.filter((n) => n.kind === "module").map((n) => n.id);
  const ownerOf = new Map(); // function id -> module id
  for (const e of edges) {
    if (e.relation === "contains") ownerOf.set(e.target, e.source);
  }

  const placed = new Map();
  let x = 0;
  for (const [d, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    let cursor = x;
    for (const n of row) {
      if (n.kind !== "module") continue;
      placed.set(n.id, { x: cursor, y: d * level });
      cursor += width + hGap;
    }
    // Only modules advance the cursor; external/other nodes in the row are
    // placed relative to their module below.
    if (cursor > x) x = cursor;
  }

  // Stack each module's contents beneath it.
  const fnHeight = 40;
  let orphanRow = 0;
  for (const n of nodes) {
    if (n.kind === "module") continue;
    if (n.kind === "external") {
      continue; // placed in one band at the end, once the columns are known
    }
    const owner = ownerOf.get(n.id);
    const base = owner ? placed.get(owner) : null;
    if (!base) {
      // No owner (or the owner is an external): its own column at the end, with
      // room to grow downward rather than a shared slot everyone collides in.
      placed.set(n.id, { x: x, y: orphanRow++ * fnHeight });
      continue;
    }
    const siblings = nodes.filter(
      (m) => m.kind !== "module" && m.kind !== "external" && ownerOf.get(m.id) === owner,
    );
    // Index within the module's own contents. The list deliberately includes
    // this node -- filtering it out first makes findIndex return -1 for every
    // member, which stacks all of them at the same y.
    const index = siblings.findIndex((m) => m.id === n.id);
    placed.set(n.id, {
      x: base.x,
      y: base.y + level + 54 + Math.max(0, index) * fnHeight,
    });
  }

  // Centre each module under the span of the modules it depends on, so the
  // dependency structure reads as a shape rather than a grid.
  //
  // Only *modules* are centred. Function positions were computed relative to
  // their owner above, and moving the owner afterwards would leave them
  // detached -- which is exactly the bug that produced a map where every
  // function floated at the origin.
  const maxD = Math.max(0, ...[...rows.keys()]);
  const maxRow = () => (maxD + 1) * level;

  for (const [d, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    const mods = row.filter((n) => n.kind === "module");
    if (mods.length < 2) continue;

    const sources = [];
    for (const n of mods) {
      for (const src of incoming.get(n.id) || []) {
        const p = placed.get(src);
        if (p && Math.round(p.y / level) < d) sources.push(p.x);
      }
    }
    if (!sources.length) continue;

    const first = placed.get(mods[0].id).x;
    const last = placed.get(mods[mods.length - 1].id).x + width;
    const want = (Math.min(...sources) + Math.max(...sources) + width) / 2;
    const shift = want - (first + last) / 2;

    for (const n of mods) {
      const p = placed.get(n.id);
      placed.set(n.id, { x: p.x + shift, y: p.y });
      // Everything stacked under this module moves with it.
      for (const child of nodes) {
        if (child.kind === "module" || child.kind === "external") continue;
        if (ownerOf.get(child.id) !== n.id) continue;
        const cp = placed.get(child.id);
        placed.set(child.id, { x: cp.x + shift, y: cp.y });
      }
    }
  }

  // Externals last, in their own band: they are context, not structure, and
  // placing them alongside the project's own modules makes the dependency
  // picture harder to read rather than easier.
  let ex = 0;
  for (const n of nodes) {
    if (n.kind !== "external") continue;
    placed.set(n.id, {
      x: (ex % 12) * (width + hGap),
      y: maxRow(level) + Math.floor(ex / 12) * 56,
    });
    ex++;
  }

  const out = nodes.map((n) => {
    const p = placed.get(n.id) ?? { x: 0, y: 0 };
    return { ...n, position: { x: Math.round(p.x), y: Math.round(p.y) } };
  });

  // Edges in the shape the viewer already draws: source/target plus handles.
  const outEdges = edges.map((e, i) => ({
    id: `e${i}`,
    source: e.source,
    target: e.target,
    relation: e.relation,
    confidence: e.confidence,
    line: e.line ?? null,
    type: e.relation === "contains" ? "contains" : edgeType(e),
    animated: false,
  }));

  return { ...map, nodes: out, edges: outEdges, truncated: false };
}

// Visual encoding for an edge, by what it asserts.
//
// A guessed edge looks different from a proven one. That is the whole reason
// confidence is carried this far: a reader must be able to see which half of
// the map is certain.
function edgeType(e) {
  if (e.relation === "contains") return "contains";
  if (e.confidence === AMBIGUOUS) return "guess-ambiguous";
  if (e.confidence === INFERRED) return "guess-inferred";
  return "proven";
}

// How wide and tall the whole picture is, so the viewer can fit it.
export function mapBounds(nodes) {
  let maxX = 0;
  let maxY = 0;
  for (const n of nodes) {
    const p = n.position || { x: 0, y: 0 };
    maxX = Math.max(maxX, p.x + NODE_W);
    maxY = Math.max(maxY, p.y + 74);
  }
  return { width: maxX + 40, height: maxY + 40 };
}

// ---------------------------------------------------------------------------
// Text rendering, for anything that is not a browser.
// ---------------------------------------------------------------------------

const CONF_MARK = {
  [EXTRACTED]: "  ",
  [INFERRED]: "~ ",
  [AMBIGUOUS]: "? ",
};

/**
 * The map as indented text: modules, and under each, what is in it and what it
 * reaches.
 */
export function renderMap(map, options = {}) {
  const {
    maxRows = 40, showFunctions = true, showCalls = true,
  } = options;

  const byId = new Map((map.nodes || []).map((n) => [n.id, n]));
  const label = (id) => byId.get(id)?.label ?? id;
  const lines = [];

  if (map.truncated && map.truncationReason) {
    lines.push(`!! ${map.truncationReason}`);
    lines.push("");
  }
  if (map.skipped && map.skipped.length) {
    lines.push(`!! ${map.skipped.length} file(s) could not be parsed:`);
    for (const s of map.skipped.slice(0, 5)) {
      lines.push(`   ${s.file}: ${s.reason}`);
    }
    lines.push("");
  }

  const counts = mapCounts(map);
  lines.push(
    `${counts.files} files · ${counts.modules} modules · ${counts.functions} functions · ` +
      `${counts.calls} calls (${counts.inferred} inferred, ${counts.ambiguous} ambiguous)`,
  );
  lines.push("");

  const modules = (map.nodes || []).filter((n) => n.kind === "module");
  const shown = modules.slice(0, maxRows);

  for (const mod of shown) {
    const stats = counts.perModule.get(mod.id);
    lines.push(
      `${mod.label}${mod.isEntry ? "  (entry)" : ""}${mod.isTest ? "  (test)" : ""}` +
        `  ${stats ? `${stats.out} out, ${stats.in} in` : ""}`,
    );

    if (showFunctions) {
      const fns = (map.nodes || []).filter(
        (n) => n.kind === "function" || n.kind === "class",
      ).filter((n) => belongsTo(n, mod.id, map));
      for (const fn of fns.slice(0, 6)) {
        lines.push(
          `  ${fn.exported ? "*" : " "} ${fn.label}` +
            `${fn.async ? " async" : ""}${fn.line ? `  L${fn.line}` : ""}`,
        );
      }
      if (fns.length > 6) lines.push(`    … ${fns.length - 6} more`);
    }

    if (showCalls) {
      const imports = (map.edges || []).filter(
        (e) => e.source === mod.id && e.relation === "imports",
      );
      if (imports.length) {
        lines.push(
          "  imports: " +
            imports.map((e) => `${label(e.target)}`).join(", "),
        );
      }
      const external = (map.edges || []).filter(
        (e) => e.source === mod.id && e.relation === "calls-module",
      );
      if (external.length) {
        lines.push(
          "  reaches: " +
            external.map((e) => `${CONF_MARK[e.confidence]}${label(e.target)}`).join(", "),
        );
      }
    }
    lines.push("");
  }

  if (modules.length > shown.length) {
    lines.push(`… ${modules.length - shown.length} more modules`);
  }

  return lines.join("\n").trimEnd();
}

// One line per edge, for grepping and for diffing.
export function renderMapFlat(map, options = {}) {
  const { relation = null } = options;
  const byId = new Map((map.nodes || []).map((n) => [n.id, n]));
  const label = (id) => byId.get(id)?.label ?? id;

  return (map.edges || [])
    .filter((e) => !relation || e.relation === relation)
    .map((e) =>
      `${CONF_MARK[e.confidence] || ""}${label(e.source)} ` +
      `${e.relation} ${label(e.target)}` +
      `${e.line ? `  L${e.line}` : ""}`,
    )
    .join("\n");
}

function belongsTo(fn, modId, map) {
  const edge = (map.edges || []).find(
    (e) => e.source === modId && e.target === fn.id && e.relation === "contains",
  );
  return !!edge;
}

/** Counts, including the per-module in/out degree the map view shows. */
export function mapCounts(map) {
  const counts = {
    files: (map.files || []).length,
    modules: 0, functions: 0, classes: 0, external: 0,
    calls: 0, inferred: 0, ambiguous: 0,
    imports: 0, perModule: new Map(),
  };
  for (const n of map.nodes || []) {
    if (n.kind === "module") {
      counts.modules++;
      counts.perModule.set(n.id, { in: 0, out: 0 });
    } else if (n.kind === "class") counts.classes++;
    else if (n.kind === "function") counts.functions++;
    else if (n.kind === "external") counts.external++;
  }
  for (const e of map.edges || []) {
    if (e.relation === "imports") {
      counts.imports++;
      const from = counts.perModule.get(e.source);
      const to = counts.perModule.get(e.target);
      if (from) from.out++;
      if (to) to.in++;
    } else if (e.relation === "calls" || e.relation === "calls-module") {
      counts.calls++;
      if (e.confidence === INFERRED) counts.inferred++;
      if (e.confidence === AMBIGUOUS) counts.ambiguous++;
    }
  }
  return counts;
}

export { EXTRACTED, INFERRED, AMBIGUOUS };