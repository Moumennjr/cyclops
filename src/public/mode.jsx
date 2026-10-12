// The switch between the two halves of v2.
//
// Kept out of main.jsx on purpose: the trace is a large component with its own
// state and lifecycle, and making its root re-mount on a mode change would tear
// down the polling interval, the replay position and the camera for what is
// really a different page. Two entry points, one header, no re-mount.
//
// The Map tab is disabled until /whoami confirms a map exists. Disabling beats
// showing an empty page that says "run cyclops map ." -- the header should not
// offer a thing that is not there.

import { createRoot } from "react-dom/client";
import ProjectMap from "./mapview.jsx";

const traceButton = document.getElementById("cyc-mode-trace");
const mapButton = document.getElementById("cyc-mode-map");
const root = document.getElementById("root");

let mapMounted = false;
let mode = "trace";

function setMode(next) {
  if (next === mode) return;
  mode = next;

  if (next === "map") {
    root.innerHTML = "";
    createRoot(root).render(<ProjectMap />);
    mapMounted = true;
  } else {
    // A full reload rather than a re-render: the trace's state machine starts
    // clean, which is what someone switching back from the map wants anyway.
    window.location.href = "/";
    return;
  }

  traceButton.setAttribute("aria-pressed", String(next === "trace"));
  mapButton.setAttribute("aria-pressed", String(next === "map"));
  document.title = next === "map"
    ? "Cyclops — project map"
    : "Cyclops — execution trace";
}

traceButton.addEventListener("click", () => setMode("trace"));
mapButton.addEventListener("click", () => setMode("map"));

// Ask once whether a map exists. A failed probe leaves the tab enabled: the map
// view reports its own absence properly, and refusing to offer it on a network
// hiccup would be worse than showing a message.
(async () => {
  try {
    const res = await fetch("/whoami");
    if (!res.ok) return;
    const info = await res.json();
    if (!info || !info.mapPath) {
      mapButton.disabled = true;
      mapButton.title = "No map yet — run: cyclops map .";
      return;
    }
    mapButton.title = info.mapPath;
  } catch {
    /* leave it enabled */
  }
})();

window.addEventListener("popstate", () => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("view") === "map" && !mapMounted && mode === "trace") {
    setMode("map");
  }
});

if (new URLSearchParams(window.location.search).get("view") === "map") {
  setMode("map");
}