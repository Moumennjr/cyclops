import * as t from "@babel/types";

const processed = new WeakSet();
const awaited = new WeakSet();
const forAwait = new WeakSet();
const retWrapped = new WeakSet();
const yielded = new WeakSet();
const SCHEDULERS = new Set([
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
]);
const PROMISE_HOOKS = new Set(["then", "catch", "finally"]);

// Generators are traced by default. They used to be skipped outright, which
// meant an entire iterator-based abstraction was invisible; `false` restores
// that behaviour and the warnings with it.
const GENERATOR_TRACED = true;

function keyName(key) {
  if (t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key)) return key.value;
  if (t.isPrivateName(key)) return "#" + key.id.name;
  return "anonymous";
}

function functionName(path) {
  const node = path.node;
  if (node.id && t.isIdentifier(node.id)) return node.id.name;

  if (path.isObjectMethod() || path.isClassMethod() || path.isClassPrivateMethod())
    return keyName(node.key);

  const parent = path.parentPath;
  if (parent.isVariableDeclarator() && t.isIdentifier(parent.node.id))
    return parent.node.id.name;
  if (parent.isAssignmentExpression() && t.isIdentifier(parent.node.left))
    return parent.node.left.name;
  if (parent.isObjectProperty() && !parent.node.computed)
    return keyName(parent.node.key);
  if (parent.isExportDefaultDeclaration()) return "default";
  return "anonymous";
}

function argumentExpressions(params) {
  const seen = new Set();
  const exprs = [];
  for (const param of params) {
    for (const id of Object.values(t.getBindingIdentifiers(param))) {
      if (seen.has(id.name)) continue;
      seen.add(id.name);
      exprs.push(t.cloneNode(id));
    }
  }
  return exprs;
}

