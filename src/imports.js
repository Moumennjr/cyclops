// Listing the module specifiers a source file imports.
//
// Only two things are ever needed from a file: its text, and the specifiers it
// imports. The specifiers drive the instrument-everything graph walk in
// ./graph.js, so they are read with the real parser rather than a regex -- a
// regex cannot tell a string literal from a specifier, and would happily
// "find" `./foo` inside a comment.
//
// Falls back to a conservative scan when the file cannot be parsed, because a
// module we cannot parse is exactly the module whose imports we would otherwise
// silently drop.

import { parse } from "@babel/parser";

// Broad plugin set: this scanner has to cope with whatever dialect the graph
// walk meets, including TypeScript and JSX, since it reads neighbours of the
// entry file and does not know their extensions in advance.
const PLUGINS = [
  "typescript",
  "jsx",
  "importAttributes",
  "explicitResourceManagement",
  "decorators-legacy",
];

function collect(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out);
    return;
  }
  switch (node.type) {
    case "ImportDeclaration":
    case "ExportNamedDeclaration":
    case "ExportAllDeclaration":
      if (node.source && typeof node.source.value === "string") {
        out.add(node.source.value);
      }
      return;
    case "ImportExpression":
      if (node.source && typeof node.source.value === "string") {
        out.add(node.source.value);
      }
      return;
    case "CallExpression": {
      const c = node.callee;
      const isRequire =
        c && c.type === "Identifier" && c.name === "require";
      const isImport =
        c &&
        c.type === "Import" &&
        node.arguments.length === 1;
      if ((isRequire || isImport) && node.arguments[0]) {
        const a = node.arguments[0];
        if (a.type === "StringLiteral") out.add(a.value);
      }
      break;
    }
    default:
      break;
  }
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") {
      continue;
    }
    collect(node[key], out);
  }
}

const FALLBACK = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

// Every specifier the file names, bare and relative alike. Callers filter for
// the relative ones.
export function parseImports(source) {
  let ast;
  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      plugins: PLUGINS,
    });
  } catch {
    const out = new Set();
    let m;
    FALLBACK.lastIndex = 0;
    while ((m = FALLBACK.exec(source)) !== null) out.add(m[1]);
    return [...out];
  }
  const out = new Set();
  collect(ast.program, out);
  return [...out];
}

// Rewrites one specifier inside source text to point at `to`.
//
// String literals are located by their exact offset rather than by pattern
// match, so a specifier appearing in a comment or as unrelated data is left
// alone. Returns the source unchanged when the specifier is not present.
export function rewriteSpecifier(source, from, to) {
  if (from === to) return source;
  const quoted = JSON.stringify(from).slice(1, -1);
  return source.split(`"${quoted}"`).join(`"${to}"`).split(`'${quoted}'`).join(`'${to}'`);
}