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
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  toFlowModel,
  describeFrame,
  buildTreeIndex,
  subtreeIds,
  edgesBySource,
  computeStats,
} from "./flow-model.js";

const NODE_W = 170;
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

  const reload = useCallback(async (silent) => {
    try {
      const res = await fetch("/tree.json");
      if (!res.ok) throw new Error("no tree yet");
      const tree = await res.json();
      const roots = tree.roots || [];
      const st = computeStats(roots);
      setStats(
        `${st.calls} calls \u00b7 depth ${st.maxDepth} \u00b7 ` +
          `${st.roots} root${st.roots === 1 ? "" : "s"} \u00b7 ` +
          `generated ${new Date(tree.generatedAt).toLocaleTimeString()}`,
      );
      const flow = toFlowModel(roots, {
        x: (d) => d * 130,
        y: (d, row) => row * 90,
      });
      setNodes(
        flow.nodes.map((n) => ({
          ...n,
          data: { ...n.data, width: NODE_W, label: n.data.name, error: !!n.data.error },
        })),
      );
      setEdges(
        flow.edges.map((e) => ({ ...e, id: e.id || `${e.source}-${e.target}`, type: "smoothstep" })),
      );
      setFrameCount(flow.nodes.length);
      setTreeKey(String(tree.version || tree.generatedAt || ""));
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

  const onNodeClick = useCallback(
    (ev, node) => {
      const key = node.id;
      if (collapsed.has(key)) {
        setCollapsed((c) => { const n = new Set(c); n.delete(key); return n; });
        return;
      }
      const frame = node.data && node.data.frame;
      if (!frame) return;
      // clicking the open node again dismisses the card
      if (info && info.nid === key) {
        setInfo(null);
        return;
      }
      setInfo({ nid: key, detail: describeFrame(frame), frame });
    },
    [collapsed, info],
  );

  // nodes still visible after collapsing subtrees
  const filtered = useMemo(() => {
    if (!collapsed.size) return { nodes, edges };
    const hide = new Set(collapsed);
    const edgeStrings = edges.map((e) => `${e.source} --> ${e.target}`);
    const index = buildTreeIndex(edgeStrings);
    for (const [nid] of collapsed) {
      for (const s of subtreeIds(nid, index)) hide.add(s);
    }
    const esrc = edgesBySource(edgeStrings, index);
    const hiddenEdges = new Set();
    for (const [from, list] of esrc) {
      if (hide.has(from)) for (const e of list) hiddenEdges.add(`${e.source} --> ${e.target}`);
    }
    return {
      nodes: nodes.filter((n) => !hide.has(n.id)),
      edges: edges.filter((e) => !hiddenEdges.has(`${e.source} --> ${e.target}`)),
    };
  }, [nodes, edges, collapsed]);

  // toFlowModel emits nodes in pre-order DFS = real call order, so the array
  // index *is* the replay position. no startedAt sort: those tie at ms resolution.
  const total = filtered.nodes.length;
  const shown = Math.min(reveal, total);
  const activeId = shown > 0 ? filtered.nodes[shown - 1].id : null;

  const visible = useMemo(() => {
    const rn = filtered.nodes.slice(0, shown).map((n) => {
      const cls = [];
      if (n.data && n.data.error) cls.push("cyc-err");
      if (n.id === activeId) cls.push("active");
      return { ...n, className: cls.join(" ") || undefined, data: { ...n.data, active: n.id === activeId } };
    });
    const revealed = new Set(rn.map((n) => n.id));
    const re = filtered.edges
      .filter((e) => revealed.has(e.source) && revealed.has(e.target))
      .map((e) => ({ ...e, animated: true }));
    return { nodes: rn, edges: re };
  }, [filtered, shown, activeId]);

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
    setCollapsed((c) => { const n = new Set(c); n.delete(nid); return n; });

  return (
    <div id="flowwrap">
      <ReactFlow
        nodes={visible.nodes}
        edges={visible.edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesState}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={3}
        proOptions={{ hideAttribution: false }}
        colorMode="light"
      >
        <Background gap={18} size={1} color="#e2e8f0" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
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
            <FlowDetail detail={info.detail} nid={info.nid} onExpand={onExpand} />
          </div>
        )}
      </ReactFlow>
    </div>
  );
}

// glides after the frame just revealed; zooms out to show everything at the end
function CameraRig({ follow, shown, total, activeId }) {
  const { fitView, setCenter, getNode } = useReactFlow();
  const didFit = useRef(false);
  const wasAll = useRef(false);
  useEffect(() => {
    if (shown === 0 || !activeId) return;
    if (shown >= total) {
      // whole tree visible: pull back once so the finale shows everything
      if (!wasAll.current) {
        wasAll.current = true;
        fitView({ padding: 0.2, duration: 350, maxZoom: 1.2 });
      }
      return;
    }
    wasAll.current = false;
    if (follow) {
      const n = getNode(activeId);
      if (n) setCenter(n.position.x + NODE_W / 2, n.position.y + 20, { zoom: 1, duration: 300 });
      return;
    }
    if (!didFit.current) {
      didFit.current = true;
      fitView({ padding: 0.2, duration: 200, maxZoom: 1.2 });
    }
  }, [shown, total, activeId, follow, fitView, setCenter, getNode]);
  return null;
}

function FlowDetail({ detail, nid, onExpand }) {
  if (!detail) return null;
  const argRows = detail.argRows || [];
  const outKey = (detail.rows[0] && detail.rows[0].key) || "return";
  return (
    <div className="cyc-card">
      <div className="cyc-name">{detail.name}</div>
      <div className="cyc-sec">args</div>
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
      <div className="cyc-card-actions">
        <button onClick={() => onExpand && onExpand(nid)}>collapse subtree</button>
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
