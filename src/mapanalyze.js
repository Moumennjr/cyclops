// Questions about a *project* that a call tree cannot answer.
//
// A trace tells you what happened once. A map tells you what could happen, and
// these are the questions worth asking of it -- each one a thing that is hard
// to see by reading files, and easy to see once the structure is laid out:
//
//   what is everything routed through   -- the thing to read first
//   what is nothing reaches              -- dead code, or a public entry point
//   what depends on what                -- the blast radius of a change
//   where are the cycles                -- load-order bugs waiting to happen
//   what is called from many places      -- easy to break by accident
//   which functions are never called     -- inside the project, statically
//
// "Never called" is the one that needs a caveat attached to it, and the caveat
// is the point: a function with no *static* caller is called by something the
// scanner cannot see -- an export for another package, a framework convention,
// a test, a string. Reporting those as dead code is the single easiest way for
// a map to cause someone to delete working code, so they are separated out and
// labelled rather than hidden or claimed.

import { EXTRACTED, INFERRED, AMBIGUOUS } from "./scan.js";
import { mapCounts } from "./maplayout.js";

/** Betweenness, over the whole map. The short way to find the load-bearing parts. */
function betweenness(nodes, edges) {
  const ids = nodes.map((n) => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const adjacency = ids.map(() => []);
  for (const e of edges) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a === undefined || b === undefined) continue;
    adjacency[a].push([b, e.confidence === EXTRACTED ? 1 : 0.6]);
    adjacency[b].push([a, e.confidence === EXTRACTED ? 1 : 0.6]);
  }

  // Brandes' algorithm. Exact, and quadratic in the worst case -- fine for the
  // few hundred nodes a readable map holds, which MAX_NODES already caps.
  const scores = new Map(ids.map((id) => [id, 0]));
  for (const s of ids) {
    const si = index.get(s);
    const stack = [];
    const preds = ids.map(() => []);
    const sigma = ids.map(() => 0);
    const dist = ids.map(() => -1);
    sigma[si] = 1;
    dist[si] = 0;
    const queue = [si];
    let qi = 0;
    while (qi < queue.length) {
      const v = queue[qi++];
      stack.push(v);
      for (const [w, weight] of adjacency[v]) {
        const alt = dist[v] + (weight < 1 ? 0.5 : 1);
        if (dist[w] < 0) {
          dist[w] = alt;
          queue.push(w);
        } else if (alt < dist[w] - 1e-9) {
          dist[w] = alt;
        }
        if (dist[w] > dist[v] + 1e-9) {
          preds[w].push(v);
          sigma[w] += sigma[v];
        } else if (Math.abs(dist[w] - (dist[v] + 1)) < 1e-9) {
          preds[w].push(v);
          sigma[w] += sigma[v];
        }
      }
    }

    const delta = ids.map(() => 0);
    while (stack.length) {
      const w = stack.pop();
      for (const v of preds[w]) {
        if (sigma[w] > 0) {
          delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
        }
      }
      if (w !== si) {
        const score = (delta[w] + (dist[w] === 0 ? 1 : 0)) / 2;
        scores.set(ids[w], Math.max(scores.get(ids[w]), 0) + 0);
        scores.set(ids[w], (scores.get(ids[w]) ?? 0) + score);
      }
    }
  }
  return scores;
}

/** Strongly connected components, by Tarjan. The cycles are the components >1. */
export function findCycles(nodes, edges) {
  const ids = nodes.filter((n) => n.kind === "module" || n.kind === "function").map((n) => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  // adjacency is keyed by every id, so an edge from a node outside this
  // filtered set (an external package, say) cannot push onto undefined.
  // [id, []] pairs, not a bare []: `ids.map(() => [])` yields N references to
  // the SAME array, so the Map collapses to one key and every other lookup
  // misses. Silent until something writes through it.
  const adj = new Map(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!index.has(e.source) || !index.has(e.target)) continue;
    adj.get(e.source).push(e.target);
  }

  let counter = 0;
  const stack = [];
  const onStack = new Set();
  const idx = new Map();
  const low = new Map();
  const out = [];

  const strong = (v) => {
    idx.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) || []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), idx.get(w)));
      }
    }

    if (low.get(v) === idx.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) out.push(component);
    }
  };

  for (const id of ids) if (!idx.has(id)) strong(id);
  return out;
}

