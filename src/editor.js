// The two helpers the editor plugin needs, in JavaScript.
//
// editors/cyclops.vim implements the same two algorithms in vimscript, because
// a vimscript file cannot import from here. That means the algorithm exists
// twice, which is normally a smell -- so the contract is:
//
//   * this file is the readable one and the one the test suite covers
//   * the vimscript is the small one; it is a direct transcription and is kept
//     free of anything clever so the two can be compared by reading
//
// What the editor actually needs is small. It cannot run Node (no child process
// in a quickfix window), so it reads out/tree.json -- which the tracer has
// already written -- and formats it. Tracing stays the CLI's job.

/**
 * Depth-first list of {name, depth, dur}, level by level.
 *
 * Returns a flat list rather than a nested one because every caller walks it
 * exactly once and only ever needs the depth for indentation. Keeping the tree
 * structure would be a second representation to keep in sync with the first.
 */
export function flattenForEditor(roots) {
  const out = [];
  let queue = [...(roots || [])];
  let depth = 0;

  while (queue.length) {
    const batch = [];
    const next = [];
    for (const frame of queue) {
      batch.push({
        name: frame.name ?? "?",
        depth,
        dur: typeof frame.duration === "number" ? frame.duration : -1,
        frame,
      });
      next.push(...(frame.children || []));
    }
    out.push(...batch);
    queue = next;
    depth++;
  }
  return out;
}

/**
 * Per-name totals: {name, count, total}.
 *
 * `count` is the number of invocations, not the number of lines, so a recursive
 * function shows up honestly -- in a tree it is N nested frames and easy to miss.
 */
export function aggregateForEditor(roots) {
  const rows = new Map();
  for (const item of flattenForEditor(roots)) {
    if (!rows.has(item.name)) {
      rows.set(item.name, { name: item.name, count: 0, total: 0 });
    }
    const row = rows.get(item.name);
    row.count += 1;
    row.total += Math.max(item.dur, 0);
  }
  return [...rows.values()];
}