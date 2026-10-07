// Which Babel parser plugins a given source file needs.
//
// The parser is strict on purpose: `parse()` with no `plugins` array rejects
// TypeScript annotations, JSX, decorators and flow outright. Deciding the
// plugin set from the file extension means `cyclops app.ts` and
// `cyclops App.tsx` parse instead of dying with "Unexpected reserved word",
// while a plain `.js` file keeps exactly the syntax it always had.
//
// This module is about *parsing* only. Babel's TypeScript plugin produces an AST
// that still contains type annotations; running that output needs the type
// stripping in ./strip.js.

const TS_EXT = new Set([".ts", ".mts", ".cts"]);

// extensions whose syntax needs both the type system and JSX
const TSX_EXT = new Set([".tsx"]);

// extensions that carry JSX but no type syntax
const JSX_EXT = new Set([".jsx"]);

function extOf(filename) {
  const name = String(filename || "");
  const dot = name.lastIndexOf(".");
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  if (dot === -1 || dot < slash) return "";
  return name.slice(dot).toLowerCase();
}

// plugins every supported dialect gets: ESM+script autodetect, and the
// proposal-level syntax that has shipped in Node and browsers
const COMMON = [
  "importAttributes",
  "explicitResourceManagement",
  "regexpUnicodeSets",
];

export function parserPluginsFor(filename) {
  const ext = extOf(filename);
  const plugins = [...COMMON];

  if (TS_EXT.has(ext) || TSX_EXT.has(ext)) {
    // `typescript` disables flow; they are mutually exclusive in one parse
    plugins.push("typescript");
  }
  if (TSX_EXT.has(ext) || JSX_EXT.has(ext)) {
    plugins.push("jsx");
  }
  return plugins;
}

// True when the file needs a type-stripping pass before its output can run.
export function needsTypeStripping(filename) {
  const ext = extOf(filename);
  return TS_EXT.has(ext) || TSX_EXT.has(ext);
}

// True when the file is TypeScript or TSX, for reporting and for choosing an
// esbuild loader.
export function isTypeScript(filename) {
  const ext = extOf(filename);
  return TS_EXT.has(ext) || TSX_EXT.has(ext);
}

export { extOf };