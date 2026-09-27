import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  ReactFlowProvider,
  useReactFlow,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  Position,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  toFlowModel,
  describeFrame,
  buildTreeIndex,
  subtreeIds,
  computeStats,
  edgeIO,
  NODE_W,
  LEVEL,
} from "./flow-model.js";

const edgeTypes = { default: CycEdge, call: CycEdge, ret: CycEdge };
const nodeTypes = { default: FlowNode };

// visual language: solid grey/blue = call, dashed teal = return, red = error
const marker = (color) => ({
  type: MarkerType.ArrowClosed,
  width: 10,
  height: 10,
  color,
  strokeWidth: 1,
});
const M_CALL = marker("#94a3b8");
const M_PATH = marker("#2563eb");
const M_SUB = marker("#60a5fa");
const M_RET = marker("#0d9488");

const SPEEDS = [
  { label: "0.5x", ms: 900 },
  { label: "1x", ms: 450 },
  { label: "2x", ms: 220 },
  { label: "4x", ms: 110 },
];

export default function CallTree() {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesState] = useEdgesState([]);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [roots, setRoots] = useState(null);
  const [info, setInfo] = useState(null);
  const [status, setStatus] = useState("connecting");
  const [stats, setStats] = useState("");
  const [treeKey, setTreeKey] = useState("");

  // ---- replay state (starts at 0 so the tree animates itself on load) ----
  const [reveal, setReveal] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(1);
  const [frameCount, setFrameCount] = useState(0);
  const [follow, setFollow] = useState(true);
  const [ended, setEnded] = useState(false);
  const userTouched = useRef(false);
  const lastTreeKey = useRef("");

  const reload = useCallback(async (silent) => {
    try {
      const res = await fetch("/tree.json");
      if (!res.ok) throw new Error("no tree yet");
      const tree = await res.json();
      const roots = tree.roots || [];
      const key = String(tree.version || tree.generatedAt || "");
      // polling must not rebuild identical graphs (it would churn every second)
      if (key !== lastTreeKey.current) {
        lastTreeKey.current = key;
        const st = computeStats(roots);
        setStats(
          `${st.calls} calls \u00b7 depth ${st.maxDepth} \u00b7 ` +
            `${st.roots} root${st.roots === 1 ? "" : "s"} \u00b7 ` +
            `generated ${new Date(tree.generatedAt).toLocaleTimeString()}`,
        );
        const flow = toFlowModel(roots, { level: LEVEL, width: NODE_W });
        setRoots(roots);
        setNodes(
          flow.nodes.map((n) => ({
            ...n,
            data: { ...n.data, width: NODE_W, label: n.data.name, error: !!n.data.error },
          })),
        );
        setEdges(
          flow.edges.map((e) => ({
            ...e,
            markerEnd: M_CALL,
            data: { input: edgeIO(flow.byId.get(e.target)).input },
          })),
        );
        setFrameCount(flow.nodes.length);
        setTreeKey(key);
      }
      if (!silent) setStatus("live");
    } catch (err) {
      if (!silent) setStatus("render failed: " + (err && err.message));
    }
  }, [setNodes, setEdges]);

  useEffect(() => {
    reload(true);
    const id = setInterval(() => {
      if (playing) return; // don't yank the graph out from under a replay
      reload(true);
    }, 1000);
    return () => clearInterval(id);
  }, [reload, playing]);

  // a brand new trace rewinds to frame 0 and plays itself, so the diagram
  // animates the call order the moment it loads; speed scales with size
  useEffect(() => {
    if (!treeKey) return;
    if (userTouched.current) {
      userTouched.current = false;
      return;
    }
    setReveal(0);
    setEnded(false);
    setSpeedIdx(frameCount > 60 ? 3 : frameCount > 25 ? 2 : 1);
    setPlaying(true);
  }, [treeKey, frameCount]);

  const { setCenter, getNode, getViewport, fitView } = useReactFlow();

  // pan only when the frame being inspected would sit under the detail panel
  // (or off screen), so the function always stays visible while reading it
  const focusNode = useCallback(
    (nid) => {
      const n = getNode(nid);
      if (!n) return;
      const w = (n.measured && n.measured.width) || NODE_W;
      const h = (n.measured && n.measured.height) || 68;
      const box = document.getElementById("flowwrap");
      const cw = box ? box.clientWidth : 1200;
      const ch = box ? box.clientHeight : 800;
      const { x: vx, y: vy, zoom } = getViewport();
      const left = n.position.x * zoom + vx;
      const top = n.position.y * zoom + vy;
      const right = left + w * zoom;
      const bottom = top + h * zoom;
      // the detail panel lives in the top-right corner of the canvas
      const underPanel = right > cw - 380 && top < 470;
      const offscreen = right < 48 || left > cw - 48 || bottom < 48 || top > ch - 48;
      if (!underPanel && !offscreen) return;
      // RF's setCenter zooms to maxZoom unless zoom is given explicitly
      setCenter(n.position.x + w / 2, n.position.y + h / 2, { duration: 260, zoom });
    },
    [getNode, setCenter, getViewport],
  );

  const selectNode = useCallback(
    (nid) => {
      const n = nodes.find((x) => x.id === nid);
      if (!n || !n.data || !n.data.frame) return;
      setInfo({ nid, detail: describeFrame(n.data.frame), frame: n.data.frame });
      focusNode(nid);
    },
    [nodes, focusNode],
  );

  const onNodeClick = useCallback(
    (ev, node) => {
      // clicking the open node again dismisses the card
      if (info && info.nid === node.id) {
        setInfo(null);
        onNodesChange([{ id: node.id, type: "select", selected: false }]);
        return;
      }
      selectNode(node.id);
    },
    [info, selectNode, onNodesChange],
  );

  // full call tree, independent of what is currently collapsed
  const treeIndex = useMemo(
    () => buildTreeIndex(edges.map((e) => `${e.source} --> ${e.target}`)),
    [edges],
  );

  // nodes still visible after collapsing subtrees. The surviving frames are
  // laid out again so the graph closes up instead of leaving a hole where the
  // hidden branch used to be.
  const filtered = useMemo(() => {
    const keepEdges = (hide) => edges.filter((e) => !hide.has(e.source) && !hide.has(e.target));
    if (!collapsed.size || !roots) return { nodes, edges };
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const hide = new Set();
    const index = buildTreeIndex(edges.map((e) => `${e.source} --> ${e.target}`));
    // a collapsed call stays on screen (so it can be opened again); only what
    // it called underneath disappears
    for (const nid of collapsed) for (const s of subtreeIds(nid, index)) hide.add(s);
    const leafFrames = new Set();
    for (const nid of collapsed) {
      const n = byId.get(nid);
      if (n && n.data && n.data.frame) leafFrames.add(n.data.frame);
    }
    const prune = (f) => {
      if (leafFrames.has(f)) return { ...f, children: [] };
      const orig = f.children || [];
      const kids = orig.map(prune);
      // keep the original object while no descendant changed, so frame
      // identity can be trusted when the new layout is mapped back
      return kids.some((k, i) => k !== orig[i]) ? { ...f, children: kids } : f;
    };
    const keptRoots = roots.map(prune);
    const visible = nodes.filter((n) => !hide.has(n.id));
    const flow = keptRoots.length ? toFlowModel(keptRoots, { level: LEVEL, width: NODE_W }) : null;
    // pre-order over the surviving frames matches pre-order over the nodes;
    // if the two ever disagree, keep the original coordinates rather than
    // scattering the graph
    const moved =
      !!flow &&
      flow.nodes.length === visible.length &&
      flow.nodes.every((n, i) => {
        const a = n.data && n.data.frame;
        const b = visible[i].data && visible[i].data.frame;
        return a === b || (a && b && a.id === b.id);
      });
    return {
      nodes: moved ? visible.map((n, i) => ({ ...n, position: flow.nodes[i].position })) : visible,
      edges: keepEdges(hide),
    };
  }, [nodes, edges, collapsed, roots]);

  const sel = info ? info.nid : null;

  // caller chain, descendants and edge sets for the selected frame
  const selSets = useMemo(() => {
    if (!sel) return null;
    const chain = [];
    let cur = sel;
    let guard = 0;
    while (cur && guard++ < 10000) {
      chain.push(cur);
      cur = treeIndex.parent.get(cur) || null;
    }
    chain.reverse();
    const desc = subtreeIds(sel, treeIndex);
    const onPath = new Set(chain);
    for (const d of desc) onPath.add(d);
    const pathEdges = new Set();
    for (let i = 0; i + 1 < chain.length; i++) pathEdges.add(`${chain[i]}>${chain[i + 1]}`);
    return {
      sel,
      parent: treeIndex.parent.get(sel) || null,
      chain,
      onPath,
      desc,
      pathEdges,
    };
  }, [sel, treeIndex]);

  const subEdges = useMemo(() => {
    const set = new Set();
    if (!selSets) return set;
    const from = new Set([...selSets.desc, selSets.sel]);
    for (const e of edges) {
      if (from.has(e.source) && selSets.desc.has(e.target)) set.add(`${e.source}>${e.target}`);
    }
    return set;
  }, [selSets, edges]);

  // toFlowModel emits nodes in pre-order DFS = real call order, so the array
  // index *is* the replay position. no startedAt sort: those tie at ms resolution.
  const total = filtered.nodes.length;
  const shown = Math.min(reveal, total);
  // the amber "executing now" ring only exists while the replay is mid-run
  const activeId = shown > 0 && shown < total ? filtered.nodes[shown - 1].id : null;

  const visible = useMemo(() => {
    const cls = (n) => {
      const c = [];
      if (n.data && n.data.error) c.push("cyc-err");
      if (n.data && n.data.isRoot) c.push("cyc-root");
      if (n.id === activeId) c.push("cyc-active");
      if (selSets) {
        if (n.id === selSets.sel) c.push("cyc-sel");
        else if (selSets.desc.has(n.id)) c.push("cyc-sub");
        else if (selSets.onPath.has(n.id)) c.push("cyc-path");
        else c.push("cyc-dim");
      }
      return c.join(" ") || undefined;
    };

    const rn = filtered.nodes.slice(0, shown).map((n) => ({
      ...n,
      className: cls(n),
      data: {
        ...n.data,
        active: n.id === activeId,
        hidden: collapsed.has(n.id) ? subtreeIds(n.id, treeIndex).size : 0,
      },
    }));
    const revealed = new Set(rn.map((n) => n.id));

    const out = [];
    for (const e of filtered.edges) {
      if (!revealed.has(e.source) || !revealed.has(e.target)) continue;
      let className;
      let markerEnd = M_CALL;
      let label = null;
      let labelKind = null;
      if (selSets) {
        const key = `${e.source}>${e.target}`;
        if (selSets.pathEdges.has(key)) {
          className = "cyc-e-path";
          markerEnd = M_PATH;
        } else if (subEdges.has(key)) {
          className = "cyc-e-sub";
          markerEnd = M_SUB;
        } else {
          className = "cyc-e-dim";
        }
        if (e.target === selSets.sel) {
          label = e.data.input;
          labelKind = "args";
        }
      }
      out.push({
        ...e,
        className,
        markerEnd,
        data: { ...e.data, label, labelKind },
      });
    }

    // the selected frame hands its result back to its caller: one dashed
    // return arrow, never a second wall of reverse edges
    if (selSets && revealed.has(selSets.sel) && selSets.parent && revealed.has(selSets.parent)) {
      const selNode = filtered.nodes.find((n) => n.id === selSets.sel);
      const io = edgeIO(selNode && selNode.data.frame);
      out.push({
        id: `ret-${selSets.parent}-${selSets.sel}`,
        source: selSets.sel,
        target: selSets.parent,
        sourceHandle: "out",
        targetHandle: "in",
        type: "ret",
        className: "cyc-e-ret",
        markerEnd: M_RET,
        data: {
          ret: true,
          output: io.output,
          err: io.err,
          label: io.output,
          labelKind: "ret",
        },
      });
    }

    return { nodes: rn, edges: out };
  }, [filtered, shown, activeId, selSets, subEdges, collapsed, treeIndex]);

  // playback clock
  useEffect(() => {
    if (!playing) return;
    if (shown >= total) {
      setPlaying(false);
      setEnded(true);
      return;
    }
    const t = setTimeout(() => setReveal(shown + 1), SPEEDS[speedIdx].ms);
    return () => clearTimeout(t);
  }, [playing, shown, total, speedIdx]);

  const markTouched = () => {
    userTouched.current = true;
  };
  const stepBy = (n) => {
    markTouched();
    setEnded(false);
    setReveal((r) => Math.max(0, Math.min(total, (r === Infinity ? total : r) + n)));
  };
  const play = () => {
    markTouched();
    setEnded(false);
    if (shown >= total) setReveal(0);
    setPlaying(true);
  };
  const rewind = () => {
    markTouched();
    setPlaying(false);
    setEnded(false);
    setReveal(0);
  };
  const showAll = () => {
    markTouched();
    setPlaying(false);
    setEnded(false);
    setReveal(Infinity);
  };

  const onExpand = (nid) =>
    setCollapsed((c) => {
      const n = new Set(c);
      n.delete(nid);
      return n;
    });

  const onCollapse = (nid) =>
    setCollapsed((c) => {
      const n = new Set(c);
      n.add(nid);
      return n;
    });

  // hiding or revealing a branch reshapes the whole graph: recentre so the
  // tree left on screen is not stranded halfway off canvas
  const prevVisible = useRef(null);
  useEffect(() => {
    if (prevVisible.current === null) {
      prevVisible.current = total;
      return;
    }
    if (prevVisible.current === total || !total) return;
    prevVisible.current = total;
    if (playing || shown < total) return;
    fitView({ padding: 0.24, duration: 250, maxZoom: 1.2 });
  }, [total, playing, shown, fitView]);

  // jumping through the breadcrumb re-opens anything collapsed in the way
  const jumpTo = useCallback(
    (nid) => {
      setCollapsed((c) => {
        if (!c.size) return c;
        const next = new Set(c);
        let cur = nid;
        let guard = 0;
        while (cur && guard++ < 10000) {
          next.delete(cur);
          cur = treeIndex.parent.get(cur) || null;
        }
        return next.size === c.size ? c : next;
      });
      selectNode(nid);
    },
    [treeIndex, selectNode],
  );

  const detail = useMemo(() => {
    if (!info) return null;
    const chain = [];
    if (selSets) {
      for (const id of selSets.chain) {
        const n = nodes.find((x) => x.id === id);
        if (n) chain.push({ id, name: n.data.name });
      }
    }
    const kids = (treeIndex.children.get(info.nid) || []).map((id) => {
      const n = nodes.find((x) => x.id === id);
      return n ? { id, name: n.data.name } : null;
    });
    return { chain, kids: kids.filter(Boolean) };
  }, [info, selSets, treeIndex, nodes]);

  return (
    <div id="flowwrap">
      <ReactFlow
        nodes={visible.nodes}
        edges={visible.edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesState}
        onNodeClick={onNodeClick}
        onPaneClick={() => setInfo(null)}
        fitView
        fitViewOptions={{ padding: 0.24, maxZoom: 1.2 }}
        minZoom={0.2}
        maxZoom={3}
        proOptions={{ hideAttribution: false }}
        colorMode="light"
        edgeTypes={edgeTypes}
        nodeTypes={nodeTypes}
        nodesConnectable={false}
        nodesDraggable={false}
        deleteKeyCode={null}
        defaultEdgeOptions={{ type: "call" }}
      >
        <Background gap={22} size={1} color="#e8edf3" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          maskColor="rgba(248,250,252,0.75)"
          nodeColor={(n) => {
            const c = n.className || "";
            if (c.includes("cyc-err")) return "#dc2626";
            if (c.includes("cyc-root")) return "#0f172a";
            if (c.includes("cyc-dim")) return "#e2e8f0";
            if (c.includes("cyc-sel") || c.includes("cyc-path")) return "#2563eb";
            if (c.includes("cyc-sub")) return "#93c5fd";
            return "#94a3b8";
          }}
        />
        <CameraRig follow={follow} shown={shown} total={total} activeId={activeId} />
        <div className="cyc-replay">
          <button onClick={playing ? null : play} disabled={playing || total === 0} title="Play">
            {playing ? "Playing" : "Play"}
          </button>
          <button onClick={() => { setPlaying(false); stepBy(1); }} disabled={shown >= total} title="Step forward">
            Step
          </button>
          <button onClick={rewind} disabled={shown === 0} title="Rewind">
            Rewind
          </button>
          <button onClick={showAll} disabled={shown >= total} title="Show every frame">
            All
          </button>
          <select
            value={speedIdx}
            onChange={(ev) => setSpeedIdx(Number(ev.target.value))}
            title="Playback speed"
          >
            {SPEEDS.map((s, i) => (
              <option key={s.label} value={i}>
                {s.label}
              </option>
            ))}
          </select>
          <label title="Keep the active frame in view">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            follow
          </label>
          <span className="cyc-count">
            {total === 0 ? "no frames" : `${shown} / ${total}${ended ? " (done)" : ""}`}
          </span>
          <span className="cyc-stats">{stats || status}</span>
        </div>
        {info && (
          <div className="react-flow__panel top right" style={{ zIndex: 20 }}>
            <FlowDetail
              info={info}
              chain={detail ? detail.chain : []}
              kids={detail ? detail.kids : []}
              onSelect={jumpTo}
              onClose={() => setInfo(null)}
              isCollapsed={collapsed.has(info.nid)}
              onCollapse={onCollapse}
              onExpand={onExpand}
            />
          </div>
        )}
      </ReactFlow>
    </div>
  );
}

