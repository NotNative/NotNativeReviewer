/**
 * The gate: DSH's pre-execute waterfall mapped onto the core's evaluation.
 *
 * The core's `runEvaluation` is host-agnostic — it takes an event, stores, telemetry,
 * and an optional reviewer transport, and returns `{effect, message}`. This module
 * builds the event from a DSH `ToolExecution` and maps the result onto DSH's
 * `PreToolDecision`, honouring the waterfall contract: a decision never delegates, so
 * no later listener can loosen one.
 *
 * The host effect is `allow`: DSH's pre-execute carries no host decision, so the gate
 * is the only decision point. Approve therefore means `next()`; deny-with-guidance and
 * hard-deny mean `deny`; an escalation means `ask`, which DSH routes to its approval
 * seam and degrades to a deny when no seam is mounted.
 */

import { loadCore } from "./core.js";

const core = await loadCore();
const { runEvaluation } = core.evaluate;

/** The shell tools whose `command` argument becomes the gate event's resource. */
const SHELL_TOOLS = new Set(["bash", "pwsh"]);

/** The file-writing tools whose path argument becomes the gate event's resource. */
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "patch"]);

/**
 * The gate event for one DSH execution.
 *
 * A shell call carries its command text, as the OpenCode adapter's does, so the same
 * floor rules — read grammar, script reading, catastrophe — apply unchanged. Any
 * other call carries its arguments as JSON, so the reviewer sees what the call names.
 *
 * @param {object} exec a DSH ToolExecution
 * @returns {object} the core event shape
 */
export function toGateEvent(exec) {
  const args = exec && exec.arguments && typeof exec.arguments === "object" ? exec.arguments : {};
  const name = String((exec && exec.name) || "");
  let resource = JSON.stringify(args);
  if (SHELL_TOOLS.has(name) && typeof args.command === "string") {
    resource = args.command;
  } else if (WRITE_TOOLS.has(name)) {
    const path = typeof args.path === "string" ? args.path
      : typeof args.file_path === "string" ? args.file_path : "";
    if (path !== "") resource = path;
  }
  return {
    sessionID: sessionIdOf(exec),
    action: name,
    resources: [resource],
    // DSH's pre-execute carries no host decision; the gate is the only one.
    effect: "allow",
  };
}

/**
 * The session identity of a call. The agent loop stamps the calling agent on every
 * execution; its id is the same identity the session events carry. An execution with
 * no agent (a direct `ctx.tools.execute` caller) is gated under a detached identity,
 * which holds no user authority, so such a call can never inherit a package.
 *
 * @param {object} exec
 * @returns {string}
 */
export function sessionIdOf(exec) {
  const agent = exec && exec.agent;
  if (agent && typeof agent.id !== "undefined" && agent.id !== null) return String(agent.id);
  if (agent && typeof agent.sessionID !== "undefined" && agent.sessionID !== null) {
    return String(agent.sessionID);
  }
  return "detached";
}

/**
 * Map the core's `{effect, message}` onto DSH's `PreToolDecision`.
 *
 * @param {{effect: string, message?: string}} result
 * @returns {{kind: "deny", reason: string} | {kind: "ask", reason: string} | {kind: "allow"}}
 */
export function toPreToolDecision(result) {
  const message = (result && result.message) || "";
  if (result && result.effect === "allow") return { kind: "allow" };
  if (result && result.effect === "ask") {
    return { kind: "ask", reason: message || "NotNativeReviewer escalated this call to the operator." };
  }
  return { kind: "deny", reason: message || "NotNativeReviewer denied this call." };
}

/**
 * Review one execution through the core, without the host.
 *
 * @param {object} exec a DSH ToolExecution
 * @param {{telemetry: object, stores: object, options: object}} deps
 * @returns {Promise<{kind: string, reason?: string}>}
 */
export async function reviewExecution(exec, deps) {
  const event = toGateEvent(exec);
  const result = await runEvaluation({
    event,
    telemetry: deps.telemetry,
    stores: deps.stores,
    ctx: {},
    options: deps.options,
    seen: deps.seen,
    fileLayer: deps.fileLayer,
    // The read-before-write ledger and the payload reader answer file questions
    // through these; without them a floor-safe read would throw mid-pass.
    readFileDigest: (path) => deps.fileLayer.digest(path),
    readFileText: (path) => deps.fileLayer.readText(path),
  });
  return toPreToolDecision(result);
}
