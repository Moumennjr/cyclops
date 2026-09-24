#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { transform } from "./transform.js";
import { runtimeSource } from "./runtime.js";
import { splitTree, writeTree } from "./treeio.js";

function parseArgs(argv) {
  let file = null;
  let port = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") port = Number(argv[++i]);
    else if (a.startsWith("--port=")) port = Number(a.slice("--port=".length));
    else if (a === "--help" || a === "-h") return { help: true };
    else if (!a.startsWith("-")) file = a;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return { file, port };
}

function printUsage() {
  console.log(`usage: cyclops <file.js> [--port N]
  instruments <file.js>, runs it, and writes the call tree to out/tree.json`);
}

function main() {
  const { file, port, help } = parseArgs(process.argv.slice(2));
  if (help || !file) {
    printUsage();
    process.exit(help ? 0 : 1);
  }

  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch (e) {
    console.error(`cyclops: cannot read ${file}: ${e.message}`);
    process.exit(1);
  }

  let result;
  try {
    result = transform(source, { filename: file });
  } catch (e) {
    console.error(`cyclops: transform failed: ${e.message}`);
    process.exit(1);
  }

  for (const w of result.warnings) {
    console.warn(
      `[cyclops] skipped ${w.reason} "${w.name}" at ${w.file}:${w.line}`,
    );
  }

  const tmp = join(tmpdir(), `cyclops-${basename(file)}-${process.pid}.mjs`);
  writeFileSync(tmp, runtimeSource() + "\n" + result.code);

  let res;
  try {
    res = spawnSync(process.execPath, [tmp], { encoding: "utf8" });
  } catch (e) {
    console.error(`cyclops: failed to run instrumented file: ${e.message}`);
    process.exit(1);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }

  process.stdout.write(res.stdout ?? "");

  const stderrText = res.stderr ?? "";
  const { tree, userText } = splitTree(stderrText);
  process.stderr.write(userText);

  if (!tree) {
    console.error("[cyclops] no trace captured (no instrumented call ran)");
    process.exit(res.status ?? 1);
  }

  const outFile = join(process.cwd(), "out", "tree.json");
  writeTree(outFile, tree);
  console.error(`[cyclops] trace written to ${outFile}`);

  process.exit(res.status ?? 0);
}

main();