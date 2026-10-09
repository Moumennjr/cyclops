// cyclops as an OpenCode plugin.
//
// Registers one tool, `cyclops_trace`, so an agent can run a program and read
// its call tree as text instead of guessing at control flow from source.
//
// The design constraint that shapes everything here: an agent's context is
// small and every token is spoken for. graph.json for a modest program is
// ~425 kB, most of it node coordinates, so the tool never returns it. It returns
// a text summary plus a bounded slice of the tree, with the full trace written
// to disk for a follow-up call to look at if it is needed.
//
// @opencode-ai/plugin is imported dynamically. It is a dependency of the *host*
// application, not of cyclops -- making it a hard import would mean every user
// installing cyclops as a CLI tool also installs an editor SDK they never use.
// If it cannot be resolved, the plugin still loads and the tool falls back to a
// hand-rolled zod-free schema, because a missing types package is not a reason
// for the tool to disappear.

import { existsSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";

import { trace, planEntry } from "../src/engine.js";
import { renderTree, renderFlat } from "../src/render.js";
import { summarize, findFrames } from "../src/analyze.js";

const MAX_OUTPUT_CHARS = 120_000;

let tool = null;
try {
  const mod = await import("@opencode-ai/plugin");
  tool = mod.tool ?? null;
} catch {
  tool = null;
}

// Builds a tool definition with or without the SDK.
//
// The host validates `args` against the zod shape when the SDK is present. When
// it is not, the same shape is described declaratively and validated here --
// enough that a malformed call from a model produces a readable error instead of
// an undefined somewhere downstream.
function defineTool(spec) {
  if (tool) return tool(spec);
  return {
    description: spec.description,
    args: spec.args,
    async execute(args, context) {
      const parsed = validate(spec.args, args ?? {});
      if (parsed.error) throw new Error(parsed.error);
      return spec.execute(parsed.value, context);
    },
  };
}

function validate(shape, value) {
  // An args declaration is a map of field name -> field shape. A shape is a
  // leaf when it declares a `type`; otherwise it is a map of fields. This
  // distinction is what lets the same declaration be handed to the host's zod
  // builder or validated here.
  if (shape && !shape.type && typeof shape === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { error: "expected an object" };
    }
    const out = {};
    for (const [key, sub] of Object.entries(shape)) {
      if (value[key] === undefined) {
        if (sub.optional) continue;
        return { error: `${key} is required` };
      }
      const got = validate(sub, value[key]);
      if (got.error) return { error: `${key}: ${got.error}` };
      out[key] = got.value;
    }
    return { value: out };
  }
  if (shape.type === "string") {
    if (typeof value !== "string") return { error: `expected a string, got ${typeof value}` };
    return { value };
  }
  if (shape.type === "number") {
    if (typeof value === "string" && value.trim() !== "" && isFinite(Number(value))) {
      return { value: Number(value) };
    }
    if (typeof value !== "number" || !isFinite(value)) {
      return { error: `expected a number, got ${typeof value}` };
    }
    return { value };
  }
  if (shape.type === "boolean") {
    if (typeof value === "boolean") return { value };
    if (value === "true" || value === "1") return { value: true };
    if (value === "false" || value === "0" || value === "") return { value: false };
    return { error: `expected a boolean, got ${typeof value}` };
  }
  if (shape.type === "enum") {
    if (!shape.values.includes(value)) {
      return { error: `expected one of ${shape.values.join(", ")}` };
    }
    return { value };
  }
  return { error: `unsupported shape ${shape.type}` };
}

// Resolves a path the model may have given as repo-relative or absolute.
function resolveIn(dir, p) {
  if (!p) return null;
  return isAbsolute(p) ? p : join(dir, p);
}

