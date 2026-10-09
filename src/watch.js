// Re-tracing a program when its source changes.
//
// The workflow this exists for: you are editing a function, you want to know
// what it now calls and whether it got slower. Without watch, that loop is
//
//     edit -> cyclops file -> read -> edit -> cyclops file -> read
//
// which is two commands and a browser restart per iteration. With watch it is
//
//     edit -> (the tree updates under you)
//
// The viewer already polls /tree.json every second and rebuilds when `version`
// changes, so nothing here touches the viewer: watch's whole job is to re-run
// the tracer when a source file changes and write a new tree.json.
//
// Debouncing matters more than it looks. An editor save often writes a file
// several times in a few hundred milliseconds (write, rename, chmod), and
// tracing on each one spawns a Node process per event.

import { watch as fsWatch, statSync, existsSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { traceToFile } from "./engine.js";
import { TRACEABLE } from "./targets.js";

const DEFAULT_DEBOUNCE_MS = 250;

/**
 * Traces `target` now, then again whenever one of the files it touched changes.
 *
 * Returns a controller with `stop()` and `lastResult`. Does not take over the
 * terminal -- events go to `onResult` -- so the same controller can drive an
 * HTTP response, a test harness, or a CLI status line.
 *
 * options:
 *   cwd        working directory for both the trace and the watcher
 *   outFile    where to write the tree          (default out/tree.json)
 *   debounceMs quiet period after a change       (default 250)
 *   onResult   called with each result           (default: no-op)
 *   onError    called when a trace fails         (default: no-op)
 *   initial    trace once on start               (default true)
 */
export function watchTrace(target, options = {}) {
  const {
    cwd = process.cwd(),
    outFile = join(cwd, "out", "tree.json"),
    debounceMs = DEFAULT_DEBOUNCE_MS,
    onResult = () => {},
    onError = () => {},
    initial = true,
    // Files a previous, external trace already instrumented. A caller that has
    // just run the program itself (the CLI does) passes them here so the watcher
    // starts informed instead of running it a second time to learn nothing new.
    knownSources = null,
  } = options;

  let stopped = false;
  let timer = null;
  let lastResult = null;
  let watchers = [];

  // The set of files that matter: the entry plus everything it imports. Watching
  // the whole tree would re-run the program on an unrelated file and, worse,
  // would loop -- the tracer writes shadows beside the sources, so watching
  // everything means watching its own output.
  const watched = new Set();

  // A caller that already ran the program passes the files that trace
  // instrumented, so the watcher starts informed instead of running it a second
  // time to learn what it could have been told.
  if (knownSources) {
    for (const file of knownSources) {
      if (existsSync(file)) watched.add(resolve(file));
    }
  }

  const runOnce = (reason) => {
    if (stopped) return null;
    const result = traceToFile(target, { cwd, outFile });
    lastResult = result;

    if (!result.ok) {
      onError(result.error, reason);
      return result;
    }

    // Every file that went into the trace, not just the entry: a change to
    // `step.js` changes what the program does just as much as a change to the
    // entry does. Watching only the entry was the first version's bug.
    const entry = resolve(result.entry ?? target);
    if (existsSync(entry)) watched.add(entry);
    for (const file of result.sourceFiles ?? []) {
      if (existsSync(file)) watched.add(resolve(file));
    }

    onResult(result, reason);
    return result;
  };

  const schedule = (changed) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      runOnce(changed ? `changed: ${changed}` : "manual");
    }, debounceMs);
    // A pending re-trace must not hold the process open on its own.
    timer.unref?.();
  };

  const watchFiles = () => {
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // already closed
      }
    }
    watchers = [];

    for (const file of watched) {
      if (!existsSync(file)) continue;
      try {
        watchers.push(
          fsWatch(file, { persistent: false }, () => schedule(file)),
        );
      } catch {
        // A file that cannot be watched is simply not watched; the next manual
        // run still works.
      }
    }
  };

  if (initial && !knownSources) {
    runOnce("initial");
  }
  watchFiles();

  return {
    /** Re-trace now, without waiting for a change. */
    refresh: () => runOnce("manual"),
    /** Watch an additional file, e.g. one added to the import graph. */
    addWatched(file) {
      watched.add(resolve(file));
      watchFiles();
    },
    /** The files currently being watched, for display or assertions. */
    watchedFiles: () => [...watched],
    get lastResult() {
      return lastResult;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // already closed
        }
      }
      watchers = [];
    },
  };
}

// True when a path is one cyclops could trace. Exported so a caller filtering
// its own watcher uses exactly the same list the tracer does.
export function isWatchable(file) {
  return TRACEABLE.includes(extname(file).toLowerCase());
}

export { statSync };