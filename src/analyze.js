// Questions a call tree can answer, and a report that answers them in one read.
//
// The raw tree answers "what did this call" if you already know where to look.
// It does not answer the questions people actually open a tracer with:
//
//   which function dominates       -- wall-clock hides this; children are inside
//   which function is called most   -- recursion and retries hide as one line
//   where does the time go          -- self time vs total time
//   what threw                     -- and how far did it propagate
//   what is unusually deep          -- the shape a bug usually has
//
// summarize() answers all five, ordered by how much they usually matter, in text
// that fits on a screen. Nothing here is clever: it is aggregate(), a couple of
// passes, and the discipline to report a measurement as a measurement.

import { fmt } from "./public/flow-model.js";
import { aggregate, selfDuration } from "./render.js";

// Total frames, depth, roots, and the wall-clock span of the whole run.
export function stats(roots) {
  let frames = 0;
  let maxDepth = 0;
  let errors = 0;
  let open = 0;
  let minStart = null;
  let maxEnd = null;
  let exclusive = 0;

  const walk = (list, depth) => {
    for (const frame of list || []) {
      frames++;
      maxDepth = Math.max(maxDepth, depth);
      if (frame.error) errors++;
      if (frame.endedAt === null) open++;
      if (typeof frame.startedAt === "number") {
        minStart = minStart === null ? frame.startedAt : Math.min(minStart, frame.startedAt);
      }
      if (typeof frame.endedAt === "number") {
        maxEnd = maxEnd === null ? frame.endedAt : Math.max(maxEnd, frame.endedAt);
      }
      const self = selfDuration(frame);
      if (self !== null) exclusive += self;
      walk(frame.children, depth + 1);
    }
  };
  walk(roots, 0);

  return {
    frames,
    roots: (roots || []).length,
    maxDepth,
    errors,
    open,
    spanMs: minStart !== null && maxEnd !== null ? Math.max(0, maxEnd - minStart) : null,
    exclusiveMs: exclusive,
  };
}

// Every distinct error, with how many frames it crossed.
//
// The count matters more than the message: an error on 40 frames is one bug
// propagating, while the same error on 40 unrelated frames is 40 bugs.
export function errorReport(roots) {
  const byKey = new Map();
  const walk = (frames, depth) => {
    for (const frame of frames || []) {
      if (frame.error) {
        const key = `${frame.error.name}: ${frame.error.message}`;
        if (!byKey.has(key)) {
          byKey.set(key, {
            name: frame.error.name,
            message: frame.error.message,
            frames: 0,
            deepest: 0,
            sites: new Set(),
          });
        }
        const row = byKey.get(key);
        row.frames++;
        row.deepest = Math.max(row.deepest, depth);
        const loc = frame.loc && frame.loc.file
          ? `${frame.loc.file}:${frame.loc.line}`
          : null;
        if (loc) row.sites.add(loc);
        walk(frame.children, depth + 1);
        continue;
      }
      walk(frame.children, depth + 1);
    }
  };
  walk(roots, 0);
  return [...byKey.values()].map((row) => ({ ...row, sites: [...row.sites] }));
}

// The deepest chains in the tree: the paths most likely to hide stack overflow,
// runaway recursion, or an accidental cycle.
export function deepestPaths(roots, { top = 3, minLength = 8 } = {}) {
  const found = [];
  const walk = (frames, path) => {
    for (const frame of frames || []) {
      const next = [...path, frame];
      if (next.length >= minLength) {
        found.push({
          length: next.length,
          names: next.map((f) => f.name),
          sites: next.map((f) =>
            f.loc && f.loc.file ? `${f.loc.file}:${f.loc.line}` : null),
        });
      }
      walk(frame.children, next);
    }
  };
  walk(roots, []);
  // Longest first; a strict length compare keeps ties in first-seen order.
  found.sort((a, b) => b.length - a.length);
  const seen = new Set();
  const out = [];
  for (const path of found) {
    const key = path.names.join(">");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
    if (out.length >= top) break;
  }
  return out;
}

// Names that appear at more than one location: the usual cause of "I changed the
// function and nothing happened".
export function duplicateDefinitions(roots) {
  const byName = new Map();
  const walk = (frames) => {
    for (const frame of frames || []) {
      const file = frame.loc && frame.loc.file;
      if (!file) {
        walk(frame.children);
        continue;
      }
      const name = frame.name || "?";
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name).add(file);
      walk(frame.children);
    }
  };
  walk(roots);
  return [...byName.entries()]
    .filter(([, files]) => files.size > 1)
    .map(([name, files]) => ({ name, files: [...files] }))
    .sort((a, b) => b.files.length - a.files.length);
}