export function instrument({ warnings = [], filename = "unknown" } = {}) {
  return {
    name: "cyclops-instrument",
    visitor: {
      Function(path) {
        if (processed.has(path.node)) return;
        processed.add(path.node);

        if (path.node.generator && !GENERATOR_TRACED) {
          warnings.push({
            reason: path.node.async ? "async generator function" : "generator function",
            name: functionName(path),
            line: path.node.loc ? path.node.loc.start.line : null,
            file: filename,
          });
          return;
        }

        if (!path.node.body) return;
        const isArrowExpr =
          path.isArrowFunctionExpression() &&
          !t.isBlockStatement(path.node.body);
        if (!isArrowExpr && !t.isBlockStatement(path.node.body)) return;

        const cycId = path.scope.generateUid("cyc");
        const isGenerator = !!path.node.generator;
        const name = functionName(path);
        const line = path.node.loc ? path.node.loc.start.line : null;
        const isAsync = !!path.node.async;

        if (isArrowExpr) {
          path.node.body = t.blockStatement([
            t.returnStatement(path.node.body),
          ]);
        }

        const unsuspend = () =>
          t.expressionStatement(
            t.callExpression(t.identifier("__resume"), [t.identifier(cycId)]),
          );

        path.traverse({
          Function(p) {
            p.skip();
          },
          ReturnStatement(p) {
            if (retWrapped.has(p.node)) return;
            retWrapped.add(p.node);
            p.node.argument = t.callExpression(t.identifier("__ret"), [
              t.identifier(cycId),
              p.node.argument ? p.node.argument : t.identifier("undefined"),
            ]);
          },
          // `yield` needs the same treatment as `await`. A generator suspends
          // at the yield and the *consumer's* loop body runs next; if the frame
          // stayed active, calls made by that body would be filed as children
          // of the generator instead of the consumer. Suspending across the
          // yield is what keeps `for await (const v of gen()) body(v)` honest.
          YieldExpression(p) {
            if (!isGenerator || yielded.has(p.node)) return;
            yielded.add(p.node);
            const susp = t.callExpression(t.identifier("__sus"), [
              t.identifier(cycId),
              p.node.argument ? p.node.argument : t.identifier("undefined"),
            ]);
            const wrappedYield = t.yieldExpression(susp, p.node.delegate);
            yielded.add(wrappedYield);
            p.replaceWith(
              t.callExpression(t.identifier("__resume"), [
                t.identifier(cycId),
                wrappedYield,
              ]),
            );
          },
          AwaitExpression(p) {
            if (awaited.has(p.node)) return;
            awaited.add(p.node);
            const susp = t.callExpression(t.identifier("__sus"), [
              t.identifier(cycId),
              p.node.argument,
            ]);
            const wrappedAwait = t.awaitExpression(susp);
            awaited.add(wrappedAwait);
            p.replaceWith(
              t.callExpression(t.identifier("__resume"), [
                t.identifier(cycId),
                wrappedAwait,
              ]),
            );
          },
          ForOfStatement(p) {
            if (!p.node.await || forAwait.has(p.node)) return;
            forAwait.add(p.node);
            p.node.right = t.callExpression(t.identifier("__aiter"), [
              t.identifier(cycId),
              p.node.right,
            ]);
            const loopBody = p.node.body;
            if (t.isBlockStatement(loopBody)) loopBody.body.unshift(unsuspend());
            else p.node.body = t.blockStatement([unsuspend(), loopBody]);
            p.insertAfter(unsuspend());
          },
          CatchClause(p) {
            if (isAsync) p.node.body.body.unshift(unsuspend());
          },
          TryStatement(p) {
            if (isAsync && p.node.finalizer) p.node.finalizer.body.unshift(unsuspend());
          },
          CallExpression(p) {
            const callee = p.node.callee;
            const bare = t.isIdentifier(callee) && SCHEDULERS.has(callee.name);
            const nextTick =
              t.isMemberExpression(callee) &&
              !callee.computed &&
              t.isIdentifier(callee.object, { name: "process" }) &&
              t.isIdentifier(callee.property, { name: "nextTick" });
            const promiseHook =
              t.isMemberExpression(callee) &&
              !callee.computed &&
              t.isIdentifier(callee.property) &&
              PROMISE_HOOKS.has(callee.property.name);
            if (!bare && !nextTick && !promiseHook) return;
            const slots = bare || nextTick ? [0] : [0, 1];
            for (const i of slots) {
              const arg = p.node.arguments[i];
              if (!arg || t.isStringLiteral(arg)) continue;
              p.node.arguments[i] = t.callExpression(t.identifier("__cb"), [
                t.identifier(cycId),
                arg,
              ]);
            }
          },
        });

        const bodyStmts = path.node.body.body;
        const last = bodyStmts[bodyStmts.length - 1];
        const endsAbruptly =
          last &&
          (t.isReturnStatement(last) || t.isThrowStatement(last));
        if (!endsAbruptly) {
          bodyStmts.push(
            t.returnStatement(
              t.callExpression(t.identifier("__ret"), [
                t.identifier(cycId),
                t.identifier("undefined"),
              ]),
            ),
          );
        }

        const catchId = path.scope.generateUid("e");
        const tryNode = t.tryStatement(
          t.blockStatement(path.node.body.body),
          t.catchClause(
            t.identifier(catchId),
            t.blockStatement([
              t.expressionStatement(
                t.callExpression(t.identifier("__err"), [
                  t.identifier(cycId),
                  t.identifier(catchId),
                ]),
              ),
              t.throwStatement(t.identifier(catchId)),
            ]),
          ),
        );

        const enterDecl = t.variableDeclaration("const", [
          t.variableDeclarator(
            t.identifier(cycId),
            t.callExpression(t.identifier("__enter"), [
              t.stringLiteral(name),
              t.arrayExpression(argumentExpressions(path.node.params)),
              line !== null ? t.objectExpression([
                t.objectProperty(t.identifier("line"), t.numericLiteral(line)),
              ]) : t.identifier("null"),
            ]),
          ),
        ]);

        path.node.body = t.blockStatement(
          [enterDecl, tryNode],
          path.node.body.directives,
        );
      },
    },
  };
}
