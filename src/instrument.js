import * as t from "@babel/types";

const processed = new WeakSet();

function keyName(key) {
  if (t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key)) return key.value;
  if (t.isPrivateName(key)) return key.id.name;
  return "anonymous";
}

function functionName(path) {
  const node = path.node;
  if (node.id && t.isIdentifier(node.id)) return node.id.name;

  if (path.isObjectMethod() || path.isClassMethod()) return keyName(node.key);

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

        if (path.node.async || path.node.generator) {
          warnings.push({
            reason: path.node.async ? "async function" : "generator function",
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
        const name = functionName(path);
        const line = path.node.loc ? path.node.loc.start.line : null;

        if (isArrowExpr) {
          path.node.body = t.blockStatement([
            t.returnStatement(path.node.body),
          ]);
        }

        path.traverse({
          Function(p) {
            p.skip();
          },
          ReturnStatement(p) {
            p.node.argument = t.callExpression(t.identifier("__ret"), [
              t.identifier(cycId),
              p.node.argument ? p.node.argument : t.identifier("undefined"),
            ]);
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

        path.node.body = t.blockStatement([enterDecl, tryNode]);
      },
    },
  };
}