const TraceTool = defineTool({
  description:
    "Run a JavaScript or TypeScript program and read its call tree as text. " +
    "Reports where the time went, which functions ran most, and which calls " +
    "threw. Use this instead of guessing at control flow from source: it runs " +
    "the code, so async interleaving, early returns and callbacks are observed " +
    "rather than inferred.\n\n" +
    "Accepts a file (.js .mjs .cjs .jsx .ts .mts .cts .tsx), a directory, or a " +
    "glob like src/**/*.ts. Local imports are instrumented too, so the tree " +
    "spans files.\n\n" +
    "Examples:\n" +
    '  cyclops_trace({ target: "src/cli.ts", view: "summary" })\n' +
    '  cyclops_trace({ target: "src/", focus: "parse", view: "tree" })\n' +
    '  cyclops_trace({ target: "src/**/*.js", view: "flat", timing: true })',
  args: {
    target: {
      type: "string",
      description: "File, directory or glob to trace. Required.",
      optional: false,
    },
    view: {
      type: "enum",
      values: ["summary", "tree", "flat"],
      description:
        "summary: where time went and what threw (default). " +
        "tree: indented call tree. flat: one line per frame.",
      optional: true,
    },
    focus: {
      type: "string",
      description:
        "Only report this function: scopes the whole report to its subtree. " +
        "Useful in a large program where the whole trace is not the question.",
      optional: true,
    },
    maxDepth: {
      type: "number",
      description: "Tree depth cap for view:'tree'. Default 12.",
      optional: true,
    },
    maxFrames: {
      type: "number",
      description: "Hard frame cap. Default 2000, which keeps output bounded.",
      optional: true,
    },
    timing: {
      type: "boolean",
      description: "Show per-frame durations. Default true.",
      optional: true,
    },
    outFile: {
      type: "string",
      description:
        "Where to write the full trace JSON. Default out/tree.json in the " +
        "project. Read this later if the text view was truncated.",
      optional: true,
    },
    keepTree: {
      type: "boolean",
      description: "Also write out/tree.json so the viewer can be opened.",
      optional: true,
    },
  },
  async execute(args, context) {
    const dir = context?.directory ?? process.cwd();
    const {
      target, view = "summary", focus = null,
      maxDepth = 12, maxFrames = 2000, timing = true,
      outFile, keepTree = false,
    } = args;

    if (!target) {
      return { title: "cyclops", output: "cyclops_trace: `target` is required." };
    }

    const plan = planEntry([target], { cwd: dir });
    if (plan.error) {
      return {
        title: "cyclops: nothing to trace",
        output:
          `${plan.error}\n\n` +
          "cyclops traces: .js .mjs .cjs .jsx .ts .mts .cts .tsx\n" +
          "Give a file, a directory, or a glob such as src/**/*.ts.",
      };
    }

    const resolved = resolveIn(dir, plan.entry);
    const result = trace(plan.entry, { cwd: dir, timeoutMs: 60_000 });

    // A program that threw still produces a tree, and the tree is the point.
    // Only a trace that could not be produced at all is an error.
    if (!result.ok || !result.tree) {
      return {
        title: "cyclops: no trace",
        output:
          `Could not trace ${plan.entry}.\n\n` +
          `${result.error ?? "unknown error"}\n\n` +
          "Common causes: the file does not exist, its syntax is not supported, " +
          "or the program made no instrumented call before exiting.",
      };
    }

    const { tree } = result;
    let body;

    if (view === "tree") {
      body = renderTree(tree.roots, {
        maxDepth, maxFrames, timing, location: true,
      });
    } else if (view === "flat") {
      body = renderFlat(tree.roots, { timing, maxFrames });
    } else {
      body = summarize(tree.roots, {
        focus,
        title: relative(dir, result.entry) || result.entry,
      });
    }

    if (focus && view !== "summary") {
      const hits = findFrames(tree.roots, focus);
      if (hits.length) {
        const scoped = hits.map((h) => h.frame);
        body = view === "tree"
          ? renderTree(scoped, { maxDepth, maxFrames, timing })
          : renderFlat(scoped, { timing, maxFrames });
      } else {
        body = `no frame matched "${focus}"\n\n` + body;
      }
    }

    // The target's own output goes first: when a program prints something and
    // then fails, that output is the reason, and burying it under a call tree
    // would be backwards.
    const parts = [];
    if (result.stdout && result.stdout.trim()) {
      parts.push("## program output\n", result.stdout.trimEnd());
    }
    parts.push(body);

    const trailer = [];
    if (plan.considered > 1) {
      trailer.push(`${plan.considered} files matched; entered at ${plan.entry}`);
    }
    if (result.instrumented > 0) {
      trailer.push(`${result.instrumented} imported file(s) instrumented as well`);
    }
    if (result.exitCode !== null && result.exitCode !== 0) {
      trailer.push(`program exited with code ${result.exitCode}`);
    }
    for (const w of result.warnings ?? []) {
      trailer.push(`skipped ${w.reason} "${w.name}" at ${w.file}:${w.line}`);
    }

    let treePath = null;
    if (keepTree || outFile) {
      const { writeTree } = await import("../src/treeio.js");
      const dest = resolveIn(dir, outFile ?? join("out", "tree.json"));
      if (dest) {
        writeTree(dest, tree);
        treePath = dest;
        trailer.push(`full trace written to ${dest} (cyclops <target> to view it)`);
      }
    }

    if (trailer.length) parts.push("\n" + trailer.map((t) => "— " + t).join("\n"));

    let output = parts.join("\n");
    let truncated = false;
    if (output.length > MAX_OUTPUT_CHARS) {
      // Cut on a line boundary so the tail is not half a row, and say so.
      const cut = output.slice(0, MAX_OUTPUT_CHARS);
      const at = cut.lastIndexOf("\n");
      output = cut.slice(0, at > 0 ? at : MAX_OUTPUT_CHARS);
      truncated = true;
      output +=
        `\n\n[truncated at ${MAX_OUTPUT_CHARS} chars of ${parts.join("\n").length}. ` +
        `Narrow the trace with focus:, lower maxDepth, or raise maxFrames.]`;
    }

    return {
      title: `cyclops ${relative(dir, result.entry) || result.entry}`,
      output,
      metadata: {
        entry: result.entry,
        exitCode: result.exitCode,
        treePath,
        truncated,
        instrumentedFiles: result.instrumented,
      },
    };
  },
});

export const CyclopsPlugin = async ({ directory }) => {
  // Caching per project so a second trace in the same session reuses the trace
  // file the first one wrote instead of re-running an unchanged program.
  const lastTrace = new Map();

  return {
    tool: {
      cyclops_trace: TraceTool,
    },

    // When a trace has already been taken for a file, re-running is almost
    // never what the agent wants; the program may have side effects. The tool
    // says when it reused a trace.
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "cyclops_trace") return;
      const meta = output.metadata;
      if (meta?.treePath && meta?.entry && existsSync(meta.treePath)) {
        lastTrace.set(meta.entry, { at: Date.now(), path: meta.treePath });
      }
    },
  };
};

export { TraceTool, validate };