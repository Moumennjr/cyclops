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

function nodeText(s) {
  return s
    .replace(/[\r\n\t]+/g, " ") // no raw control whitespace inside an edge/node
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/\|/g, "&#124;")
    .replace(/\\/g, "&#92;");
}

function frameName(frame) {
  return String((frame && frame.name) || "?");
}

export function zipToSources(elements, edges) {
  if (!elements || !edges || elements.length !== edges.length) return null;
  return elements.map((el, i) => ({ el, source: edges[i] }));
}

export function detailsHtml(detail) {
  const rows = (detail.rows || [])
    .map(
      (r) =>
        `<div class="cyc-row${r.err ? " cyc-err" : ""}">` +
        `<span class="cyc-k">${r.key}</span><span class="cyc-v">${r.value}</span>` +
        `</div>`,
    )
    .join("");
  return (
    `<div class="cyc-card">` +
    `<div class="cyc-head">${detail.name}` +
    `${detail.subtree ? `<span class="cyc-sub">${detail.subtree.calls} in subtree</span>` : ""}` +
    `</div>` +
    `<div class="cyc-body">${rows}${detail.extra || ""}</div>` +
    `</div>`
  );
}

export function collapseIds(nodeId, index) {
  return subtreeIds(nodeId, index);
}

export function hideElement(el) {
  if (el) el.setAttribute("data-cyc-hidden", "1");
}
export function showElement(el) {
  if (el) el.removeAttribute("data-cyc-hidden");
}
export function isHidden(el) {
  return !!(el && el.hasAttribute("data-cyc-hidden"));
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

class MermaidError extends Error {
  constructor(message, cause, diagram) {
    super(message);
    this.name = "MermaidError";
    this.cause = cause;
    this.diagram = diagram;
  }
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function fitScale(avail, intrinsic, min = 0.25, max = 3) {
  if (!avail || !intrinsic) return 1;
  return Math.min(max, Math.max(min, avail / intrinsic));
}

export function nodeIdFromSvgId(id) {
  const m = /flowchart-([A-Za-z0-9]+?)(?:-\d+)?$/.exec(id || "");
  return m ? m[1] : null;
}

export function buildGraph(roots, byId) {
  const nodes = [];
  const edges = [];
  const errors = new Set();
  let id = 0;

  function visit(frame, parentId) {
    const nid = `n${++id}`;
    nodes.push([nid, nodeText(frame.name)]);
    if (byId) byId.set(nid, frame);
    if (parentId) edges.push(`${parentId} --> ${nid}`);
    if (frame.error) errors.add(nid);
    for (const child of frame.children || []) visit(child, nid);
  }

  for (const root of roots) visit(root, null);

  const lines = ["flowchart TD"];
  for (const [nid, label] of nodes)
    lines.push(`  ${nid}["${label}"]`);
  for (const edge of edges) lines.push(`  ${edge}`);
  if (errors.size) {
    lines.push("  classDef err fill:#fecaca,stroke:#dc2626,color:#7f1d1d;");
    lines.push(`  class ${[...errors].join(",")} err;`);
  }
  return lines.join("\n");
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
  function visit(frames, parentNid, d) {
    let sib = 0;
    for (const f of frames) {
      const nid = `n${++id}`;
      byId.set(nid, f);
      let px, py;
      if (ctr) {
        ctr.depth.set(nid, d);
        px = layout.x(d, sib);
        py = layout.y(d, sib);
      } else {
        px = sib * 210;
        py = d * 150;
      }
      nodes.push({ id: nid, position: { x: px, y: py }, data: { name: String(f.name || ""), error: !!f.error, frame: f, nid } });
      if (parentNid) edges.push({ id: `${parentNid}-${nid}`, source: parentNid, target: nid });
      visit(f.children || [], nid, d + 1);
      sib++;
    }
  }
  visit(roots, null, 0);
  return { nodes, edges, byId };
}

function wireInteractions(wrap, byId, roots) {
  try {
    const byFrame = new Map();
    for (const [nid, fr] of byId) byFrame.set(fr, nid);
    const nidOf = (fr) => byFrame.get(fr) || "";
    const edgeStrings = edgesFromFrames(roots, nidOf);
    const index = buildTreeIndex(edgeStrings);
    const nodeEls = [...wrap.querySelectorAll("g.node")];
    const nodeIds = nodeEls.map((el) => nodeIdFromSvgId(el.id) || "");
    const edgeEls = [...wrap.querySelectorAll("g.edgePath")];
    const edgeIds = edgeEls.map((el) => nodeIdFromSvgId(el.id || "") || "");
    const card = document.createElement("div");
    card.className = "cyc-infocard";
    wrap.appendChild(card);
    const hide = () => { card.hidden = true; card.textContent = ""; };
    hide();
    const pos = (el) => {
      const r = el.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      card.style.left = `${r.left - wr.left}px`;
      card.style.top = `${r.bottom - wr.top + 8}px`;
    };
    nodeEls.forEach((el, i) => {
      const nid = nodeIds[i];
      const frame = byId.get(nid);
      if (!frame) return;
      const sub = subtreeIds(nid, index);
      el.style.cursor = "pointer";
      el.title = `${frame.name} — click to inspect/collapse`;
      el.onclick = (ev) => {
        ev.stopPropagation();
        pos(el);
        const d = describeFrame(frame);
        const rows = (d.rows || [])
          .map((r) => `<div class="cyc-row${r.err ? " cyc-err" : ""}"><b>${r.key}</b> ${r.value}</div>`)
          .join("");
        card.hidden = false;
        card.innerHTML =
          `<div class="cyc-name">${d.name}</div>` +
          rows +
          (sub.size > 1
            ? `<button class="cyc-btn" data-act="toggle">collapse subtree (${sub.size})</button>`
            : "") +
          `<button class="cyc-btn" data-act="close">✕</button>`;
        card.querySelector('[data-act="close"]').onclick = hide;
        const tg = card.querySelector('[data-act="toggle"]');
        if (tg) {
          let folded = false;
          tg.onclick = () => {
            folded = !folded;
            const showAll = edgesBySource(edgeStrings, index);
            const collapsed = new Set(sub);
            nodeEls.forEach((ne, j) => {
              const hidden = folded && j !== i && collapsed.has(nodeIds[j]);
              ne.style.display = hidden ? "none" : "";
            });
            const src = showAll.get(nid) || [];
            edgeEls.forEach((ee, j) => {
              const hid =
                folded &&
                (collapsed.has(edgeIds[j]) || src.indexOf(edgeIds[j]) !== -1);
              ee.style.display = hid ? "none" : "";
            });
            tg.textContent = folded
              ? `expand subtree (${sub.size})`
              : `collapse subtree (${sub.size})`;
          };
        }
      };
    });
    wrap.onclick = () => hide();
  } catch {
    // interaction layer is best-effort; never break rendering
  }
}

if (
  typeof document !== "undefined" &&
  document.documentElement &&
  document.getElementById("tree")
) {
  start();
}

function start() {
  const wrap = document.getElementById("tree");
  const container = document.getElementById("treewrap");
  const statsEl = document.getElementById("stats");
  const statusEl = document.getElementById("status");

  let scale = 1;
  const zoomLabel = document.getElementById("zreset");
  function applyScale() {
    wrap.style.transform = `scale(${scale})`;
    wrap.style.transformOrigin = "top center";
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  }
  document.getElementById("zin").onclick = () => { scale = Math.min(6, scale * 1.25); applyScale(); };
  document.getElementById("zout").onclick = () => { scale = Math.max(0.2, scale / 1.25); applyScale(); };
  document.getElementById("zreset").onclick = () => { scale = 1; applyScale(); };

  function zoomToFit() {
    const svgEl = wrap.querySelector("svg");
    if (!svgEl) return;
    const vb = svgEl.viewBox.baseVal;
    const width = vb && vb.width ? vb.width : wrap.scrollWidth;
    scale = fitScale(container.clientWidth - 48, width);
    applyScale();
  }

  window.mermaid.initialize({ startOnLoad: false, theme: "neutral" });

  let lastVersion = null;

  async function renderTree() {
    try {
      const res = await fetch("/tree.json");
      if (!res.ok) throw new Error("no trace yet");
      const tree = await res.json();
      const byId = new Map();
      const graph = buildGraph(tree.roots || [], byId);
      const stats = computeStats(tree.roots || []);
      statsEl.textContent =
        `${stats.calls} calls · depth ${stats.maxDepth} · ` +
        `${stats.roots} root${stats.roots === 1 ? "" : "s"} · ` +
        `generated ${new Date(tree.generatedAt).toLocaleTimeString()}`;
      try {
        await window.mermaid.parse(graph);
      } catch (err) {
        throw new MermaidError("mermaid rejected the generated graph", err, graph);
      }
      const { svg } = await window.mermaid.render("cycGraph", graph);
      wrap.innerHTML = svg;
      wireInteractions(wrap, byId, tree.roots || []);
      zoomToFit();
      statusEl.textContent = "live · watching for changes";
      statusEl.style.color = "#16a34a";
    } catch (err) {
      statusEl.textContent = "render failed";
      statusEl.style.color = "#dc2626";
      if (err instanceof MermaidError) {
        wrap.innerHTML =
          `<pre id="render-error">${nodeText(err.message)}</pre>` +
          escapeHtml(err.diagram || "");
      } else {
        wrap.innerHTML =
          '<div id="empty">No trace yet.<br>Run <code>cyclops your-file.js</code> and this view refreshes automatically.</div>';
        statsEl.textContent = "";
        statusEl.textContent = "no trace yet";
        statusEl.style.color = "#b45309";
      }
    }
  }

  async function tick() {
    try {
      const res = await fetch("/version");
      const { version } = await res.json();
      if (version !== lastVersion) {
        lastVersion = version;
        await renderTree();
      }
    } catch {
      statusEl.textContent = "server unreachable";
      statusEl.style.color = "#dc2626";
    }
  }

  tick();
  setInterval(tick, 1000);
  container.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    scale = Math.max(0.2, Math.min(6, scale * (e.deltaY < 0 ? 1.1 : 0.9)));
    applyScale();
  }, { passive: false });
}