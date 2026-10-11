// Comparing two traces: did my change help?
//
// This is the question a tracer exists for, and until now cyclops could not
// answer it. A tree shows one run; knowing whether a change made a program
// faster needs two, compared.
//
// The comparison is on per-name aggregates rather than on trees. Two runs of the
// same program rarely produce the same shape -- an extra retry, a cache hit that
// was a miss last time, a different input -- so a structural diff is mostly
// noise. Aggregating by name first asks the question that survives both
// differences: which function got slower, and by how much.
//
// Timings are compared on *self* time, for the reason already established in
// render.js: total time is wall clock with children inside it, so "f got slower"
// measured on total usually means something f called got slower.

import { aggregate } from "./render.js";
import { stats, errorReport } from "./analyze.js";

function ms(n) {
  if (typeof n !== "number" || !isFinite(n)) return "?";
  if (n < 1) return "<1ms";
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

function signed(n) {
  const v = Math.round(n);
  return v > 0 ? `+${v}` : String(v);
}

function pct(change, from) {
  if (!from) return null;
  const p = Math.round((change / from) * 100);
  return p === 0 ? "0%" : p > 0 ? `+${p}%` : `${p}%`;
}

/**
 * Compares two traces and reports what changed.
 *
 * Returns {
 *   added:    functions present in `after` but not `before`
 *   removed:  present in `before` but not `after`
 *   slower:   present in both, self time up
 *   faster:   present in both, self time down
 *   unchanged
 *   deltas:   one row per shared function, sorted by |change|
 *   stats:    frames / roots / depth / span, before and after
 *   errors:   errors introduced and resolved
 * }
 *
 * `noiseMs` suppresses changes smaller than it. Timing noise on a fast machine
 * is a couple of milliseconds, and a diff that reports every sub-millisecond
 * wobble as a regression is one nobody reads.
 */
export function diffTrees(before, after, options = {}) {
  const { noiseMs = 1 } = options;

  const a = new Map(aggregate(before).map((r) => [r.name, r]));
  const b = new Map(aggregate(after).map((r) => [r.name, r]));

  const added = [];
  const removed = [];
  const slower = [];
  const faster = [];
  const unchanged = [];
  const deltas = [];

  for (const [name, row] of b) {
    if (!a.has(name)) {
      added.push(row);
      continue;
    }
    const before = a.get(name);
    const change = row.selfMs - before.selfMs;
    deltas.push({
      name,
      fromSelfMs: before.selfMs,
      toSelfMs: row.selfMs,
      change,
      changePct: pct(change, before.selfMs),
      fromCalls: before.calls,
      toCalls: row.calls,
      callDelta: row.calls - before.calls,
      fromTotalMs: before.totalMs,
      toTotalMs: row.totalMs,
      errorsBefore: before.errors,
      errorsAfter: row.errors,
    });
  }

  for (const [name, row] of a) {
    if (!b.has(name)) removed.push(row);
  }

  for (const row of deltas) {
    if (Math.abs(row.change) < noiseMs) unchanged.push(row);
    else if (row.change > 0) slower.push(row);
    else faster.push(row);
  }

  // Biggest absolute self-time regression first: that is the one worth
  // investigating, and it is not necessarily the slowest function overall.
  const byImpact = (x, y) => Math.abs(y.change) - Math.abs(x.change);
  slower.sort(byImpact);
  faster.sort(byImpact);

  const beforeErrors = new Map(
    errorReport(before).map((e) => [`${e.name}: ${e.message}`, e]),
  );
  const afterErrors = new Map(
    errorReport(after).map((e) => [`${e.name}: ${e.message}`, e]),
  );

  return {
    added,
    removed,
    slower,
    faster,
    unchanged,
    deltas: [...deltas].sort(byImpact),
    stats: { before: stats(before), after: stats(after) },
    errors: {
      introduced: [...afterErrors.entries()]
        .filter(([k]) => !beforeErrors.has(k))
        .map(([, e]) => e),
      resolved: [...beforeErrors.entries()]
        .filter(([k]) => !afterErrors.has(k))
        .map(([, e]) => e),
      persisting: [...afterErrors.entries()]
        .filter(([k]) => beforeErrors.has(k))
        .map(([, e]) => e),
    },
  };
}

/** A readable diff, ordered by how much it should worry the reader. */
export function renderDiff(result, options = {}) {
  const { maxRows = 10, labels = { before: "before", after: "after" } } = options;
  const lines = [];

  const bs = result.stats.before;
  const as = result.stats.after;
  lines.push(
    `${labels.before}: ${bs.frames} frames, ${bs.roots} root(s), depth ${bs.maxDepth}` +
      (bs.spanMs !== null ? `, ${ms(bs.spanMs)}` : ""),
  );
  lines.push(
    `${labels.after}: ${as.frames} frames, ${as.roots} root(s), depth ${as.maxDepth}` +
      (as.spanMs !== null ? `, ${ms(as.spanMs)}` : ""),
  );

  const wall = bs.spanMs !== null && as.spanMs !== null ? as.spanMs - bs.spanMs : null;
  if (wall !== null) {
    lines.push(
      `wall clock ${ms(bs.spanMs)} -> ${ms(as.spanMs)}` +
        `  ${signed(wall)}ms ${pct(wall, bs.spanMs) ?? ""}`,
    );
  }
  lines.push("");

  if (result.errors.introduced.length) {
    lines.push("## errors introduced");
    for (const e of result.errors.introduced.slice(0, 5)) {
      lines.push(`  + ${e.name}: ${e.message}${e.origin ? ` (${e.origin})` : ""}`);
    }
    lines.push("");
  }
  if (result.errors.resolved.length) {
    lines.push("## errors resolved");
    for (const e of result.errors.resolved.slice(0, 5)) {
      lines.push(`  - ${e.name}: ${e.message}${e.origin ? ` (${e.origin})` : ""}`);
    }
    lines.push("");
  }

  if (result.slower.length) {
    lines.push("## slower");
    for (const row of result.slower.slice(0, maxRows)) {
      lines.push(
        `  ${row.name.padEnd(24)} ${ms(row.fromSelfMs)} -> ${ms(row.toSelfMs)}` +
          `  ${signed(row.change)}ms ${row.changePct ?? ""}` +
          (row.callDelta ? `  calls ${row.fromCalls} -> ${row.toCalls}` : ""),
      );
    }
    lines.push("");
  }

  if (result.faster.length) {
    lines.push("## faster");
    for (const row of result.faster.slice(0, maxRows)) {
      lines.push(
        `  ${row.name.padEnd(24)} ${ms(row.fromSelfMs)} -> ${ms(row.toSelfMs)}` +
          `  ${signed(row.change)}ms ${row.changePct ?? ""}` +
          (row.callDelta ? `  calls ${row.fromCalls} -> ${row.toCalls}` : ""),
      );
    }
    lines.push("");
  }

  if (result.added.length) {
    lines.push("## new calls");
    for (const row of result.added.slice(0, maxRows)) {
      lines.push(`  + ${row.name.padEnd(24)} ${plural(row.calls)}  ${ms(row.selfMs)} self`);
    }
    lines.push("");
  }

  if (result.removed.length) {
    lines.push("## no longer called");
    for (const row of result.removed.slice(0, maxRows)) {
      lines.push(`  - ${row.name.padEnd(24)} was ${plural(row.calls)}`);
    }
    lines.push("");
  }

  if (!result.slower.length && !result.faster.length &&
      !result.added.length && !result.removed.length) {
    lines.push("no measured difference");
  }

  return lines.join("\n").trimEnd();
}

function plural(n) {
  return `${n} call${n === 1 ? "" : "s"}`;
}