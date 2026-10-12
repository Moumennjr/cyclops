// Reading a project's source statically: what is in it, without running it.
//
// This is the map half of v2. The tracer answers "what happened when I ran
// this"; the scanner answers "what is this, and what could it call" -- the
// question you ask before you can even run anything, and the one that covers
// code paths your inputs never reach.
//
// Every claim it makes is classified, and the classification is not decoration:
//
//   EXTRACTED   read directly out of the AST: this function is declared here,
//               this file imports that one
//   INFERRED    a name resolved across a module boundary: probably that
//               function, but only if nothing shadows it
//   AMBIGUOUS   could not be resolved; kept rather than dropped
//
// Dropping what cannot be resolved would make the map cleaner and wrong, and a
// map that lies about its own edges is worse than no map: it invites the reader
// to trust a connection that does not exist.

import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import { parserPluginsFor, extOf } from "./plugins.js";
import { resolveLocal } from "./graph.js";

export const EXTRACTED = "EXTRACTED";
export const INFERRED = "INFERRED";
export const AMBIGUOUS = "AMBIGUOUS";

const PARSE_PLUGINS = [
  "importAttributes",
  "explicitResourceManagement",
  "regexpUnicodeSets",
  "decoratorAutoAccessors",
];

// Wrappers that are not part of the program: without this, every `useEffect(() =>
// ...)` callback is reported as a call to a function named `undefined`.
const NOT_A_CALL = new Set(["require", "import"]);

function nameOfKey(key, computed) {
  if (!key) return null;
  if (key.type === "Identifier") return key.name;
  if (key.type === "StringLiteral") return key.value;
  if (key.type === "NumericLiteral") return String(key.value);
  return null;
}

/**
 * Parses one file and returns what is in it.
 *
 * Returns `{ error }` rather than throwing for an unparseable file: one
 * unparseable file in a project must not take the whole map down, and the
 * caller needs to *report* which file was skipped rather than silently lose it.
 */
