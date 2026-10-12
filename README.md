# Cyclops v2

Two questions, one engine.

```bash
cyclops map src/                  # what IS this codebase   (static, no execution)
cyclops src/ --watch              # what HAPPENED           (runtime trace)
cyclops trace-fn lib.js add --arg 3 --arg 4   # what did THIS function do
```

The map reads a project without running it: modules, the functions in them,
what imports what, what calls what. The trace runs a program and records every
call. Neither is much use alone, and they share one page in the browser.

**v1 was only the second half.** The map is new in v2, and so is the bridge
between them.

---

## At a glance

```bash
# the map
cyclops map src/                  # the analysis: load-bearing code, cycles, dead code
cyclops map src/ --map            # the whole map as indented text
cyclops map src/ --edges          # one line per edge, greppable
cyclops map src/ --open           # draw it in the browser
cyclops map "src/**/*.ts" --tests --external

# the trace
cyclops src/ --summary            # where the time went, what threw
cyclops src/ --tree --focus parse # one function's subtree
cyclops src/ --save-baseline      # remember this run
cyclops src/ --baseline out/tree.json   # what got slower
cyclops src/ --watch              # re-trace on every change

# the bridge
cyclops trace-fn lib.js parse --arg '"{}"'
```

`--summary`, `/summary` and the agent plugin share one renderer, so a number in
one is the number in the others.

---

## 1. The map

### What it tells you

```
25 files · 25 modules · 135 functions
36 imports · 187 calls (20 inferred, 0 ambiguous)

## load-bearing
  walk    3374.2  src/snapshot.js

## largest blast radius
  (what breaks if this file changes)
  plugins.js   18 file(s)

## import cycles
  2 modules: a.js → b.js → a.js

## no caller inside the project
  (NOT necessarily dead -- see the caveat)
  layoutMap   src/maplayout.js  — exported from a module nothing else imports
```

### Confidence, everywhere

Every edge says how it was established, and the drawn map shows it:

| | meaning | drawn as |
|---|---|---|
| `EXTRACTED` | read straight from the AST, or resolved through an import | solid grey |
| `INFERRED` | the name resolved, but the target is a good guess | dashed amber |
| `AMBIGUOUS` | several candidates; none chosen | dotted red |

Resolution is name-based and therefore fallible, so it runs in tiers:
same-file exact name → import binding → unique project-wide → ambiguous.
Dropping what it cannot resolve would make the map cleaner and *wrong*, and a
map that lies about its own edges is worse than no map.

Built-ins (`String`, `Math.max`, `setTimeout`) are not nodes. They are not facts
about your codebase, and a node for every global in the language sitting next to
your own functions makes the real structure illegible.

### The caveat that matters

> **A function with no caller inside the project may still be called by an export
> for another package, a framework convention, a test, a string passed to a
> runner, or code the scanner could not parse.**

This is a shortlist to check, not a list to delete from. The report says so in a
dedicated section and quotes the skipped-file count, because every unparseable
file is code the map has no opinion about.

### What the map will not do

- Only **relative** imports are resolved. `node_modules` is out of scope.
- **Names are resolved lexically**, not by type. A local variable shadowing an
  import is indistinguishable from the import, statically.
- **`--max-files 500`** by default, and **400 nodes** in the drawn map. Past
  that, no layout is readable, and the map says so rather than truncating
  silently.
- A method needs an instance, so `trace-fn` on one reports a placeholder rather
  than inventing a constructor.

---

## 2. The bridge

The map says a function exists. The trace says what it did. Connecting them used
to mean: find the entry point, edit it or write a harness, run it, read the
trace. Three steps of friction between the question and the answer.

```bash
cyclops trace-fn lib.js add --arg 3 --arg 4    # confidence: caller
cyclops trace-fn lib.js scale                  # confidence: guess
cyclops trace-fn lib.js add --json             # show the harness, run nothing
```

A function is not a program — `renderTree(roots)` cannot be called with nothing
— so arguments have to be invented, and the result says which it used:

| | meaning |
|---|---|
| `caller` | the arguments came from you |
| `default` | taken from the signature |
| `guess` | synthesised from parameter names; each guess is named |

A trace from a guess is worth having and must be labelled. A tree that claims to
show `renderTree` but actually threw on frame 0 is worse than no tree.

`--arg` values are JS literals: `--arg 1`, `--arg '"hello"'`, `--arg '[1,2]'`.

Callers found in the map are reported, because real arguments from a real call
beat anything this could invent:

```
[cyclops] harness for add() — confidence: guess
  called by: process (src/cli.js:142)
  re-run with --arg to use a real call's arguments instead of a guess
```

---

## The OpenCode plugin

### Install

