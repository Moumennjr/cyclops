// Rendering a call tree as text.
//
// The viewer draws the tree as a graph, which is the right shape for a person
// who wants to explore it. It is the wrong shape for anything reading a trace
// as text: a graph is 425 kB of JSON, most of it node positions, and an agent
// asked "what did this call" should not have to page through coordinates.
//
// So this is the other half of the presentation layer, and like flow-model.js
// it is deliberately free of both React and the DOM, which makes it testable
// and reusable from a plugin.
//
// The default rendering is ASCII with box-drawing characters and aligned
// columns, because alignment is what makes a tree scannable: the eye finds the
// argument list because the arguments all start at the same column.

import { fmt } from "./public/flow-model.js";

// How a value is shortened for display. Snapshots are already bounded, so this
// is mostly about one pathological return value not eating the whole budget.
function clip(text, max) {
  const s = String(text ?? "");
  if (typeof max !== "number" || max <= 0) return s;
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}

// "run.js:12" -- where a frame came from, when the trace knows.
function locationOf(frame) {
  const loc = frame && frame.loc;
  const line = loc && typeof loc.line === "number" ? loc.line : null;
  const file = loc && typeof loc.file === "string" && loc.file ? loc.file : null;
  if (file && line !== null) return `${file}:${line}`;
  if (file) return file;
  if (line !== null) return `L${line}`;
  return null;
}

function indent(depth) {
  return "  ".repeat(Math.max(0, depth));
}

/**
 * Renders a call tree as indented ASCII.
 *
 * options:
 *   maxDepth    stop below this depth (frames beyond are summarised as "+N more")
 *   maxFrames   hard cap on frames rendered; the rest are counted, not dropped
 *   args        show argument values           (default true)
 *   returns     show return values             (default true)
 *   location    show file:line per frame        (default true)
 *   timing      show duration per frame         (default false)
 *   indent      show call index at each depth   (default false)
 */
export function renderTree(roots, options = {}) {
  const {
    maxDepth = Infinity,
    maxFrames = 2000,
    args: showArgs = true,
    returns: showReturns = true,
    location: showLocation = true,
    timing: showTiming = false,
    indent: showIndex = false,
    argWidth = 40,
    returnWidth = 40,
  } = options;

  const lines = [];
  let rendered = 0;
  let total = 0;
  let truncatedAt = null;

  const visit = (frames, depth) => {
    for (const frame of frames || []) {
      total++;
      if (truncatedAt !== null) continue;
      if (rendered >= maxFrames) {
        truncatedAt = { depth, at: rendered };
        continue;
      }

      // A deeper cut is summarised rather than recursed into.
      if (depth >= maxDepth) {
        const kids = (frame.children || []).length;
        if (kids === 0) continue;
        lines.push(
          `${indent(depth)}${prefix(depth, showIndex)}… +${countBelow(frame)} more nested call(s)`,
        );
        rendered++;
        continue;
      }

      lines.push(formatFrame(frame, depth, {
        showArgs, showReturns, showLocation, showTiming, showIndex,
        argWidth, returnWidth,
      }));
      rendered++;
      visit(frame.children, depth + 1);
    }
  };

  visit(roots, 0);

  if (truncatedAt) {
    lines.push(
      `${indent(truncatedAt.depth)}… trace truncated at ${rendered} frames (${total} total)`,
    );
  }
  return lines.join("\n");
}

function prefix(depth, showIndex) {
  return showIndex ? `${String(depth).padStart(2, " ")}| ` : "";
}

function countBelow(frame) {
  let n = 0;
  const walk = (list) => {
    for (const f of list || []) {
      n++;
      walk(f.children);
    }
  };
  walk(frame.children);
  return n;
}

function formatFrame(frame, depth, opts) {
  const parts = [];
  if (opts.showIndex) parts.push(`${String(depth).padStart(2, " ")}|`);
  parts.push(`${frame.name || "?"}(`);

  if (opts.showArgs && Array.isArray(frame.args) && frame.args.length) {
    parts.push(frame.args.map((a) => clip(fmt(a), opts.argWidth)).join(", "));
  }
  parts.push(")");

  if (opts.showLocation) {
    const loc = locationOf(frame);
    if (loc) parts.push(`@ ${loc}`);
  }

  if (opts.showTiming && typeof frame.duration === "number") {
    parts.push(`[${frame.duration}ms]`);
  }

  if (frame.error) {
    parts.push(`THROWS ${frame.error.name}: ${clip(frame.error.message, 60)}`);
  } else if (opts.showReturns) {
    parts.push("-> ");
    parts.push(clip(fmt(frame.return), opts.returnWidth));
  } else if (frame.endedAt === null) {
    parts.push("-> (never returned)");
  }

  return indent(depth) + parts.join(" ");
}

/**
 * One line per frame, no nesting. For "which functions ran and how long did
 * each take" when the shape of the tree is not the question.
 */
export function renderFlat(roots, options = {}) {
  const { maxFrames = 500, timing = true } = options;
  const rows = [];
  const walk = (list, depth) => {
    for (const frame of list || []) {
      rows.push({
        depth,
        name: frame.name || "?",
        location: locationOf(frame),
        duration: typeof frame.duration === "number" ? frame.duration : null,
        self: selfDuration(frame),
        error: frame.error || null,
        args: Array.isArray(frame.args) ? frame.args.length : 0,
      });
      walk(frame.children, depth + 1);
    }
  };
  walk(roots, 0);

  const shown = rows.slice(0, maxFrames);
  const width = Math.max(4, ...shown.map((r) => r.name.length));
  const lines = shown.map((r) => {
    const dur = timing && r.duration !== null ? `${String(r.duration).padStart(6)}ms` : "      ";
    const loc = (r.location || "").padEnd(18).slice(0, 18);
    const flag = r.error ? " !" : "";
    return `${"  ".repeat(r.depth)}${r.name.padEnd(width)} ${dur}  ${loc}${flag}`;
  });
  if (rows.length > maxFrames) {
    lines.push(`… ${rows.length - maxFrames} more frame(s)`);
  }
  return lines.join("\n");
}

// A frame's own time, minus what it spent inside children.
//
// Duration is wall-clock and children are inside it, so a slow leaf and a slow
// middle are very different problems and only self time tells them apart.
export function selfDuration(frame) {
  if (typeof frame.duration !== "number") return null;
  let childTotal = 0;
  for (const child of frame.children || []) {
    if (typeof child.duration === "number") childTotal += child.duration;
  }
  return Math.max(0, frame.duration - childTotal);
}

// Aggregates every frame by name. The "which function dominates" question has a
// hundred forms and this one answer.
export function aggregate(roots) {
  const byName = new Map();
  const visit = (frames) => {
    for (const frame of frames || []) {
      const name = frame.name || "?";
      if (!byName.has(name)) {
        byName.set(name, {
          name,
          calls: 0,
          totalMs: 0,
          selfMs: 0,
          maxMs: 0,
          errors: 0,
          locations: new Set(),
        });
      }
      const row = byName.get(name);
      row.calls++;
      if (typeof frame.duration === "number") {
        row.totalMs += frame.duration;
        row.maxMs = Math.max(row.maxMs, frame.duration);
      }
      const self = selfDuration(frame);
      if (self !== null) row.selfMs += self;
      if (frame.error) row.errors++;
      const loc = locationOf(frame);
      if (loc) row.locations.add(loc);
      visit(frame.children);
    }
  };
  visit(roots);
  return [...byName.values()].map((row) => ({
    ...row,
    locations: [...row.locations],
  }));
}

export { locationOf };