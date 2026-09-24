import { CYC_MARKER } from "./runtime.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function splitTree(stderrText) {
  const parts = stderrText.split(CYC_MARKER);
  if (parts.length < 3) return { tree: null, userText: stderrText };

  const payload = parts[parts.length - 2];
  let tree = null;
  try {
    tree = JSON.parse(payload);
  } catch {
    tree = null;
  }
  return { tree, userText: parts[0] + parts[parts.length - 1] };
}

export function writeTree(file, tree) {
  const payload = {
    version: Date.now(),
    generatedAt: new Date().toISOString(),
    ...tree,
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(payload, null, 2));
}