/** Everything a map can tell you, in the order it is usually wanted. */
export function analyzeMap(map, options = {}) {
  const { topN = 10 } = options;
  const nodes = map.nodes || [];
  const edges = map.edges || [];
  const counts = mapCounts(map);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const label = (id) => byId.get(id)?.label ?? id;

  const flowEdges = edges.filter(
    (e) => e.relation === "calls" || e.relation === "calls-module" ||
      e.relation === "imports",
  );

  // fan-in / fan-out per node
  const callsIn = new Map();
  const callsOut = new Map();
  const importIn = new Map();
  const importOut = new Map();
  const callersOf = new Map();
  for (const e of edges) {
    const bump = (map2, key) => map2.set(key, (map2.get(key) || 0) + 1);
    if (e.relation === "calls") {
      bump(callsIn, e.target);
      bump(callsOut, e.source);
      if (!callersOf.has(e.target)) callersOf.set(e.target, []);
      callersOf.get(e.target).push(e.source);
    } else if (e.relation === "imports") {
      bump(importIn, e.target);
      bump(importOut, e.source);
    }
  }

  const central = betweenness(nodes, flowEdges);
  const centralRanked = [...central.entries()]
    .map(([id, score]) => ({ node: byId.get(id), score }))
    .filter((r) => r.node && r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  // --- orphans, split into "probably dead" and "public API" ----------------
  // The distinction matters more than the detection: exporting a function with
  // no caller inside the project is completely normal, and reporting it as dead
  // code is how a map gets someone to delete something that works.
  const exported = new Map();
  for (const e of edges) {
    if (e.relation === "contains") exported.set(e.target, e.source);
  }

  const neverCalled = [];
  const likelyDead = [];
  for (const n of nodes) {
    if (n.kind !== "function" && n.kind !== "class") continue;
    if ((callsIn.get(n.id) || 0) > 0) continue;
    if (n.isTest) continue;
    const owner = exported.get(n.id);
    const ownerNode = owner ? byId.get(owner) : null;
    if (n.exported && ownerNode && (ownerNode.isEntry || n.exported)) {
      likelyDead.push({ node: n, reason: "exported from a module nothing else in the project imports" });
    } else {
      likelyDead.push({ node: n, reason: "no caller inside the project" });
    }
  }

  // --- entry points and their reach ---------------------------------------
  const reachableFrom = (start) => {
    const seen = new Set([start]);
    const queue = [start];
    const adj = new Map();
    for (const e of flowEdges) {
      if (!adj.has(e.source)) adj.set(e.source, []);
      adj.get(e.source).push(e.target);
    }
    while (queue.length) {
      const cur = queue.shift();
      for (const next of adj.get(cur) || []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    seen.delete(start);
    return seen;
  };

  const entryModules = nodes.filter((n) => n.kind === "module" && n.isEntry);
  const reach = new Map();
  for (const entry of entryModules) reach.set(entry.id, reachableFrom(entry.id));
  const reachedByNobody = nodes.filter(
    (n) => n.kind === "function" && ![...reach.values()].some((s) => s.has(n.id)),
  );

  // --- blast radius --------------------------------------------------------
  // What breaks if this file changes: everything downstream of it. Computed on
  // reverse edges, which is the direction that matters for an edit.
  const dependents = (nodeId) => {
    const reverse = new Map();
    for (const e of flowEdges) {
      if (!reverse.has(e.target)) reverse.set(e.target, []);
      reverse.get(e.target).push(e.source);
    }
    const seen = new Set();
    const queue = [nodeId];
    while (queue.length) {
      const cur = queue.shift();
      for (const prev of reverse.get(cur) || []) {
        if (seen.has(prev)) continue;
        seen.add(prev);
        queue.push(prev);
      }
    }
    seen.delete(nodeId);
    return [...seen];
  };

  const blastRadius = nodes
    .filter((n) => n.kind === "module")
    .map((n) => ({ node: n, affected: dependents(n.id) }))
    .sort((a, b) => b.affected.length - a.affected.length)
    .slice(0, topN);

  const cycles = findCycles(nodes, edges).map((component) => ({
    nodes: component.map(label),
    ids: component,
    length: component.length,
  })).sort((a, b) => b.length - a.length);

  const hubs = [...callsIn.entries()]
    .map(([id, n]) => ({ node: byId.get(id), calls: n }))
    .filter((r) => r.node && r.node.kind === "function")
    .sort((a, b) => b.calls - a.calls)
    .slice(0, topN);

  const isolatedModules = nodes.filter(
    (n) => n.kind === "module" &&
      (importIn.get(n.id) || 0) === 0 && (importOut.get(n.id) || 0) === 0,
  );

  return {
    counts,
    central: centralRanked,
    hubs,
    orphans: likelyDead,
    publicApi: likelyDead.filter((r) => /exported from/.test(r.reason)),
    unreachable: reachedByNobody,
    cycles,
    blastRadius,
    isolatedModules,
    byId,
    label,
  };
}

/** The analysis as a report, ordered by how much it usually matters. */
export function renderMapReport(map, options = {}) {
  const { topN = 8, title = null } = options;
  const a = analyzeMap(map, { topN });
  const lines = [];

  if (title) lines.push(`# ${title}`, "");
  lines.push(
    `${a.counts.files} files · ${a.counts.modules} modules · ` +
      `${a.counts.functions} functions · ${a.counts.classes} classes`,
  );
  lines.push(
    `${a.counts.imports} imports · ${a.counts.calls} calls ` +
      `(${a.counts.inferred} inferred, ${a.counts.ambiguous} ambiguous)`,
  );
  lines.push("");

  if (a.central.length) {
    lines.push("## load-bearing");
    lines.push("");
    for (const row of a.central.slice(0, 5)) {
      lines.push(
        `  ${row.node.label.padEnd(24)} ${row.score.toFixed(1)}  ${row.node.file || ""}`,
      );
    }
    lines.push("");
  }

  if (a.hubs.length) {
    lines.push("## called from many places");
    lines.push("");
    for (const row of a.hubs.slice(0, 5)) {
      lines.push(`  ${row.node.label.padEnd(24)} ${row.calls} call sites  ${row.node.file || ""}`);
    }
    lines.push("");
  }

  if (a.blastRadius.length && a.blastRadius[0].affected.length) {
    lines.push("## largest blast radius");
    lines.push("");
    lines.push("  (what breaks if this file changes)");
    for (const row of a.blastRadius.slice(0, 5)) {
      if (!row.affected.length) continue;
      lines.push(`  ${row.node.label.padEnd(24)} ${row.affected.length} file(s)`);
    }
    lines.push("");
  }

  if (a.cycles.length) {
    lines.push("## import cycles");
    lines.push("");
    for (const c of a.cycles.slice(0, 4)) {
      lines.push(`  ${c.length} modules: ${c.nodes.join(" → ")}`);
    }
    lines.push("");
  }

  if (a.orphans.length) {
    lines.push("## no caller inside the project");
    lines.push("");
    lines.push("  (NOT necessarily dead -- see the caveat)");
    for (const row of a.orphans.slice(0, 6)) {
      lines.push(`  ${row.node.label.padEnd(24)} ${row.node.file || ""}  — ${row.reason}`);
    }
    lines.push("");
  }

  if (a.isolatedModules.length) {
    lines.push("## isolated files");
    lines.push("");
    lines.push("  (nothing imports them and they import nothing)");
    for (const n of a.isolatedModules.slice(0, 6)) {
      lines.push(`  ${n.label}`);
    }
    lines.push("");
  }

  if (!a.central.length && !a.cycles.length && !a.orphans.length) {
    lines.push("nothing notable");
  }

  lines.push("## the caveat on \"no caller\"");
  lines.push("");
  lines.push(
    "  A function with no caller inside this project may still be called by an",
  );
  lines.push(
    "  export for another package, a framework convention, a test, a string",
  );
  lines.push(
    "  passed to a runner, or code the scanner could not parse. Treat this as a",
  );
  lines.push(
    "  shortlist to check, not a list to delete from. The parser failure count",
  );
  lines.push(
    `  is ${(map.skipped || []).length}; every skipped file is code this map has no opinion about.`,
  );

  return lines.join("\n").trimEnd();
}

export { EXTRACTED, INFERRED, AMBIGUOUS };