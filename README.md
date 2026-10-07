# Cyclops — language coverage

What cyclops can trace, and how it behaves when it cannot.

```bash
cyclops app.js              # one file
cyclops src/                # every traceable file in a directory
cyclops "src/**/*.ts"       # a glob
cyclops a.js b.ts           # first is the entry, the rest are instrumented
```

## Dialects

| Dialect | Extensions | Notes |
|---|---|---|
| JavaScript (ESM) | `.js` `.mjs` | the original target |
| JavaScript (CommonJS) | `.cjs`, or `.js` using `require` | detected from syntax, kept as `.cjs` |
| JSX | `.jsx` | lowered to `createElement` before instrumentation |
| TypeScript | `.ts` `.mts` `.cts` | types stripped before instrumentation |
| TSX | `.tsx` | types stripped, JSX lowered |

The dialect is chosen per file, from the extension and then from the file's own
syntax, so a `.js` file using `require` is traced as CommonJS whatever
`package.json` says, and a `.js` file using `import` is traced as ESM.

## Language features

All of these are traced:

- `function`, arrow functions (block and expression bodies), function expressions
- object/class methods, getters, setters, static methods, class expressions,
  computed method names, private methods (`#m()`) and private fields (`#v = 1`)
- class static initialization blocks
- `async`/`await`, including awaits inside loops, branches and `try`
- `for await...of` over both async and sync iterables
- generators and async generators, including `yield*` delegation
- top-level `await` in an ESM entry
- decorators on classes, methods and accessors
- destructured, defaulted and rest parameters; closures; recursion
- CommonJS `require`/`module.exports`, dynamic `import()`
- callbacks deferred through `setTimeout`, `setInterval`, `setImmediate`,
  `queueMicrotask`, `process.nextTick`, `globalThis.setTimeout`, promise hooks
  (`.then`/`.catch`/`.finally`), and user-defined schedulers such as
  `queue.enqueue(fn)` / `app.defer(fn)`

Every frame records args, return value, thrown error, start and end time, and
the file and line it came from. Values are snapshotted so cycles, `BigInt`,
`Symbol`, `NaN`, `Date`, `RegExp` and throwing getters all survive the trip
through JSON.

## How a file is processed

```
TypeScript / decorated / JSX source
  -> esbuild: strip types, lower JSX and decorators to plain calls
  -> Babel:   parse, and wrap every function in __enter / __ret / __err
  -> written beside the source as .cyclops-<name>-<pid>.{mjs,cjs}
  -> Node runs it; the tracer prints the tree, marker-delimited, on exit
  -> the CLI writes out/tree.json and serves the viewer
```

The file is written **beside the source**, never into a temp directory, so its
relative imports still resolve. Imported local files are instrumented the same
way, recursively, so a cross-file call is a real parent/child link in the tree
rather than a leaf that stops at the import boundary.

Bare specifiers (`react`, `node:fs`) are never rewritten — those belong to the
package manager, and code inside `node_modules` is not instrumented.

## Compiler helpers are not frames

TypeScript private fields lower to `__privateGet`/`__privateSet` and decorators to
`__decorateClass`. Those are real functions, so instrumenting them would bury
your own calls under scaffolding. The runtime drops frames for a known set of
compiler helpers and re-parents their children to the nearest real caller, so
you see your code:

```
make -> constructor              (not: make -> constructor -> __privateAdd -> __accessCheck)
```

## Known limits

- **The entry must be a module.** A bare script with no imports is instrumented
  fine, but everything it calls has to live in that one file — nothing else is
  loaded for it.
- **Frames carry a basename, not a path.** Two files with the same name in
  different directories are ambiguous in one trace. A full path would leak your
  directory layout into a file that is meant to be committed.
- **Only relative imports are followed.** `node_modules` is out of scope.
- **Node builtins are not frames.** `fs.readFileSync` is a leaf; cyclops traces
  your code, not the runtime's.
- **A directory or glob chooses one entry** (ranked by name — `index`, `main`,
  `app`, `cli` first, tests last) rather than running every file. The choice is
  printed so it is never silent.
- **Brace globs** (`*.{js,ts}`) are not expanded. Pass the extension, or list
  the files.

## Reading a trace

`out/tree.json` is plain JSON and is meant to be read directly:

```json
{
  "version": 1791392236389,
  "generatedAt": "2026-10-07T16:57:16.389Z",
  "roots": [
    { "id": 1, "name": "run", "file": "app.js", "line": 2,
      "args": [5], "return": 11, "error": null,
      "startedAt": 1, "endedAt": 3, "duration": 2,
      "children": [ ... ] }
  ]
}
```

A frame with `endedAt: null` never returned — the viewer renders it as
"started ..., never returned". A frame with an `error` and no return threw.

Values are tagged rather than raw where JSON cannot represent them:
`{type:"nan"}`, `{type:"bigint",value:"10n"}`, `{type:"symbol",value:"Symbol(tag)"}`,
`{type:"circular"}`, `{type:"unserializable",ctor:"Object"}`. `flow-model.js`
turns those back into readable text for the viewer.