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
import { reviewExecution, sessionIdOf } from "./gate.js";

const core = await loadCore();
const { STEP, Telemetry } = core.telemetry;
// An import line on stderr: proves the module was imported, ahead of any apply.
if (typeof console !== "undefined" && console.error) {
  console.error(`[notnativereviewer] module imported, core loaded ${core.version.VERSION}`);
}
const { ReviewerPackageStore } = core.package;
const { ObservationStore } = core.observation;
const { StateFile } = core.state;
const { detectCatastrophe } = core.floor;
const { buildFileLayer } = core.files;
const { buildDedupe } = core.dedupe;
const { readPluginDirectory } = core.settings;
const { VERSION } = core.version;

export const name = "notnativereviewer";

// The service the reviewer calls through. Cordis refuses an undeclared service
// access with "cannot get property without inject" — the dependency must be named
// here so the host wires it into this plugin's context (docs/user/develop/basic).
export const inject = ["llm"];

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
    let complained = false;
    return (line) => {
      try {
        fs.appendFileSync(path, `${line}\n`, "utf8");
      } catch (error) {
        // A logging failure must not change a decision (coding-discipline.md §5),
        // but it must also not be invisible: the operator is told once per process,
        // on stderr, where the audit log was meant to go and why it could not.
        if (!complained && typeof console !== "undefined" && console.error) {
          complained = true;
          console.error(`[notnativereviewer] telemetry write failed for ${path}: ${error && error.message}`);
        }
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
 * operator. Used when no model is known for the conversation — no selection, no
 * assistant message, and no configured fallback.
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
      "NotNativeReviewer: no model is known for this conversation yet, so the operator decides this call.",
  };
}

/**
 * The pre-execute decision for one call, reviewer wired or not.
 *
 * The reviewer's model is resolved live: the session's newest known selection —
 * what the user chose or what actually ran last — wins; the configured value is
 * only the fallback for a session that has shown none. A session with no model
 * anywhere gets the floor-first fallback: the operator decides.
 *
 * @param {object} exec a DSH ToolExecution
 * @param {{telemetry: object, stores: object, config: object, callerFactory: Function,
 *          seen: object, fileLayer: object}} deps
 * @returns {Promise<{kind: string, reason?: string}>}
 */
async function decide(exec, deps) {
  const sessionID = sessionIdOf(exec);
  const known = deps.stores.models.get(sessionID);
  const fallback = deps.config.provider && deps.config.model
    ? { provider: deps.config.provider, model: deps.config.model }
    : null;
  const target = known || fallback;
  if (!target) return fallbackDecision(exec);
  const options = {
    deadlineMs: deps.config.deadlineMs,
    caller: (args) => deps.callerFactory(target, args),
  };
  try {
    return await reviewExecution(exec, { ...deps, options });
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
 * One session event, dispatched by type.
 *
 * `model/selection` is the user's live choice; `assistant/message` is what actually
 * ran. Both update the per-session model, so a mid-stream switch — including a
 * switch away from a dead provider — is followed by the very next review.
 * `user/message` with source kind `user` is authority; DSH stamps every producer's
 * kind on its messages, so an injected context arrives with a kind that is not
 * `user` and is refused — authority answered by the producer, not a role flag.
 *
 * @param {{telemetry: object, stores: object, state: object}} deps
 * @param {object} session the session that logged the event
 * @param {object} event the appended event
 */
function recordSessionEvent(deps, session, event) {
  if (!event || typeof event.type !== "string") return;
  const sessionID = String((session && session.id) || "unknown");
  if (event.type === "model/selection" && event.data && event.data.provider && event.data.model) {
    deps.stores.models.set(sessionID, { provider: String(event.data.provider), model: String(event.data.model) });
    return;
  }
  if (event.type === "assistant/message") {
    const message = event.data && event.data.message;
    const source = message && message.source;
    if (source && source.kind === "model" && source.provider && source.model) {
      deps.stores.models.set(sessionID, { provider: String(source.provider), model: String(source.model) });
    }
    return;
  }
  if (event.type !== "user/message") return;
  const message = event.data;
  if (!message || !message.source || message.source.kind !== "user") return;
  const text = textOf(message.content);
  if (text === "") return;
  const admitted = deps.stores.packages.recordUserInput({
    sessionID,
    id: String(message.id || ""),
    text,
    at: Date.now(),
  });
  deps.state.save(deps.stores);
  deps.telemetry.record(STEP.PROMPT_ADMITTED, {
    data: { source: "session.event", recorded: admitted.recorded, ...deps.stores.packages.summarise(sessionID) },
  });
}

/**
 * Install the listeners.
 *
 * @param {object} ctx the host context
 * @param {{provider?: string, model?: string, deadlineMs?: number}} [config]
 */
export function apply(ctx, config = {}) {
  // A boot line on stderr: one line per process, visible wherever the host's
  // stderr goes. It says the plugin activated and names its core directory.
  if (typeof console !== "undefined" && console.error) {
    console.error(`[notnativereviewer] activated, version ${VERSION}, core at ${readPluginDirectory()}`);
  }
  const telemetry = new Telemetry({ write: telemetrySink() });
  const stores = { packages: new ReviewerPackageStore(), observations: new ObservationStore(), models: new Map() };
  const state = new StateFile({
    directory: readPluginDirectory(),
    ttlMs: null,
    layer: buildFileLayer(),
    writer: stateWriter(),
    onFailure: (reason) => telemetry.record(STEP.STATE_RESTORED, { ok: false, data: { reason: `write:${reason}` } }),
  });
  const callerFactory = buildDshCaller(ctx);
  const deps = {
    telemetry,
    stores,
    state,
    config,
    seen: buildDedupe(),
    fileLayer: buildFileLayer(),
    callerFactory,
  };

  telemetry.record(STEP.SETUP, {
    data: {
      version: VERSION,
      host: "dsh",
      hasSessionEvent: Boolean(ctx && typeof ctx.on === "function"),
    },
  });

  const restored = state.restoreInto(stores);
  telemetry.record(STEP.STATE_RESTORED, {
    ok: restored.ok,
    data: { reason: restored.reason, sessions: restored.sessions, reads: restored.reads },
  });

  if (ctx && typeof ctx.on === "function") {
    ctx.on("session/event", (session, event) => recordSessionEvent(deps, session, event));
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

  // Exposed for a diagnostic: the gate's own record, readable through diagnosticFor.
  // A cordis context refuses arbitrary property assignment, so the OpenCode habit of
  // stamping it onto ctx is guarded here and the record is kept on the adapter side.
  diagnostics.set(ctx, { telemetry, stores, state, context: ctx });
  try {
    ctx.notnativereviewer = diagnostics.get(ctx);
  } catch {
    // The host protects its context; diagnosticFor still answers.
  }
}

/** Per-context diagnostic records, keyed by the context instance itself. */
const diagnostics = new WeakMap();

/**
 * The gate's own record for one host context: telemetry, stores, state. Not a public
 * API; a diagnostic for tests and operators.
 *
 * @param {object} ctx the host context passed to apply
 * @returns {object | undefined}
 */
export function diagnosticFor(ctx) {
  return diagnostics.get(ctx);
}