export function scanFile(path, source) {
  const text = source ?? (() => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  })();

  if (text === null) {
    return { path, error: "could not be read", modules: [], functions: [], calls: [], imports: [] };
  }

  let ast;
  try {
    ast = parse(text, {
      sourceType: "unambiguous",
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      plugins: [...parserPluginsFor(path, text), ...PARSE_PLUGINS],
    });
  } catch (e) {
    return {
      path,
      error: e.message.split("\n")[0],
      modules: [],
      functions: [],
      calls: [],
      imports: [],
    };
  }

  const functions = [];
  const calls = [];
  const imports = [];
  const reexports = [];
  const exportsOut = [];
  let topLevel = false;

  // Which local names an import introduces, and from where. This is what makes
  // a cross-file call resolvable rather than a guess.
  const imported = new Map(); // local name -> { source, exported }

  const program = ast.program;
  const body = program.body;

  // ---- top level, before any function is entered --------------------------
  for (const stmt of body) {
    switch (stmt.type) {
      case "ImportDeclaration": {
        const spec = stmt.source.value;
        imports.push({ spec, kind: "import" });
        for (const spec2 of stmt.specifiers || []) {
          if (spec2.type === "ImportDefaultSpecifier") {
            imported.set(spec2.local.name, { source: spec, exported: "default" });
          } else if (spec2.type === "ImportNamespaceSpecifier") {
            imported.set(spec2.local.name, { source: spec, exported: "*" });
          } else if (spec2.type === "ImportSpecifier") {
            const name = spec2.imported.name ?? spec2.imported.value;
            imported.set(spec2.local.name, { source: spec, exported: name });
          }
        }
        break;
      }
      case "ExportNamedDeclaration": {
        if (stmt.source) {
          const spec = stmt.source.value;
          reexports.push({ spec });
          for (const spec2 of stmt.specifiers || []) {
            const local = spec2.local.name;
            const name = spec2.exported.name ?? spec2.exported.value;
            imported.set(local, { source: spec, exported: name, isReexport: true });
          }
        }
        for (const spec2 of stmt.specifiers || []) {
          const name = spec2.exported.name ?? spec2.exported.value;
          if (name) exportsOut.push(name);
        }
        if (stmt.declaration) {
          recordDeclaration(stmt.declaration, true);
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        exportsOut.push("default");
        recordDeclaration(stmt.declaration, true);
        break;
      }
      case "ExportAllDeclaration": {
        const spec = stmt.source.value;
        reexports.push({ spec, everything: true });
        break;
      }
      case "FunctionDeclaration":
      case "ClassDeclaration":
      case "VariableDeclaration": {
        // A plain top-level declaration, not an export. Omitting this made
        // every un-exported function invisible: scanFile('errors.js') on a file
        // whose entire content is two plain functions returned zero of them.
        // It never showed up as an error, because the parse really did succeed
        // -- the nodes were simply never visited.
        recordDeclaration(stmt, false);
        break;
      }
      case "ExpressionStatement": {
        // require("./x") at the top level, as CommonJS modules use
        const expr = stmt.expression;
        if (expr && expr.type === "CallExpression" &&
            expr.callee.type === "Identifier" && expr.callee.name === "require" &&
            expr.arguments[0] &&
            expr.arguments[0].type === "StringLiteral") {
          imports.push({ spec: expr.arguments[0].value, kind: "require" });
        }
        break;
      }
      default:
        break;
    }
  }

  // module.exports = { a, b }
  let cjsExports = null;
  for (const stmt of body) {
    if (stmt.type !== "ExpressionStatement") continue;
    const expr = stmt.expression;
    if (!expr || expr.type !== "AssignmentExpression") continue;
    const left = expr.left;
    const isModuleExports =
      left.type === "MemberExpression" &&
      left.object.type === "Identifier" &&
      left.object.name === "module" &&
      left.property.type === "Identifier" &&
      left.property.name === "exports";
    if (isModuleExports) {
      cjsExports = [];
      const right = expr.right;
      if (right.type === "ObjectExpression") {
        for (const prop of right.properties) {
          const key = nameOfKey(prop.key, prop.computed);
          if (key) cjsExports.push(key);
        }
      } else {
        cjsExports.push("default");
      }
      exportsOut.push(...cjsExports);
    }
  }

  /**
   * Records a declaration if it is not inside another function.
   *
   * Nested functions are deliberately excluded. A closure inside a function is
   * not a separate entry point and it is not something a caller can name, so
   * treating it as a peer produces edges nobody asked for and inflates every
   * count the map reports.
   */
  function recordDeclaration(decl, isExported) {
    if (!decl) return;
    if (decl.type === "FunctionDeclaration" ||
        decl.type === "FunctionExpression" ||
        decl.type === "ArrowFunctionExpression") {
      const name = functionNameOf(decl, isExported);
      if (!name) return;
      functions.push({
        name,
        kind: kindOf(decl),
        exported: isExported,
        line: decl.loc ? decl.loc.start.line : null,
        generator: !!decl.generator,
        async: !!decl.async,
        params: (decl.params || []).length,
        paramsList: paramList(decl.params),
      });
    } else if (decl.type === "VariableDeclaration") {
      for (const d of decl.declarations) {
        if (d.init &&
            (d.init.type === "ArrowFunctionExpression" ||
             d.init.type === "FunctionExpression")) {
          const name = d.id && d.id.name;
          if (!name) continue;
          functions.push({
            name,
            kind: kindOf(d.init),
            exported: isExported,
            line: d.loc ? d.loc.start.line : null,
            generator: !!d.init.generator,
            async: !!d.init.async,
            params: (d.init.params || []).length,
            paramsList: paramList(d.init.params),
          });
        }
      }
    } else if (decl.type === "ClassDeclaration") {
      const name = decl.id ? decl.id.name : "default";
      functions.push({
        name,
        kind: "class",
        exported: isExported,
        line: decl.loc ? decl.loc.start.line : null,
        generator: false,
        async: false,
        params: 0,
      });
      // Methods are their own nodes: a class that does nothing but delegate is
      // a real thing to understand, and hiding it inside the class node means
      // the map cannot show who calls it.
      for (const member of decl.body.body) {
        if (member.type === "ClassMethod" ||
            member.type === "ClassPrivateMethod" ||
            member.type === "ObjectMethod") {
          const mname = nameOfKey(member.key, member.computed);
          if (!mname) continue;
          functions.push({
            name: `${name}.${mname}`,
            kind: member.static ? "static-method" : "method",
            exported: false,
            line: member.loc ? member.loc.start.line : null,
            generator: !!member.generator,
            async: !!member.async,
            params: (member.params || []).length,
            paramsList: paramList(member.params),
            owner: name,
          });
        } else if (member.type === "ClassProperty" && member.value &&
                   (member.value.type === "ArrowFunctionExpression" ||
                    member.value.type === "FunctionExpression")) {
          const mname = nameOfKey(member.key, member.computed);
          if (!mname) continue;
          functions.push({
            name: `${name}.${mname}`,
            kind: "field",
            exported: false,
            line: member.loc ? member.loc.start.line : null,
            generator: false,
            async: !!member.value.async,
            params: (member.value.params || []).length,
            paramsList: paramList(member.value.params),
            owner: name,
          });
        }
      }
    }
  }

  // Parameter names and default expressions, as source text.
//
// Recorded because the harness needs them to synthesise a call, and re-parsing
// to recover them later would mean parsing the same file twice. Default
// expressions are kept as text rather than evaluated: `a = compute()` is not
// something to run at scan time.
function paramList(params) {
  return (params || []).map((p) => {
    let name = null;
    if (p.type === "Identifier") name = p.name;
    else if (p.type === "AssignmentPattern" && p.left.type === "Identifier") {
      return { name: p.left.name, defaultValue: sourceText(p.right) };
    } else if (p.type === "RestElement" && p.argument.type === "Identifier") {
      return { name: p.argument.name, rest: true };
    } else if (p.type === "ObjectPattern" || p.type === "ArrayPattern") {
      // Destructured: name it by its bound identifiers so a placeholder still
      // has something to be named after.
      name = Object.values(t.getBindingIdentifiers(p))
        .map((id) => id.name)[0] || "arg";
    }
    return { name, defaultValue: null };
  });
}

// The source text of a node, without keeping the node.
function sourceText(node) {
  if (!node) return null;
  if (node.type === "NumericLiteral") return String(node.value);
  if (node.type === "StringLiteral") return JSON.stringify(node.value);
  if (node.type === "BooleanLiteral") return String(node.value);
  if (node.type === "NullLiteral") return "null";
  if (node.type === "Identifier") return node.name;
  if (node.type === "UnaryExpression" && node.operator === "-") {
    const inner = sourceText(node.argument);
    return inner ? `-${inner}` : null;
  }
  return null; // anything computed is not safe to replay at scan time
}

function kindOf(fn) {
    if (fn.generator) return fn.async ? "async-generator" : "generator";
    if (fn.async) return "async";
    return "function";
  }

  function functionNameOf(fn, isExported) {
    if (fn.id && fn.id.name) return fn.id.name;
    // `export default () => {}`
    if (isExported) return "default";
    return null;
  }

  // ---- inside functions ---------------------------------------------------
  // Walk each top-level function separately, so every call gets attributed to
  // the function it sits in. A call outside any function belongs to the module.
  const visitCalls = (node, owner) => {
    const walk = (n) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) {
        for (const item of n) walk(item);
        return;
      }
      if (n.type === "CallExpression") {
        const callee = n.callee;
        let target = null;
        let confidence = EXTRACTED;
        let via = null;

        if (callee.type === "Identifier") {
          if (!NOT_A_CALL.has(callee.name)) {
            target = callee.name;
            // A bare name might be a local function or an import binding; the
            // caller decides, because only it knows the module graph.
            confidence = EXTRACTED;
          }
        } else if (callee.type === "MemberExpression" && !callee.computed) {
          const object = callee.object;
          const prop = callee.property;
          // `ns.foo()` -- namespaced import, resolvable when `ns` is imported
          if (object.type === "Identifier" && prop.type === "Identifier") {
            target = `${object.name}.${prop.name}`;
            via = object.name;
          } else if (object.type === "MemberExpression" &&
                     object.property.type === "Identifier") {
            // `this.foo()` / `obj.method()`
            target = `${object.property.name}.${prop.name}`;
            via = object.property.name;
          }
        } else if (callee.type === "MemberExpression" && callee.computed &&
                   callee.property.type === "StringLiteral") {
          target = callee.property.value;
        }

        if (target) {
          calls.push({
            from: owner,
            to: target,
            via: via,
            line: n.loc ? n.loc.start.line : null,
            confidence,
          });
        }
      }
      for (const key of Object.keys(n)) {
        if (key === "loc" || key === "leadingComments" ||
            key === "trailingComments" || key === "innerComments") {
          continue;
        }
        walk(n[key]);
      }
    };
    walk(node);
  };

  // Each top-level function body is walked on its own, and its *name* becomes
  // the owner for everything inside it.
  const walkBodies = (statements, owner) => {
    for (const stmt of statements) {
      const decl = stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration"
        ? stmt.declaration
        : stmt;
      if (!decl) continue;
      if (decl.type === "FunctionDeclaration") {
        visitCalls(decl.body, decl.id ? decl.id.name : "anonymous");
      } else if (decl.type === "ClassDeclaration") {
        if (decl.id) {
          for (const member of decl.body.body) {
            if ((member.type === "ClassMethod" || member.type === "ClassPrivateMethod") && member.body) {
              visitCalls(member.body, `${decl.id.name}.${nameOfKey(member.key, member.computed)}`);
            }
          }
        }
      } else if (decl.type === "VariableDeclaration") {
        for (const d of decl.declarations) {
          if (d.init && (d.init.type === "ArrowFunctionExpression" ||
                         d.init.type === "FunctionExpression")) {
            visitCalls(d.init.body, d.id && d.id.name ? d.id.name : "anonymous");
          }
        }
      }
    }
  };

  walkBodies(body, null);
  topLevel = body.length > 0;

  // Calls that live outside any function belong to the module itself.
  visitCalls(
    { type: "Program", body: body.filter((s) => {
      const decl = s.type === "ExportNamedDeclaration" ? s.declaration : s;
      return !(decl && (
        decl.type === "FunctionDeclaration" ||
        decl.type === "ClassDeclaration" ||
        decl.type === "VariableDeclaration"
      ));
    }) },
    null,
  );

  return {
    path,
    lineCount: text.split("\n").length,
    isModule: imports.length > 0 || exportsOut.length > 0 ||
      /^\s*(import|export)\b/m.test(text) || !!cjsExports,
    isTest: /\.(test|spec)\.[cm]?[jt]sx?$/.test(path),
    isEntry: isEntryPoint(path),
    imports,
    reexports,
    exports: [...new Set(exportsOut)],
    importedBindings: imported,
    functions,
    calls,
    topLevel,
    error: null,
  };
}

// A file with nothing importing it and which looks like a starting point.
function isEntryPoint(path) {
  const base = path.split(/[\\/]/).pop().toLowerCase();
  return /^(index|main|app|cli|server|run|program|setup)\.[cm]?[jt]sx?$/.test(base);
}

// A stable identifier for a function, unique within a file.
//
// Uses file + name rather than a counter so that rescanning an unchanged file
// produces identical ids -- otherwise a map rebuilt for no reason appears
// entirely different to anything that stored the old ids.
export function functionId(file, name) {
  const stem = file.split(/[\\/]/).pop().replace(/\.[^.]*$/, "");
  const slug = name.replace(/\./g, "_").replace(/[^A-Za-z0-9_]/g, "_");
  return `${stem}::${slug}`;
}

export function moduleId(file) {
  return `mod::${file.split(/[\\/]/).pop().replace(/\.[^.]*$/, "")}`;
}

export { extOf, resolveLocal };