function ms(n) {
  if (typeof n !== "number" || !isFinite(n)) return "?";
  if (n < 1) return "<1ms";
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function bar(share, width = 20) {
  const filled = Math.max(0, Math.min(width, Math.round(share * width)));
  return "█".repeat(filled) || "";
}

/**
 * A short report: the numbers, then the five questions, in priority order.
 *
 * `focus` limits everything to one function's subtree, which is what makes this
 * usable on a large program -- "tell me about render" rather than "tell me
 * about the app".
 */
export function summarize(roots, options = {}) {
  const { focus = null, maxRows = 8, title = null } = options;

  let subject = roots;
  let focusNote = "";
  if (focus) {
    const matches = findFrames(roots, focus);
    subject = matches.map((m) => m.frame);
    focusNote = matches.length
      ? `focused on ${plural(matches.length, "frame")} matching "${focus}"`
      : `no frame matched "${focus}"; reporting the whole trace`;
  }

  const s = stats(subject);
  const agg = aggregate(subject).filter((r) => r.name !== "anonymous");
  const errors = errorReport(subject);

  const lines = [];
  if (title) lines.push(`# ${title}`, "");

  lines.push(
    `${plural(s.frames, "frame")} · ${plural(s.roots, "root")} · depth ${s.maxDepth}` +
      (s.spanMs !== null ? ` · wall clock ${ms(s.spanMs)}` : ""),
  );
  if (focusNote) lines.push(focusNote);
  lines.push("");

  // 1. Where the time went. Total first, because that is the number people
  //    quote, then self time, because that is the one that says "fix this".
  const bySelf = [...agg].sort((a, b) => b.selfMs - a.selfMs).slice(0, maxRows);
  if (bySelf.length) {
    const total = agg.reduce((sum, r) => sum + r.totalMs, 0) || 1;
    lines.push("## where the time went");
    lines.push("");
    for (const row of bySelf) {
      const share = row.totalMs / total;
      lines.push(
        `  ${bar(share)} ${row.name.padEnd(20)} ${ms(row.totalMs).padStart(8)} total  ` +
          `${ms(row.selfMs).padStart(8)} self  ${plural(row.calls, "call")}` +
          (row.locations.length ? `  ${row.locations[0]}` : ""),
      );
    }
    lines.push("");
  }

  // 2. Most-called. Recursion and retries collapse to one line in a tree, so
  //    this is frequently the only place the repetition is visible.
  const byCalls = [...agg].sort((a, b) => b.calls - a.calls).slice(0, 5);
  if (byCalls.length > 1) {
    lines.push("## called most often");
    lines.push("");
    for (const row of byCalls) {
      lines.push(`  ${row.name.padEnd(20)} ${plural(row.calls, "call")}`);
    }
    lines.push("");
  }

  // 3. Errors, with how far each propagated.
  if (errors.length) {
    lines.push("## errors");
    lines.push("");
    for (const row of errors.slice(0, 5)) {
      const site = row.sites.length ? ` at ${row.sites[0]}` : "";
      lines.push(
        `  ${row.name}: ${row.message}${site} — on ${plural(row.frames, "frame")}` +
          (row.frames > 1 ? ` (propagated up to depth ${row.deepest})` : ""),
      );
    }
    lines.push("");
  }

  // 4. Frames that never closed: a hung call, an abandoned generator, or a
  //    process killed mid-run. Worth saying out loud because it means the rest
  //    of the trace is incomplete.
  if (s.open > 0) {
    lines.push(
      `## ${plural(s.open, "frame")} never returned`,
      "  the run was cut short or a call never completed; durations above are partial",
      "",
    );
  }

  // 5. Two cheap smells, reported only when present.
  const deep = deepestPaths(subject, { top: 2 });
  if (deep.length) {
    lines.push("## deepest chains");
    lines.push("");
    for (const path of deep) {
      lines.push(`  ${path.length} deep: ${path.names.slice(-6).join(" -> ")}`);
    }
    lines.push("");
  }

  const dupes = duplicateDefinitions(subject);
  if (dupes.length) {
    lines.push("## same name in several files");
    lines.push("");
    for (const row of dupes.slice(0, 5)) {
      lines.push(`  ${row.name.padEnd(20)} ${row.files.join(", ")}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// Every frame whose name matches, with its path from the root. Used by the
// `focus` option above and directly by callers that know what they are after.
export function findFrames(roots, query, { limit = 200 } = {}) {
  const needle = String(query || "").toLowerCase();
  const out = [];
  const walk = (frames, path) => {
    for (const frame of frames || []) {
      const name = String(frame.name || "");
      const here = [...path, name];
      if (!needle || name.toLowerCase().includes(needle)) {
        out.push({
          id: frame.id,
          frame,
          depth: here.length - 1,
          path: here,
          duration: typeof frame.duration === "number" ? frame.duration : null,
          self: selfDuration(frame),
          error: frame.error || null,
        });
        if (out.length >= limit) return;
      }
      walk(frame.children, here);
      if (out.length >= limit) return;
    }
  };
  walk(roots, []);
  return out;
}

// The subtree of one frame id, as a standalone tree -- so a renderer can draw
// it, a summary can scope to it, and neither has to know about the rest.
export function subtree(roots, id) {
  const find = (frames) => {
    for (const frame of frames || []) {
      if (String(frame.id) === String(id)) return frame;
      const hit = find(frame.children);
      if (hit) return hit;
    }
    return null;
  };
  return find(roots);
}

export { fmt };