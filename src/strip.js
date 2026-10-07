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
import { parse } from "@babel/parser";
import { needsTypeStripping, isTypeScript, extOf } from "./plugins.js";

// esbuild loader per extension. `ts` also accepts .js/.mjs/.cjs input, which
// keeps the mapping total even for an unexpected extension.
function loaderFor(filename) {
  const ext = extOf(filename);
  if (ext === ".tsx") return "tsx";
  if (ext === ".jsx") return "jsx";
  return "ts";
}

// True when the file is a CommonJS module, by extension or by its own syntax.
//
// Both matter: a `.js` file in a `"type": "module"` package that uses `require`
// is CommonJS, and a `.js` file in a CommonJS package that uses `import` is not.
// Deciding from the syntax means an unusual layout still works.
//
// The syntax is read with the parser, not a regex. A regex cannot tell
// `module.exports = {}` from the same words inside a string literal or a
// comment, and a false positive here renames the file to `.cjs` and breaks an
// otherwise-working ESM program.
function dialectFromSyntax(source) {
  let ast;
  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      plugins: ["typescript", "jsx"],
    });
  } catch {
    return null; // unparseable: fall back to the extension alone
  }

  let cjs = false;
  let esm = false;

  const walk = (node) => {
    if (!node || typeof node !== "object" || cjs && esm) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
      case "ExportDefaultDeclaration":
        esm = true;
        return;
      case "CallExpression":
        if (node.callee &&
            node.callee.type === "Identifier" &&
            node.callee.name === "require") {
          cjs = true;
        }
        break;
      case "MemberExpression": {
        const { object, property, computed } = node;
        if (object.type === "Identifier" && object.name === "module" &&
            !computed && property.type === "Identifier" &&
            (property.name === "exports" || property.name === "require")) {
          cjs = true;
        }
        if (object.type === "Identifier" && object.name === "exports" &&
            !computed) {
          cjs = true;
        }
        break;
      }
      default:
        break;
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "leadingComments" ||
          key === "trailingComments" || key === "innerComments") {
        continue;
      }
      walk(node[key]);
    }
  };
  walk(ast.program);

  // Mixed files are treated as CommonJS: an ESM file cannot contain a
  // top-level require() and still run, whereas a CJS file tolerates the
  // interop helpers that look like ESM.
  if (cjs) return true;
  if (esm) return false;
  return null;
}

export function isCommonJs(source, filename) {
  const ext = extOf(filename);
  if (ext === ".cjs" || ext === ".cts") return true;
  if (ext === ".mjs" || ext === ".mts") return false;

  const bySyntax = dialectFromSyntax(source);
  if (bySyntax !== null) return bySyntax;

  // Could not parse: assume the common case rather than renaming blindly.
  return false;
}

// The extension the instrumented copy is written with.
//
// The entry is written as `.mjs` because the runtime prelude is ESM. A
// CommonJS file that keeps `require()` cannot be renamed to `.mjs`: Node would
// treat it as an ES module and `require` would be undefined at run time. Such a
// file is written as `.cjs` instead, with a `require` shim so the prepended ESM
// prelude can still be concatenated in front of it.
export function shadowExtension(source, filename) {
  return isCommonJs(source, filename) ? "cjs" : "mjs";
}

// No shim is needed for CommonJS, which is worth stating because it was not
// obvious. The generated tracer contains no `import` or `export` -- it defines
// plain functions and ends by assigning them to globalThis -- so the very same
// text is valid in an ES module *and* in a CommonJS script. A `.cjs` shadow can
// therefore take the identical prelude that a `.mjs` shadow does.

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