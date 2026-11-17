/**
 * NotNativeReviewer — tool-use permission reviewer for the DeepSeek Harness.
 *
 * Entrypoint for the DSH plugin loader: `name` and `apply(ctx, config)` (docs/user/
 * develop/basic/index.md). The core arrives through `core.js`, and the evaluation
 * through `gate.js`, which maps DSH's pre-execute waterfall onto the same pipeline the
 * OpenCode adapter runs.
 *
 * What this build does:
 *
 *   ctx.on('session/event')     records the user's own words as authority; an injected
 *                               user-role message (source.kind !== 'user') is refused,
 *                               which DSH makes possible because every producer stamps
 *                               its own source kind.
 *   ctx.on('tools/pre-execute') runs the full core evaluation — floor, catastrophe,
 *                               ledger, script reading — and, when a reviewer model is
 *                               configured (`provider` and `model` in the plugin
 *                               config), judges the call against the user's request.
 *                               Without a configured model, or when the reviewer is
 *                               unreachable, every consequential call goes to the
 *                               operator through the host's `ask` seam.
 *
 * A waterfall listener that returns without `next()` denies; that is the fail-closed
 * direction, and here it is deliberate. Telemetry is local and carries no content.
 */

import { loadCore } from "./core.js";
import { buildDshCaller } from "./model.js";
import { reviewExecution, toPreToolDecision } from "./gate.js";

const core = await loadCore();
const { STEP, Telemetry } = core.telemetry;
const { ReviewerPackageStore } = core.package;
const { ObservationStore } = core.observation;
const { StateFile } = core.state;
const { detectCatastrophe } = core.floor;
const { buildFileLayer } = core.files;
const { buildDedupe } = core.dedupe;
const { readPluginDirectory } = core.settings;
const { VERSION } = core.version;

export const name = "notnativereviewer";

/** The shell tools whose `command` argument the fallback catastrophe check reads. */
const SHELL_TOOLS = new Set(["bash", "pwsh"]);

/** The telemetry file name, next to the core modules. */
const TELEMETRY_FILE = "notnativereviewer-telemetry.jsonl";

/**
 * The Node filesystem module, when the runtime exposes it. DSH plugins are plain
 * Node ESM, so this normally succeeds; the probes keep the adapter honest on a
 * runtime that hides built-ins.
 *
 * @returns {object | null}
 */
function nodeFs() {
  const scope = typeof globalThis !== "undefined" ? globalThis : {};
  const process = scope.process;
  if (process && typeof process.getBuiltinModule === "function") {
    try {
      return process.getBuiltinModule("node:fs");
    } catch {
      // Fall through.
    }
  }
  return null;
}

/**
 * The telemetry sink: one append per line to the file beside the core, or stderr.
 * The host runs on a wire protocol, so stdout is never used (docs/telemetry.md §5).
 *
 * @returns {((line: string) => void) | undefined}
 */
function telemetrySink() {
  const fs = nodeFs();
  if (fs && typeof fs.appendFileSync === "function") {
    const path = `${readPluginDirectory()}${readPluginDirectory().includes("\\") ? "\\" : "/"}${TELEMETRY_FILE}`;
    return (line) => {
      try {
        fs.appendFileSync(path, `${line}\n`, "utf8");
      } catch {
        // A logging failure must not change a decision (coding-discipline.md §5).
      }
    };
  }
  if (typeof console !== "undefined" && typeof console.error === "function") {
    return (line) => console.error(`[notnativereviewer] ${line}`);
  }
  return undefined;
}

/**
 * The atomic state writer: temporary name, rename over the real file. A missing
 * writer is tolerated by the state layer itself (§5.6).
 *
 * @returns {((path: string, text: string) => void) | null}
 */
function stateWriter() {
  const fs = nodeFs();
  if (!fs || typeof fs.writeFileSync !== "function") return null;
  return (path, text) => {
    const temp = `${path}.tmp`;
    fs.writeFileSync(temp, text, "utf8");
    if (typeof fs.renameSync === "function") {
      fs.renameSync(temp, path);
      return;
    }
    fs.writeFileSync(path, text, "utf8");
  };
}

/**
 * Concatenate the text blocks of one message's content.
 *
 * @param {readonly {type: string, text?: string}[]} content
 * @returns {string}
 */
