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

function labelFor(frame) {
  const args = (frame.args || []).map(fmt).join(", ");
  let label = `${frame.name}(${args})`;
  if (frame.error) {
    label += ` ✗ ${frame.error.name}: ${frame.error.message}`;
  } else {
    label += ` → ${fmt(frame.return)}`;
  }
  return label.slice(0, 140);
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

export function buildGraph(roots) {
  const nodes = [];
  const edges = [];
  const errors = new Set();
  let id = 0;

  function visit(frame, parentId) {
    const nid = `n${++id}`;
    nodes.push([nid, labelFor(frame)]);
    if (parentId) edges.push(`${parentId} --> ${nid}`);
    if (frame.error) errors.add(nid);
    for (const child of frame.children || []) visit(child, nid);
  }

  for (const root of roots) visit(root, null);

  const lines = ["flowchart TD"];
  for (const [nid, label] of nodes)
    lines.push(`  ${nid}["${nodeText(label)}"]`);
  for (const edge of edges) lines.push(`  ${edge}`);
  if (errors.size) {
    lines.push("  classDef err fill:#4c0d0d,stroke:#ef4444,color:#fca5a5;");
    lines.push(`  class ${[...errors].join(",")} err;`);
  }
  return lines.join("\n");
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
  function applyScale() {
    wrap.style.transform = `scale(${scale})`;
    wrap.style.transformOrigin = "0 0";
  }
  document.getElementById("zin").onclick = () => { scale = Math.min(4, scale * 1.25); applyScale(); };
  document.getElementById("zout").onclick = () => { scale = Math.max(0.2, scale / 1.25); applyScale(); };
  document.getElementById("zreset").onclick = () => { scale = 1; applyScale(); };

  window.mermaid.initialize({ startOnLoad: false, theme: "dark" });

  let lastVersion = null;

  async function renderTree() {
    try {
      const res = await fetch("/tree.json");
      if (!res.ok) throw new Error("no trace yet");
      const tree = await res.json();
      const graph = buildGraph(tree.roots || []);
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
      statusEl.textContent = "live · watching for changes";
      statusEl.style.color = "#4ade80";
    } catch (err) {
      statusEl.textContent = "render failed";
      statusEl.style.color = "#f87171";
      if (err instanceof MermaidError) {
        wrap.innerHTML =
          `<pre id="render-error">${nodeText(err.message)}</pre>` +
          escapeHtml(err.diagram || "");
      } else {
        wrap.innerHTML =
          '<div id="empty">No trace yet.<br>Run <code>cyclops your-file.js</code> and this view refreshes automatically.</div>';
        statsEl.textContent = "";
        statusEl.textContent = "no trace yet";
        statusEl.style.color = "#f59e0b";
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
      statusEl.style.color = "#f87171";
    }
  }

  tick();
  setInterval(tick, 1000);
  container.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    scale = Math.max(0.2, Math.min(4, scale * (e.deltaY < 0 ? 1.1 : 0.9)));
    applyScale();
  }, { passive: false });
}