```jsonc
// .opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./.opencode/plugins/cyclops.js"]
}
```

```js
// .opencode/plugins/cyclops.js
export { CyclopsPlugin } from "cyclops/plugin";
```

That's the whole setup. There is nothing to build and no dependency to add:
`@opencode-ai/plugin` is imported dynamically and is optional, so the plugin
loads whether or not the host happens to have it.

Restart opencode, and `cyclops_trace` is available.

### What it does

It runs a program and returns its call tree **as text**, so an agent can read
control flow that source alone does not reveal — which of six `validate` calls
actually ran, how async calls interleaved, that an early return explains the
value.

It deliberately does not return `graph.json`. That is ~425 kB, mostly node
coordinates, which would eat the context window before the agent learned
anything. It returns a summary plus a bounded slice, writes the full trace to
disk on request, and tells the agent how to narrow the next call.

### Arguments

| Arg | Type | Default | What it does |
|---|---|---|---|
| `target` | string | *required* | file, directory, or glob (`src/**/*.ts`) |
| `view` | `summary` \| `tree` \| `flat` | `summary` | what shape to return |
| `focus` | string | — | scope everything to one function's subtree |
| `maxDepth` | number | 12 | tree depth cap (`view: "tree"`) |
| `maxFrames` | number | 2000 | hard frame cap |
| `timing` | boolean | true | show per-frame durations |
| `outFile` | string | — | write the full trace JSON here |
| `keepTree` | boolean | false | write `out/tree.json` so the viewer can be opened |

### Examples

```
cyclops_trace({ target: "src/cli.ts" })
cyclops_trace({ target: "src/", focus: "parse", view: "tree" })
cyclops_trace({ target: "src/**/*.js", view: "flat" })
cyclops_trace({ target: "src/server.js", keepTree: true })
```

### What it returns

Program output first, then the requested view, then a footer of facts the agent
should not have to infer:

```
## program output

total = 6

# src/async.js

10 frames · 2 roots · depth 3 · wall clock 41ms

## where the time went

  ████████████ load      21ms total   20ms self   2 calls  async.js:7
  ███████ main           12ms total    <1ms self   1 call   async.js:12

## called most often

  load                 2 calls

— 3 imported file(s) instrumented as well
```

Output goes first on purpose: when a program prints something and then fails,
that output is the reason, and burying it under a call tree would be backwards.

The footer reports how many files were instrumented, whether the program exited
non-zero, and any construct that could not be traced — so a partial trace is
never mistaken for a complete one.

Output is capped at 120 kchars, cut on a line boundary, with a note saying how
to narrow it.

---

## Programmatic use

```js
import { trace, summarize, renderTree, findFrames } from "cyclops";
import { buildMap } from "cyclops/map";
import { layoutMap, renderMap } from "cyclops/maplayout";
import { analyzeMap, renderMapReport } from "cyclops/mapanalyze";
import { harnessFor, callersInMap } from "cyclops/harness";

const map = layoutMap(buildMap("src"));
console.log(renderMapReport(map));

const result = trace("src/cli.ts", { cwd: process.cwd() });

if (result.ok) {
  console.log(summarize(result.tree.roots));
  console.log(renderTree(result.tree.roots, { maxDepth: 4, timing: true }));
}
```

Options: `cwd`, `timeoutMs`, `maxFrames`, `env`, `input`, `keepShadows`.

`trace()` never calls `process.exit`, never writes to stdout or stderr, and
never reads `process.argv`. It returns:

```js
{
  ok, error,            // a program that threw is ok:true with its exit code
  tree,                 // { roots: [...] } or null
  exitCode, signal,
  stdout, stderr,       // the child's own output, returned not forwarded
  warnings,             // anything that could not be instrumented
  entry,                // which file was chosen as the entry point
  sourceFiles,          // every file the trace instrumented
  instrumented,         // how many imported files were traced too
  droppedFrames,        // frames skipped by the capture cap (0 = complete)
  bufferOverflow,       // the trace exceeded the 512MB capture buffer
  timedOut,             // the program was stopped at the timeout
}
```

Lower-level: `traceFile`, `traceToFile`, `prepare`/`cleanup` to manage the
instrumented copies yourself, plus `planEntry` to see which file a target
resolves to.

---

## Over HTTP

While `cyclops` is serving, the same information is available to anything that
can make a request:

| Route | Returns |
|---|---|
| `/tree.json` | the raw trace (what the browser loads) |
| `/map.json` | the raw project map |
| `/summary` | where the time went, what threw — `text/plain` |
| `/tree` | indented call tree — `text/plain` |
| `/flat` | one line per frame — `text/plain` |
| `/summary.json` | stats + aggregate + errors — JSON |
| `/flat.json` | frames with name/depth/duration — JSON |