function textOf(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * The floor-first fallback decision: the deterministic catastrophe deny, then the
 * operator. Used while no reviewer model is configured.
 *
 * @param {object} exec a DSH ToolExecution
 * @returns {{kind: string, reason?: string}}
 */
function fallbackDecision(exec) {
  const args = exec && exec.arguments && typeof exec.arguments === "object" ? exec.arguments : {};
  const command = SHELL_TOOLS.has(exec && exec.name) && typeof args.command === "string" ? args.command : "";
  if (command !== "") {
    const catastrophe = detectCatastrophe(command);
    if (catastrophe) {
      const detail = catastrophe.detail || "the command would destroy a system root";
      return {
        kind: "deny",
        reason: `NotNativeReviewer: ${detail}. No user request makes this call safe, so no model was asked.`,
      };
    }
  }
  return {
    kind: "ask",
    reason:
      "NotNativeReviewer: no reviewer model is configured, so the operator decides this call.",
  };
}

/**
 * The pre-execute decision for one call, reviewer wired or not.
 *
 * @param {object} exec a DSH ToolExecution
 * @param {{telemetry: object, stores: object, options: object, seen: object, fileLayer: object, hasReviewer: boolean}} deps
 * @returns {Promise<{kind: string, reason?: string}>}
 */
async function decide(exec, deps) {
  if (!deps.hasReviewer) return fallbackDecision(exec);
  try {
    return await reviewExecution(exec, deps);
  } catch (error) {
    deps.telemetry.record(STEP.UNGOVERNED, {
      ok: false,
      data: { gate: "review_failed", errorName: error && error.name },
    });
    // A review that cannot run denies: the operator is asked, never the model trusted
    // with silence. The message names the failure, so the agent can see why.
    return { kind: "ask", reason: "NotNativeReviewer: the reviewer did not answer, so the operator decides this call." };
  }
}

/**
 * Install the listeners.
 *
 * @param {object} ctx the host context
 * @param {{provider?: string, model?: string, deadlineMs?: number}} [config]
 */
export function apply(ctx, config = {}) {
  const telemetry = new Telemetry({ write: telemetrySink() });
  const stores = { packages: new ReviewerPackageStore(), observations: new ObservationStore(), models: new Map() };
  const state = new StateFile({
    directory: readPluginDirectory(),
    ttlMs: null,
    layer: buildFileLayer(),
    writer: stateWriter(),
    onFailure: (reason) => telemetry.record(STEP.STATE_RESTORED, { ok: false, data: { reason: `write:${reason}` } }),
  });
  const caller = buildDshCaller(ctx, config);
  const deps = {
    telemetry,
    stores,
    seen: buildDedupe(),
    fileLayer: buildFileLayer(),
    options: { caller, deadlineMs: config.deadlineMs },
    hasReviewer: Boolean(caller),
  };

  telemetry.record(STEP.SETUP, {
    data: {
      version: VERSION,
      host: "dsh",
      hasReviewer: deps.hasReviewer,
      hasSessionEvent: Boolean(ctx && typeof ctx.on === "function"),
    },
  });

  const restored = state.restoreInto(stores);
  telemetry.record(STEP.STATE_RESTORED, {
    ok: restored.ok,
    data: { reason: restored.reason, sessions: restored.sessions, reads: restored.reads },
  });

  if (ctx && typeof ctx.on === "function") {
    // The user's own words are authority. DSH stamps every user-role message with its
    // producer's source kind, so an injected context arrives with a kind that is not
    // 'user' and is refused here — authority answered by the producer, not a role flag.
    ctx.on("session/event", (session, event) => {
      if (!event || event.type !== "user/message") return;
      const message = event.data;
      if (!message || !message.source || message.source.kind !== "user") return;
      const text = textOf(message.content);
      if (text === "") return;
      const sessionID = String((session && session.id) || "unknown");
      const admitted = stores.packages.recordUserInput({
        sessionID,
        id: String(message.id || ""),
        text,
        at: Date.now(),
      });
      state.save(stores);
      telemetry.record(STEP.PROMPT_ADMITTED, {
        data: { source: "session.event", recorded: admitted.recorded, ...stores.packages.summarise(sessionID) },
      });
    });

    ctx.on("tools/pre-execute", async (exec, next) => {
      telemetry.record(STEP.EVALUATE_START, { data: { action: String(exec && exec.name || "") } });
      const decision = await decide(exec, deps);
      telemetry.record(STEP.EVALUATE_END, { data: { effect: decision.kind } });
      if (decision.kind === "deny") return { kind: "deny", reason: decision.reason };
      if (decision.kind === "ask") {
        // `ask` reaches the host's approval seam; with no seam mounted DSH itself
        // degrades it to a deny, so the fail-closed property holds either way.
        void next;
        return { kind: "ask", reason: decision.reason };
      }
      return next();
    });
  } else {
    telemetry.record(STEP.UNGOVERNED, {
      ok: false,
      data: { gate: "inactive", error: "the host context has no event surface; nothing is gated" },
    });
  }

  // Exposed for a diagnostic: the gate's own record of the host context, not a public API.
  ctx.notnativereviewer = { telemetry, stores, state, context: ctx };
}
