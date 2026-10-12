// Tracing one named function, rather than a whole program.
//
// The map says "this function exists and these are its callers". The trace says
// "here is what actually happened when it ran". Neither is much use without the
// other, and until now joining them meant: read the map, find the entry point,
// edit it or write a harness, run it, read the trace. This removes those three
// steps.
//
// The hard part is that a function is not a program. `renderTree(roots)` cannot
// be called with no arguments; `handleClick` needs an event and a live DOM. So
// the harness has to invent inputs, and there is no honest way to do that in
// general -- which is why `harnessFor()` reports what it could not supply rather
// than fabricating a call and pretending.
//
// Three ways to get a call, in descending order of how much the result can be
// trusted:
//
//   1. the caller passes real arguments          -- best, and what you want
//   2. arguments from the function's own defaults, or type-free placeholders
//   3. a value guessed from the parameter's name -- labelled as a guess
//
// A trace from (3) is worth having and must be labelled. A tree that claims to
// show `renderTree` but actually threw inside it on frame 0 is worse than none.

import { scanFile } from "./scan.js";
import { readFileSync } from "node:fs";

// Placeholders that survive most code, chosen so a call fails *inside* the
// function rather than before it. An empty object reaches a property read; an
// empty array reaches a length. What does not work is anything needing a real
// value, and those are reported.
const PLACEHOLDERS = {
  array: [],
  object: {},
  string: "sample",
  number: 1,
  boolean: true,
  fn: function () {},
};

function placeholderFor(name) {
  const n = String(name || "").toLowerCase();
  if (/^(items|list|arr|xs|args|values|entries|rows|cols|keys)$/.test(n)) return [...PLACEHOLDERS.array];
  if (/^(map|dict|obj|options|opts|config|state|store|ctx|context|props|params)$/.test(n)) {
    return { ...PLACEHOLDERS.object };
  }
  if (/^(id|index|idx|count|n|num|len|size|limit|offset|port|retries)$/.test(n)) return 1;
  if (/^(name|title|label|text|message|msg|str|url|path|key|query)$/.test(n)) return PLACEHOLDERS.string;
  if (/^(enabled|verbose|force|debug|flag|ok|done|active)$/.test(n)) return true;
  if (/^(cb|callback|fn|handler|next|done)$/.test(n)) return () => {};
  return PLACEHOLDERS.object;
}

