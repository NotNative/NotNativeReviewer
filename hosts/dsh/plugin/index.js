/**
 * NotNativeReviewer — tool-use permission reviewer for the DeepSeek Harness.
 *
 * Entrypoint for the DSH plugin loader: `name` and `apply(ctx, config)` (docs/user/
 * develop/basic/index.md). The core arrives through `core.js`, unchanged from the
 * OpenCode adapter's copy of the loader.
 *
 * Floor-first milestone (plan, multi-host architecture, step 3). The reviewer agent
 * call is not wired yet. What this build does:
 *
 *   ctx.on('session/event')     records the user's own words as authority; an injected
 *                               user-role message (source.kind !== 'user') is refused,
 *                               which DSH makes possible because every producer stamps
 *                               its own source kind.
 *   ctx.on('tools/pre-execute') denies a catastrophe deterministically, without a
 *                               model, and sends every other call to the operator
 *                               through the host's native `ask` seam.
 *
 * A waterfall listener that returns without `next()` denies; that is the fail-closed
 * direction, and here it is deliberate. Telemetry is local and carries no content.
 */

import { loadCore } from "./core.js";

const core = await loadCore();
const { STEP, Telemetry } = core.telemetry;
const { ReviewerPackageStore } = core.package;
const { ObservationStore } = core.observation;
const { StateFile } = core.state;
const { detectCatastrophe } = core.floor;
const { buildFileLayer } = core.files;
const { readPluginDirectory } = core.settings;
const { VERSION } = core.version;

export const name = "notnativereviewer";

/** The shell tools whose `command` argument the catastrophe check reads. */
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
 * The command text of a shell call, or an empty string for every other tool.
 *
 * @param {{name: string, arguments: unknown}} exec
 * @returns {string}
 */
export function shellCommandOf(exec) {
  if (!exec || !SHELL_TOOLS.has(exec.name)) return "";
  const args = exec.arguments;
  if (!args || typeof args !== "object") return "";
  const command = /** @type {{command?: unknown}} */ (args).command;
  return typeof command === "string" ? command : "";
}

/**
 * The DSH pre-execute decision for one call, without the host.
 *
 * The catastrophe deny is deterministic: no model is asked, and no operator either.
 * Everything else goes to the operator through the host's `ask` seam — the honest
 * intermediate state of a floor-first build, and fail-closed by construction.
 *
 * @param {{name: string, arguments: unknown}} exec
 * @returns {{kind: "deny", reason: string} | {kind: "ask", reason: string}}
 */
export function decidePreExecute(exec) {
  const command = shellCommandOf(exec);
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
      "NotNativeReviewer (floor-first): the reviewer agent is not wired in this build, "
      + "so the operator decides this call.",
  };
}

/**
 * Install the listeners.
 *
 * @param {object} ctx the host context
 * @param {object} [config] the plugin config; reserved for the reviewer wiring
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

  telemetry.record(STEP.SETUP, {
    data: {
      version: VERSION,
      host: "dsh",
      milestone: "floor-first",
      hasSessionEvent: Boolean(ctx && typeof ctx.on === "function"),
    },
  });

  const restored = state.restoreInto(stores);
  telemetry.record(STEP.STATE_RESTORED, {
    ok: restored.ok,
    data: { reason: restored.reason, sessions: restored.sessions, reads: restored.reads },
  });

  // The user's own words are authority. DSH stamps every user-role message with its
  // producer's source kind, so an injected context (a notice, a skill, a cron note)
  // arrives with a kind that is not 'user' and is refused here — the authority
  // question answered by the producer, not by a role flag.
  if (ctx && typeof ctx.on === "function") {
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
      const decision = decidePreExecute(exec);
      const effect = decision.kind === "deny" ? "deny" : "ask";
      telemetry.record(STEP.DECISION_APPLIED, {
        data: { action: String(exec && exec.name || ""), effect, reason: decision.kind },
      });
      telemetry.record(STEP.EVALUATE_END, { data: { effect } });
      if (decision.kind === "deny") {
        return { kind: "deny", reason: decision.reason };
      }
      // `ask` reaches the host's approval seam; with no seam mounted DSH itself
      // degrades it to a deny, so the fail-closed property holds either way.
      void next;
      return { kind: "ask", reason: decision.reason };
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
