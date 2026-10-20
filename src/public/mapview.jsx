// The map view: what the project *is*, next to the trace of what it did.
//
// Two views of the same codebase over one engine, sharing one page and one
// design system. The trace answers "what happened when I ran this"; the map
// answers "what is this, and what could it call" -- the question you have to
// ask before you can run anything, and the only one that covers code paths your
// inputs never reach.
//
// The map arrives fully positioned from the server (maplayout.js). This file
// draws coordinates and adds interaction. That split is deliberate and matches
// flow-model.js: a layout that only exists in the browser cannot be tested, and
// the positions are needed server-side anyway for the text renderers.
//
// Confidence is a visual property here, not a field in a legend. A proven edge
// is solid grey, an inferred one dashed amber, an unresolved one dotted red --
// so the reader sees which half of the map is guesswork before hovering
// anything.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  Position,
} from "@xyflow/react";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/**
 * Fetches the map.
 *
 * `status` is one of loading | live | absent | broken, and the last two are
 * kept apart on purpose. "Absent" means nobody has run `cyclops map`, and the
 * fix is to run it. "Broken" means the file is there and does not parse -- a
 * half-written map, a merge conflict -- and the fix is to look at it before
 * overwriting. Telling someone to re-run the command in that second case
 * destroys the evidence.
 */
export function useMap() {
  const [map, setMap] = useState(null);
  const [status, setStatus] = useState("loading");
  const [detail, setDetail] = useState(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/map.json");
      if (res.status === 404) {
        setMap(null);
        let body = null;
        try { body = await res.json(); } catch { /* not json */ }
        if (body?.error === "the map is unreadable") {
          setStatus("broken");
          setDetail(body.detail || "unreadable");
        } else {
          setStatus("absent");
          setDetail(null);
        }
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMap(await res.json());
      setStatus("live");
      setDetail(null);
    } catch (e) {
      setStatus("broken");
      setDetail(e.message);
    }
  }, []);

  useEffect(() => {
    reload();
    // The trace polls because a trace changes under you while you watch. A map
    // only changes when the code does, so polling it every second would be
    // noise; the button re-fetches on demand instead.
  }, [reload]);

  return { map, status, detail, reload };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Applies the display toggles and, if focused, the neighbourhood.
 *
 * Focusing is the feature that makes a large map navigable: "show me this
 * module and what it reaches" is answerable on a 5,000-node graph in a way that
 * "show me everything" never is.
 */