// function node: name, where it lives in the source, and the value it returned
function FlowNode({ data, isConnectable }) {
  const err = !!(data && data.error);
  const sub = [];
  if (data && data.line != null) sub.push(`L${data.line}`);
  if (data && data.argCount) sub.push(`${data.argCount} arg${data.argCount === 1 ? "" : "s"}`);
  return (
    <>
      <Handle type="target" position={Position.Top} id="in" isConnectable={isConnectable} />
      <div className="cyc-head">
        {data && data.isRoot && <span className="cyc-tag">root</span>}
        <span className="cyc-fn">{data && data.label}</span>
        {err && <span className="cyc-flag" title="threw an error">!</span>}
      </div>
      <div className="cyc-meta">
        <span className="cyc-meta-v">{sub.join(" · ")}</span>
        {data && data.hidden > 0 && (
          <span className="cyc-hid" title={`${data.hidden} call${data.hidden === 1 ? "" : "s"} hidden`}>
            ▸ {data.hidden}
          </span>
        )}
      </div>
      <div className={`cyc-out${err ? " cyc-out-err" : ""}`} title={(data && data.output) || ""}>
        <span className="cyc-out-k">{err ? "✗" : "↩"}</span>
        <span className="cyc-out-v">{(data && data.output) || ""}</span>
      </div>
      <Handle type="source" position={Position.Bottom} id="out" isConnectable={isConnectable} />
    </>
  );
}