/** A JS literal for a value, safe to paste into a generated program. */
function literal(value) {
  if (typeof value === "function") return "() => {}";
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

/**
 * Builds a runnable program that calls one exported function.
 *
 * Returns `{ source, confidence, notes }` where confidence is:
 *   "caller"  real arguments came from the caller
 *   "default" arguments were synthesised from the signature
 *   "guess"   arguments were guessed from parameter names
 *
 * `notes` says what was guessed, because that is what makes a guess
 * interpretable afterwards.
 */
export function harnessFor(file, functionName, options = {}) {
  const { args = null, asDefault = null } = options;
  const scan = scanFile(file);
  if (scan.error) {
    return { error: `could not read ${file}: ${scan.error}` };
  }

  const target =
    scan.functions.find((f) => f.name === functionName) ||
    scan.functions.find((f) => f.name.endsWith(`.${functionName}`)) ||
    scan.functions.find((f) => f.name.split(".").pop() === functionName);

  if (!target) {
    return {
      error:
        `"${functionName}" is not in ${file}. ` +
        (scan.functions.length
          ? `It has: ${scan.functions.slice(0, 6).map((f) => f.name).join(", ")}`
          : "It has no top-level functions."),
    };
  }

  const isMethod = target.kind === "method" || target.kind === "static-method";
  const localName = isMethod ? target.name.split(".").pop() : target.name;

  const prelude = importPrelude(file, scan, target, localName);

  // Real arguments win over everything.
  if (args && Array.isArray(args)) {
    return {
      confidence: "caller",
      functionName: localName,
      kind: target.kind,
      notes: [],
      source:
        sourceHeader(file) +
        prelude +
        `const __result = await (${localName})(${args.map(literal).join(", ")});\n` +
        `console.log("returned:", __result);\n`,
    };
  }

  // Recover a signature so the placeholders are shaped like real parameters.
  const params = parameterNames(file, localName, target);
  const notes = [];
  // Already-source values and synthesised values need different treatment:
  // a default is already text, a placeholder is a value.
  const sourceArgs = params.map((p) => {
    if (p.defaultValue) {
      notes.push(`used the declared default for ${p.name}`);
      // The default is stored as *source text*, so it goes into the generated
      // program verbatim. Passing it through literal() would turn `2` into
      // `"2"` -- a string where the real default was a number.
      return p.defaultValue;
    }
    notes.push(`guessed a value for ${p.name} from its name`);
    return { guessed: placeholderFor(p.name) };
  });
  const argText = sourceArgs.map((a) =>
    typeof a === "string" ? a : literal(a.guessed));

  return {
    confidence: sourceArgs.some((a) => typeof a !== "string") ? "guess" : "default",
    functionName: localName,
    kind: target.kind,
    notes,
    signature: params.map((p) => p.name).join(", "),
    source:
      sourceHeader(file) +
      prelude +
      (isMethod
        ? `const __self = ${target.owner ? instantiate(target.owner) : "{}"};\n` +
          `const __result = __self.${localName}(${argText.join(", ")});\n`
        : `const __result = (${localName})(${argText.join(", ")});\n`) +
      `console.log("returned:", __result);\n`,
  };
}

// The program cannot call a function it has not imported, so the import is part
// of the answer rather than an afterthought. The specifier is relative to
// wherever the harness ends up, so it is computed from the target's own
// directory and written next to the file -- which is also where a relative
// import will resolve.
function importPrelude(file, scan, target, localName) {
  // A named function: import the module and pull it out.
  if (target.exported && target.kind !== "method") {
    const spec = "./" + file.split(/[\\/]/).pop();
    return `import { ${localName} } from ${JSON.stringify(spec)};\n`;
  }
  // Not exported, or a method: the only honest way to reach it is to load the
  // module and say so, rather than pretending a local binding exists.
  return (
    `import * as __mod from ${JSON.stringify("./" + file.split(/[\\/]/).pop())};\n` +
    `const ${localName} = __mod.${localName} ?? __mod.default?.${localName};\n` +
    `if (typeof ${localName} !== "function") {\n` +
    `  console.error("harness: ${localName} is not exported by ${file}; add an export or trace its caller");\n` +
    `  process.exit(2);\n` +
    `}\n`
  );
}

// A best-effort instance for a method call. Calling a method on a bare object
// that was never constructed is a guess, and is labelled as one by the caller's
// confidence, so this stays simple rather than pretending to run a constructor.
function instantiate(owner) {
  return `{ /* a real instance may be needed; this is a placeholder */ }`;
}

/**
 * Parameter names and defaults, straight from the scan.
 *
 * scan.js records these at parse time precisely so this does not have to
 * re-parse: the harness is called per-function and re-reading a file each time
 * would be quadratic on a project view.
 */
function parameterNames(file, localName, target) {
  const scan = scanFile(file);
  if (scan.error) return target.paramsList || [];
  const found = scan.functions.find((f) => f.name === target.name) ||
    scan.functions.find((f) => f.name.endsWith(`.${localName}`));
  return (found && found.paramsList) || target.paramsList || [];
}

function sourceHeader(file) {
  return `// generated by cyclops: trace this one function\n`;
}

/**
 * Finds callers of a function across a map, so the caller can offer real
 * arguments instead of guesses. This is what makes "trace this" usually land on
 * a high-confidence harness rather than a fabricated one.
 */
export function callersInMap(map, functionName) {
  const byId = new Map((map.nodes || []).map((n) => [n.id, n]));
  const label = (id) => byId.get(id)?.label ?? id;

  const node = (map.nodes || []).find(
    (n) => n.label === functionName &&
      (n.kind === "function" || n.kind === "class"),
  );
  if (!node) {
    return { node: null, callers: [], note: `no function named ${functionName}` };
  }

  const callers = (map.edges || [])
    .filter((e) => e.target === node.id && e.relation === "calls")
    .map((e) => ({
      id: e.source,
      name: label(e.source),
      file: byId.get(e.source)?.file || null,
      line: e.line,
      confidence: e.confidence,
    }));

  return {
    node,
    file: node.file,
    line: node.line,
    exported: node.exported,
    callers,
    note: callers.length
      ? null
      : "nothing in this project calls it, so there are no real arguments to reuse",
  };
}

export { placeholderFor, literal };