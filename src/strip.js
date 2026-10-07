// Type stripping: turn a parsed TypeScript AST into plain JavaScript AST.
//
// Parsing TS is only half the job. Babel's `typescript` plugin *accepts*
// `const x: number = 1` but leaves the annotation in the tree, so the emitted
// source still says `const x: number = 1`. Node cannot run that, and cyclops
// concatenates the instrumented output into a `.mjs` file and executes it.
//
// Rather than hand-roll a visitor for every type position (and get
// `satisfies`, conditional types, mapped types and declaration merging wrong),
// this defers to esbuild, which is already a dependency of the build toolchain
// and is a complete TypeScript-to-JavaScript transform.
//
// The order matters and is the whole point of this module:
//
//   TypeScript source
//     -> esbuild strips types AND lowers JSX to createElement
//     -> Babel parses the plain-JS result and wraps every function
//
// Both passes see source text, never a shared AST, so neither has to understand
// the other's output.

import { transformSync } from "esbuild";
import { needsTypeStripping, isTypeScript, extOf } from "./plugins.js";

// esbuild loader per extension. `ts` also accepts .js/.mjs/.cjs input, which
// keeps the mapping total even for an unexpected extension.
function loaderFor(filename) {
  const ext = extOf(filename);
  if (ext === ".tsx") return "tsx";
  if (ext === ".jsx") return "jsx";
  return "ts";
}

// Whether a file carries syntax Babel parses but cannot print as runnable
// JavaScript.
//
// Decorators are the case that matters. Babel's parser accepts them behind a
// plugin, but `generate()` emits the decorator *syntax* back verbatim and Node
// does not accept it -- so a decorated class parses cleanly and then dies with
// "Invalid or unexpected token" at the `@`. esbuild lowers decorators to
// ordinary function calls, which is both runnable and closer to what the code
// means.
//
// The probe matches a decorator in statement position only, so an `@` in a
// comment or an email address in a string cannot drag a plain JavaScript file
// through the extra pass.
const DECORATOR = /^[ \t]*@[A-Za-z_$]/m;

export function needsLowering(source, filename) {
  if (needsTypeStripping(filename)) return true;
  return DECORATOR.test(source);
}

// Strips type syntax from `source`, returning plain JavaScript.
//
// Returns the input untouched when nothing needs lowering, so the common
// JavaScript path costs one extension check and one regex.
//
// `experimentalDecorators` is enabled because a decorator on a class or method
// is ordinary JavaScript users expect to work; without it esbuild rejects the
// syntax outright rather than silently dropping the decorator.
export function stripTypes(source, filename) {
  if (!needsLowering(source, filename)) return source;

  const result = transformSync(source, {
    loader: loaderFor(filename),
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        useDefineForClassFields: false,
        verbatimModuleSyntax: false,
      },
    },
  });
  return result.code;
}

// True when the file needs the esbuild pass. Exposed for the CLI so it can say
// what it is about to do before doing it.
export { needsTypeStripping, isTypeScript };