// polyline with rounded corners
function roundedPath(pts, radius) {
  const clean = [];
  for (const p of pts) {
    const last = clean[clean.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) continue;
    clean.push(p);
  }
  if (clean.length < 2) return "";
  let d = `M ${clean[0].x} ${clean[0].y}`;
  for (let i = 1; i < clean.length - 1; i++) {
    const a = clean[i - 1];
    const p = clean[i];
    const b = clean[i + 1];
    const inLen = Math.hypot(p.x - a.x, p.y - a.y) || 1;
    const outLen = Math.hypot(b.x - p.x, b.y - p.y) || 1;
    const rr = Math.min(radius, inLen / 2, outLen / 2);
    const s = { x: p.x - ((p.x - a.x) / inLen) * rr, y: p.y - ((p.y - a.y) / inLen) * rr };
    const e = { x: p.x + ((b.x - p.x) / outLen) * rr, y: p.y + ((b.y - p.y) / outLen) * rr };
    d += ` L ${s.x} ${s.y} Q ${p.x} ${p.y} ${e.x} ${e.y}`;
  }
  const last = clean[clean.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

// call: stepped line down from caller to callee.
// return: the same corridor, one lane lower, so a call and its return read as
// a parallel pair instead of two lines fighting across the canvas.
function CycEdge({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }) {
  const ret = !!(data && data.ret);
  const { getNode } = useReactFlow();
  const label = data && data.label;
  let path;
  let lx = 0;
  let ly = 0;
  let anchor = "-100%";

  if (ret) {
    const tNode = getNode(target);
    const sNode = getNode(source);
    const th = (tNode && (tNode.measured?.height || tNode.height)) || 68;
    const sh = (sNode && (sNode.measured?.height || sNode.height)) || 68;
    const childTop = sourceY - sh;
    const parentBot = targetY + th;
    const gap = Math.max(24, childTop - parentBot);
    const laneY = Math.max(parentBot + 14, Math.min(parentBot + gap / 2 + 14, childTop - 12));
    const exitX = sourceX + 20;
    const enterX = targetX + 16;
    path = roundedPath(
      [
        { x: sourceX, y: sourceY },
        { x: sourceX, y: sourceY - 8 },
        { x: exitX, y: sourceY - 8 },
        { x: exitX, y: laneY },
        { x: enterX, y: laneY },
        { x: enterX, y: parentBot },
      ],
      9,
    );
    lx = (exitX + enterX) / 2;
    ly = laneY + 4;
    anchor = "-50%";
  } else {
    const [p] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      borderRadius: 10,
      padding: 4,
    });
    path = p;
    lx = sourceX - 10;
    ly = sourceY + 22;
  }

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      {label != null && label !== "" && (
        <EdgeLabelRenderer>
          <div
            className={`cyc-lab nodrag nopan ${data.labelKind === "ret" ? "cyc-lab-ret" : "cyc-lab-args"}${data.err ? " cyc-lab-err" : ""}`}
            style={{ transform: `translate(${anchor}, 0) translate(${lx}px, ${ly}px)` }}
            title={label}
          >
            {ret ? `${data.err ? "✗" : "↩"} ${label}` : label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// glides after the frame just revealed; zooms out to show everything at the end
function CameraRig({ follow, shown, total, activeId }) {
  const { fitView, setCenter, getNode, getViewport } = useReactFlow();
  const didFit = useRef(false);
  const wasAll = useRef(false);
  useEffect(() => {
    if (shown === 0) return;
    if (shown >= total) {
      // whole tree visible: pull back once so the finale shows everything
      if (!wasAll.current) {
        wasAll.current = true;
        fitView({ padding: 0.24, duration: 350, maxZoom: 1.2 });
      }
      return;
    }
    wasAll.current = false;
    if (!activeId) return;
    if (follow) {
      const n = getNode(activeId);
      if (n) {
        const w = (n.measured && n.measured.width) || NODE_W;
        setCenter(n.position.x + w / 2, n.position.y + 34, { zoom: getViewport().zoom, duration: 300 });
      }
      return;
    }
    if (!didFit.current) {
      didFit.current = true;
      fitView({ padding: 0.24, duration: 200, maxZoom: 1.2 });
    }
  }, [shown, total, activeId, follow, fitView, setCenter, getNode, getViewport]);
  return null;
}

// the inspection panel: everything too detailed for the graph itself
function FlowDetail({ info, chain, kids, onSelect, onClose, isCollapsed, onCollapse, onExpand }) {
  const detail = info.detail;
  if (!detail) return null;
  const argRows = detail.argRows || [];
  const frame = info.frame || {};
  const line = frame.loc && frame.loc.line;
  const name = String(frame.name || detail.name || "?");
  const outKey = frame.error ? "throws" : "returns";
  return (
    <div className="cyc-card">
      <div className="cyc-card-top">
        <div className="cyc-name">{name}</div>
        <div className="cyc-where">{line != null ? `line ${line}` : ""}</div>
        <button className="cyc-x" onClick={onClose} title="Close">
          ×
        </button>
      </div>
      {chain.length > 1 && (
        <div className="cyc-crumb">
          {chain.map((c, i) => (
            <React.Fragment key={c.id}>
              {i > 0 && <span className="cyc-sep">›</span>}
              <button
                className={`cyc-bc${c.id === info.nid ? " cyc-bc-here" : ""}`}
                onClick={() => c.id !== info.nid && onSelect(c.id)}
                title={`Go to ${c.name}`}
              >
                {c.name}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
      <div className="cyc-sec">arguments</div>
      {argRows.length === 0 ? (
        <div className="cyc-row cyc-empty">(none)</div>
      ) : (
        argRows.map((a) => (
          <div className="cyc-row" key={`arg-${a.key}`}>
            <span className="cyc-k">{a.key}</span>
            <span className="cyc-v">{a.value}</span>
            <span className="cyc-type">{a.type}</span>
          </div>
        ))
      )}
      <div className="cyc-sec">{outKey}</div>
      {detail.rows.map((r) => (
        <div className={`cyc-row${r.err ? " cyc-err" : ""}`} key={r.key}>
          <span className="cyc-v">{r.value}</span>
          <span className="cyc-type">{r.type}</span>
        </div>
      ))}
      <div className="cyc-sec">calls</div>
      {kids.length === 0 ? (
        <div className="cyc-row cyc-empty">(leaf)</div>
      ) : (
        <div className="cyc-kids">
          {kids.map((k) => (
            <button className="cyc-kid" key={k.id} onClick={() => onSelect(k.id)} title={`Go to ${k.name}`}>
              {k.name}
            </button>
          ))}
        </div>
      )}
      <div className="cyc-card-actions">
        {isCollapsed ? (
          <button onClick={() => onExpand(info.nid)}>expand subtree</button>
        ) : (
          <button onClick={() => onCollapse(info.nid)} disabled={kids.length === 0}>
            collapse subtree
          </button>
        )}
        <button onClick={onClose}>close</button>
      </div>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <ReactFlowProvider>
      <CallTree />
    </ReactFlowProvider>,
  );
}