All take `?focus=<name>`. `/tree` takes `?maxDepth=` and `?timing=0`.

```bash
curl -s localhost:4600/summary
curl -s "localhost:4600/tree?focus=handleRequest"
curl -s localhost:4600/summary.json | jq .aggregate[0]
curl -s localhost:4600/map.report      # the map's analysis
curl -s localhost:4600/map.edges | grep '^~'   # just the guessed edges
```

This is how you get a trace into anything that can make an HTTP request but
cannot run Node — a shell script, a CI job, a different language.

---

## Editor

```vim
" ~/.vimrc
source /path/to/cyclops/editors/cyclops.vim
```

| Command | Does |
|---|---|
| `:CyclopsTrace [target]` | trace and open the viewer |
| `:CyclopsSummary` | summary in the quickfix window |
| `:CyclopsTree` | the trace as an indented tree |
| `:CyclopsFocus <name>` | one function's subtree |
| `:CyclopsOpen` | reopen the viewer |

`g:cyclops_bin` and `g:cyclops_port` override the binary and port.

`:CyclopsSummary` reads the trace already on disk rather than re-running the
program — a keybinding should not quietly re-execute something with side
effects.

---

## Watching

```bash
cyclops src/ --watch
```

Re-traces on any change to any file in the program — the entry *and* everything
it imports — and keeps serving. The viewer polls and rebuilds by itself, so the
graph updates without a reload.

```js
import { watchTrace } from "cyclops";

const ctl = watchTrace("src/", {
  cwd: process.cwd(),
  onResult: (r, reason) => console.log(reason, r.tree.roots.length),
});
ctl.refresh();   // re-trace now
ctl.stop();      // detach
```

---

## Comparing two runs

The question a tracer exists for, and one a single tree cannot answer.

```bash
cyclops src/ --save-baseline        # capture the reference
# ...edit something...
cyclops src/ --baseline out/tree.json
```

```
before: 7 frames, 1 root(s), depth 2, 5ms
after:  9 frames, 1 root(s), depth 2, 8ms
wall clock 5ms -> 8ms  +3ms +60%

## slower
  heavy       4ms -> 7ms  +3ms +75%

## new calls
  + brandNew     2 calls  <1ms self
```

The comparison is per function name, not structural: two runs of the same
program rarely have the same shape (an extra retry, a cache hit that was a miss,
different input), so a tree diff is mostly noise. And it is on **self** time,
because total time is wall clock with children inside it — "f got slower"
measured on total usually means something f called got slower.

Rows are ordered by absolute change, not by percentage: a function going from
2 ms to 9 ms matters more than one going from 2000 ms to 2010 ms.

Errors that appeared or went away are reported too, and are not mixed in with
the timing table.

---

## What cyclops will not trace

Being explicit, so an agent does not read a partial trace as a complete one:

- **Node builtins and `node_modules` are not instrumented.** `fs.readFileSync`
  is a leaf. Cyclops traces your code, not the runtime's.
- **A bare script with no imports** is traced fine, but only its own functions
  become frames — there is nothing else for it to call.
- **Only relative imports are followed.**
- **Frames carry a basename, not a full path.** Two files with the same name in
  different directories are ambiguous in one trace.
- **A directory target picks one entry** (ranked by name) rather than running
  every file. The choice is printed, never silent.
- **A program that hangs** is cut off at 60 s, and the frames that never closed
  are reported as such — the durations are partial.
- **Capture is capped at 250,000 frames** (change with `--max-frames`). Past
  that the program keeps running and its output is intact, but the tail of the
  trace is dropped — otherwise a tight loop is an out-of-memory kill that takes
  the traced program with it. A capped trace says so at the top of every
  summary, in the plugin's footer, and as `droppedFrames` on the raw result:

  ```
  !! 298001 frames not captured: the run hit its cap. Counts and totals
     below cover only what was kept
  ```

  That line is the whole reason the cap is safe to have. Without it, a capped
  trace reads as a complete observation — "noop, 1999 calls" when it was
  actually called 300,000 times.
- **The capture buffer is 512 MB.** A trace larger than that is reported as a
  buffer overflow rather than lost silently, so the cause is never a mystery.
- **JSX is compiled with the automatic runtime**, so a component file works
  whether or not it imports React.

---

## Dialects

`.js` `.mjs` `.cjs` `.jsx` `.ts` `.mts` `.cts` `.tsx`

Generators, async generators, decorators, private fields, class static blocks,
top-level await, CommonJS, and callbacks deferred through any scheduler are all
traced. Compiler helpers (`__privateGet`, `__decorateClass`, …) are filtered out
so they do not bury your own calls.