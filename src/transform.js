import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import { instrument } from "./instrument.js";

export function transform(
  source,
  { filename = "unknown", sourceType = "unambiguous" } = {},
) {
  const warnings = [];
  const ast = parse(source, { sourceType, errorRecovery: false });
  traverse(ast, instrument({ warnings, filename }).visitor);
  const { code } = generate(ast, { comments: true });
  return { code, warnings };
}