export function visibleNodes(map, options = {}) {
  if (!map) return { nodes: [], edges: [] };
  const {
    showFunctions = true, showExternal = false, focus = null,
    depth = 2, showContains = false,
  } = options;

  let keep = new Set();

  if (focus) {
    const id = focus;
    const flow = new Map();
    for (const e of map.edges || []) {
      if (!flow.has(e.source)) flow.set(e.source, []);
      flow.get(e.source).push(e.target);
      if (!flow.has(e.target)) flow.set(e.target, []);
      flow.get(e.target).push(e.source);
    }
    keep.add(id);
    let frontier = [id];
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const cur of frontier) {
        for (const nb of flow.get(cur) || []) {
          if (keep.has(nb)) continue;
          keep.add(nb);
          next.push(nb);
        }
      }
      frontier = next;
    }
  }

  const byId = new Map((map.nodes || []).map((n) => [n.id, n]));
  const nodes = [];
  for (const n of map.nodes || []) {
    if (focus && !keep.has(n.id)) continue;
    if (!focus && !showFunctions && n.kind !== "module" && n.kind !== "external") {
      continue;
    }
    if (!showExternal && n.kind === "external") continue;
    const isModule = n.kind === "module";
    nodes.push({
      id: n.id,
      position: n.position || { x: 0, y: 0 },
      type: "mapnode",
      draggable: true,
      data: { ...n, isModule },
      className: [
        n.kind === "module"
          ? "map-mod"
          : n.kind === "external"
            ? "map-ext"
            : n.kind === "local"
              ? "map-local"
              : "map-fn",
        n.isEntry ? "map-entry" : "",
      ].filter(Boolean).join(" "),
    });
  }

  const present = new Set(nodes.map((n) => n.id));
  const edges = [];
  let i = 0;
  for (const e of map.edges || []) {
    if (e.relation === "contains" && !showContains) continue;
    if (!present.has(e.source) || !present.has(e.target)) continue;
    edges.push({
      id: `m${i++}`,
      source: e.source,
      target: e.target,
      type: e.type || "mapedge",
      label: e.confidence === "INFERRED" ? "~" : e.confidence === "AMBIGUOUS" ? "?" : null,
      data: e,
    });
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Node and edge renderers
// ---------------------------------------------------------------------------

function MapNode({ data }) {
  const n = data;
  const sub = [];

  if (n.kind === "module") {
    if (n.functions) sub.push(`${n.functions} fn`);
    if (n.imported) sub.push(`in ${n.imported}`);
  } else {
    if (n.exported) sub.push("exported");
    if (n.async) sub.push("async");
    if (n.line) sub.push(`L${n.line}`);
  }

  return (
    <>
      <Handle type="target" position={Position.Top} id="in" />
      <div className="map-nm">
        {n.exported && <span className="map-badge b-export">*</span>}
        {n.async && <span className="map-badge b-async">a</span>}
        {n.label}
      </div>
      {sub.length > 0 && <div className="map-sub">{sub.join(" · ")}</div>}
      <Handle type="source" position={Position.Bottom} id="out" />
    </>
  );
}

function MapEdge({ id, sourceX, sourceY, targetX, targetY, data }) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY,
  });
  const label = data?.confidence === "INFERRED" ? "~" : data?.confidence === "AMBIGUOUS" ? "?" : null;

  return (
    <>
      <BaseEdge id={id} path={path} />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="cyc-maplab"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            title={
              data?.confidence === "INFERRED"
                ? "inferred: the name resolved, but the target is a guess"
                : "ambiguous: several candidates, none chosen"
            }
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { mapnode: MapNode };
const edgeTypes = { mapedge: MapEdge };

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** Everything the map can tell you about one node, and what you can do with it. */
function MapDetail({ node, map, onFocus, onClose, onTrace }) {
  if (!node) return null;
  const byId = new Map((map.nodes || []).map((n) => [n.id, n]));
  const label = (id) => byId.get(id)?.label ?? id;

  const callers = (map.edges || []).filter(
    (e) => e.target === node.id && e.relation === "calls",
  );
  const callees = (map.edges || []).filter(
    (e) => e.source === node.id && (e.relation === "calls" || e.relation === "calls-module"),
  );
  const imports = (map.edges || []).filter(
    (e) => e.source === node.id && e.relation === "imports",
  );
  const contents = (map.edges || []).filter(
    (e) => e.source === node.id && e.relation === "contains",
  );
  const importedBy = (map.edges || []).filter(
    (e) => e.target === node.id && e.relation === "imports",
  );

  const row = (name, items, mark) => {
    if (!items.length) return null;
    return (
      <div className="cyc-maprow">
        <span className="cyc-maprow-k">{name}</span>
        <span className="cyc-maprow-v">
          {items.slice(0, 12).map((e, i) => (
            <button
              key={i}
              className="cyc-mapchip"
              title={`${e.relation} · ${e.confidence}${e.line ? ` · L${e.line}` : ""}`}
              onClick={() => onFocus(e.source === node.id ? e.target : e.source)}
            >
              {mark(e)}
            </button>
          ))}
          {items.length > 12 && <em> +{items.length - 12}</em>}
        </span>
      </div>
    );
  };

  return (
    <div className="react-flow__panel cyc-card" style={{ zIndex: 20 }}>
      <div className="cyc-card-top">
        <div className="cyc-name">{node.label}</div>
        <button className="cyc-x" onClick={onClose} title="Close">
          ×
        </button>
      </div>

      <div className="cyc-mapmeta">
        {node.kind}
        {node.file ? ` · ${node.file}` : ""}
        {node.line ? `:${node.line}` : ""}
        {node.exported ? " · exported" : ""}
        {node.async ? " · async" : ""}
        {node.isEntry ? " · entry point" : ""}
      </div>

      {node.kind === "function" && onTrace && (
        <button className="cyc-maptrace" onClick={() => onTrace(node)}>
          trace this function →
        </button>
      )}

      {row("calls", callees, (e) => (
        <>
          {e.confidence === "INFERRED" && <b className="map-badge b-guess">~</b>}
          {e.confidence === "AMBIGUOUS" && <b className="map-badge b-guess">?</b>}
          {label(e.target)}
        </>
      ))}
      {row("called by", callers, (e) => (
        <>
          {e.confidence === "INFERRED" && <b className="map-badge b-guess">~</b>}
          {label(e.source)}
        </>
      ))}
      {row("imports", imports, (e) => label(e.target))}
      {row("imported by", importedBy, (e) => label(e.source))}
      {row("contains", contents, (e) => label(e.target))}

      <button className="cyc-mapfocus" onClick={() => onFocus(node.id)}>
        focus this
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export default function ProjectMap() {
  const { map, status, detail, reload } = useMap();
  const [selected, setSelected] = useState(null);
  const [focus, setFocus] = useState(null);
  const [showFunctions, setShowFunctions] = useState(true);
  const [showExternal, setShowExternal] = useState(false);
  const [showContains, setShowContains] = useState(false);
  const [depth, setDepth] = useState(2);
  const nodesRef = useRef([]);
  const { setCenter, getNode, fitView } = useReactFlow();

  const { nodes, edges } = useMemo(
    () => visibleNodes(map, { showFunctions, showExternal, showContains, focus, depth }),
    [map, showFunctions, showExternal, showContains, focus, depth],
  );
  nodesRef.current = nodes;

  // Fit once the map arrives; refitting on every filter change would fight the
  // reader, who is usually mid-way through exploring.
  const didFit = useRef(false);
  useEffect(() => {
    if (!map || didFit.current) return;
    didFit.current = true;
    setTimeout(() => fitView({ padding: 0.08, maxZoom: 1, duration: 0 }), 40);
  }, [map, fitView]);

  const onNodeClick = useCallback((_, node) => setSelected(node.data), []);

  const doFocus = useCallback((id) => {
    setFocus((prev) => (prev === id ? null : id));
    setSelected(null);
  }, []);

  // Centres the camera on a node the reader just chose from the panel.
  const jumpTo = useCallback((id) => {
    const node = nodesRef.current.find((n) => n.id === id);
    if (!node) return;
    setCenter(node.position.x + 110, node.position.y + 40, { zoom: 1.1, duration: 260 });
    setSelected(node.data);
  }, [setCenter]);

  const onTrace = useCallback((node) => {
    if (!node?.file) return;
    const url = `/?fn=${encodeURIComponent(node.label)}&file=${encodeURIComponent(node.file)}`;
    window.location.href = url;
  }, []);

  if (!map) {
    const broken = status === "broken";
    return (
      <div className="cyc-mapempty">
        <h2>{broken ? "The map is unreadable" : "No map yet"}</h2>
        {broken ? (
          <>
            <p>
              <code>out/map.json</code> exists but does not parse
              {detail ? <> — {detail}</> : null}.
            </p>
            <p>
              That is different from never having run it. Look at the file
              before overwriting it: a truncated or half-written map may still
              say something worth knowing.
            </p>
            <p className="cyc-mapstatus">
              Re-running <code>cyclops map .</code> will replace it.
            </p>
          </>
        ) : (
          <p>
            Run <code>cyclops map .</code> to read this project without running
            it.
          </p>
        )}
        <p className="cyc-mapstatus">{status}</p>
        <button onClick={reload}>check again</button>
      </div>
    );
  }

  const counts = (map.nodes || []).reduce((acc, n) => {
    acc[n.kind] = (acc[n.kind] || 0) + 1;
    return acc;
  }, {});

  const guesses = (map.edges || []).filter(
    (e) => e.confidence === "INFERRED" || e.confidence === "AMBIGUOUS",
  ).length;

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={() => setSelected(null)}
        nodesConnectable={false}
        deleteKeyCode={null}
        minZoom={0.05}
        maxZoom={3}
        proOptions={{ hideAttribution: false }}
        colorMode="light"
        defaultEdgeOptions={{ type: "mapedge" }}
        fitView
        fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
      >
        <Background variant="dots" gap={22} size={1.4} color="#e2e8f0" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          maskColor="rgba(248,250,252,0.7)"
          nodeColor={(n) => {
            const k = n.data?.kind;
            if (k === "module") return n.data?.isEntry ? "#2563eb" : "#475569";
            if (k === "external") return "#fcd34d";
            return "#cbd5e1";
          }}
        />

        <div className="cyc-mapbar">
          <span className="cyc-mapstat">
            {counts.module || 0} modules · {counts.function || 0} functions
          </span>
          <label>
            <input
              type="checkbox"
              checked={showFunctions}
              onChange={(e) => setShowFunctions(e.target.checked)}
            />
            functions
          </label>
          <label>
            <input
              type="checkbox"
              checked={showExternal}
              onChange={(e) => setShowExternal(e.target.checked)}
            />
            external
          </label>
          <label>
            <input
              type="checkbox"
              checked={showContains}
              onChange={(e) => setShowContains(e.target.checked)}
            />
            containment
          </label>
          {guesses > 0 && (
            <span
              className="cyc-mapwarn"
              title={`${guesses} edge(s) resolved by name rather than proven`}
            >
              {guesses} inferred
            </span>
          )}
          {focus && (
            <>
              <span className="cyc-mapstat">focus ±{depth}</span>
              <input
                type="range"
                min={1}
                max={4}
                value={depth}
                onChange={(e) => setDepth(Number(e.target.value))}
                title="How far from the focused node to include"
              />
              <button onClick={() => setFocus(null)}>clear focus</button>
            </>
          )}
          <span className="cyc-mapstat">{nodes.length} shown</span>
        </div>

        {map.truncated && map.truncationReason && (
          <div className="cyc-mapnotice">{map.truncationReason}</div>
        )}
        {map.skipped?.length > 0 && (
          <div className="cyc-mapnotice">
            {map.skipped.length} file(s) could not be parsed and are absent from
            this map.
          </div>
        )}

        {selected && (
          <MapDetail
            node={selected}
            map={map}
            onFocus={doFocus}
            onClose={() => setSelected(null)}
            onTrace={onTrace}
          />
        )}
      </ReactFlow>
    </div>
  );
}