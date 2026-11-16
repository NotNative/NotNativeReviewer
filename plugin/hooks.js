/**
 * Hooks — the registration functions for each host hook point.
 *
 * Each function returns true when the host provided the hook and the gate registered on
 * it, and false when the host did not. A false result is a visible degradation: the gate
 * records it, and the host surface shows the gate as partially ungoverned.
 *
 * Imports only sibling modules.
 */

import { digest, STEP } from "./telemetry.js";
import { runEvaluation } from "./evaluate.js";
import { recordWriteDigest } from "./ledger.js";
import { TRUST } from "./package.js";
import { summariseToolResult } from "./observation.js";

/**
 * Register every hook that the host provides, and record each result.
 *
 * A hook the host does not provide is recorded as ungoverned, so a host change degrades
 * the gate visibly instead of crashing it.
 *
 * @returns {{ registered: readonly string[], missing: readonly string[] }}
 */
export function registerHooks(ctx, deps) {
  const handlers = [
    ["tool.execute.before", () => registerToolBefore(ctx, deps)],
    ["permission.evaluate", () => registerEvaluate(ctx, deps)],
    ["session.prompt", () => registerPrompt(ctx, deps)],
    ["session.context", () => registerContext(ctx, deps)],
    ["tool.execute.after", () => registerToolAfter(ctx, deps)],
    ["event.subscribe", () => registerEvents(ctx, deps)],
  ];

  const registered = [];
  const missing = [];
  for (const [hook, register] of handlers) {
    let ok = false;
    try {
      ok = register() === true;
    } catch {
      ok = false;
    }
    (ok ? registered : missing).push(hook);
    deps.telemetry.record(STEP.HOOK_REGISTERED, { ok, data: { hook, registered: ok } });
  }
  return { registered, missing };
}

/** Register the enforcement hook (D-018). */
export function registerEvaluate(ctx, deps) {
  if (!ctx.permission || typeof ctx.permission.hook !== "function") return false;
  ctx.permission.hook("evaluate", async (event) => {
    let result;
    try {
      result = await runEvaluation({
        event,
        stores: deps.stores,
        telemetry: deps.telemetry,
        ctx,
        seen: deps.seen,
        readFileDigest: (path) => deps.fileLayer.digest(path),
        readFileText: (path) => deps.fileLayer.readText(path),
        options: deps.options,
        model: readSessionModel(deps, event && event.sessionID),
      });
    } catch (error) {
      // runEvaluation fails closed, but a defect in this module must not leak an allow.
      result = { effect: "deny", message: "NotNativeReviewer could not review this call, so it denied it.", reason: "reviewer_unavailable" };
    }

    // Apply the decision to the host event. The documented hook contract is mutable:
    // the hook sets `event.effect` and `event.message` (10-platform-research.md §2).
    // The gate only ever tightens: it never turns a deny into an allow.
    applyToEvent(event, result);
    return result;
  });
  return true;
}

/**
 * Write a gate result onto the host event.
 *
 * A deny always applies. An allow or ask applies only when it is at least as strict as
 * the host decision, so the gate cannot loosen a decision the configuration made.
 */
function applyToEvent(event, result) {
  if (!event || !result) return;
  const strictness = { allow: 0, ask: 1, deny: 2 };
  const hostLevel = strictness[event.effect] ?? 0;
  const gateLevel = strictness[result.effect] ?? 0;
  if (gateLevel < hostLevel) return;
  event.effect = result.effect;
  if (result.message !== undefined) event.message = result.message;
}

/**
 * Register the prompt hook. Every admitted user input starts a new review epoch
 * (§5.1.3, D-022). The hook records; it does not reject, because the host gives the
 * prompt hook no rejection API.
 */
export function registerPrompt(ctx, deps) {
  if (!ctx.session || typeof ctx.session.hook !== "function") return false;
  ctx.session.hook("prompt", async (event) => {
    const prompt = event && event.prompt;
    const sessionID = event && event.sessionID;
    if (!sessionID || !prompt) return undefined;
    const messageID = prompt.messageID || prompt.id || digest(String(prompt.text || ""));
    const result = deps.stores.packages.admitPrompt({
      sessionID,
      messageID,
      text: String(prompt.text || ""),
      delivery: prompt.delivery,
    });
    deps.telemetry.record(STEP.PROMPT_ADMITTED, {
      sessionID,
      data: {
        delivery: prompt.delivery,
        textBytes: typeof prompt.text === "string" ? prompt.text.length : 0,
        files: Array.isArray(prompt.files) ? prompt.files.length : 0,
        messageDigest: messageID ? digest(messageID) : null,
        newEpoch: result.replaced,
        epoch: result.epoch,
      },
    });
    if (result.replaced) {
      deps.telemetry.record(STEP.EPOCH_STARTED, { sessionID, data: { epoch: result.epoch } });
      deps.telemetry.record(STEP.PACKAGE_LOCKED, {
        sessionID,
        data: { epoch: result.epoch, ...deps.stores.packages.summarise(sessionID) },
      });
    }
    return undefined;
  });
  return true;
}

/**
 * Register the context hook. The hook runs before each agent-loop model request. The
 * gate records agent text as `model_utterance`, which is evidence and never authority
 * (§2.1, §5.2). It does not add current-turn text to the package, because the package
 * is locked at admission.
 */
export function registerContext(ctx, deps) {
  if (!ctx.session || typeof ctx.session.hook !== "function") return false;
  ctx.session.hook("context", async (event) => {
    const sessionID = event && event.sessionID;
    const messages = event && event.messages;
    if (!sessionID || !Array.isArray(messages)) return undefined;
    // The context event names the model that this request uses (D-019). The reviewer
    // must name the same model, or a host with no default model cannot answer.
    rememberSessionModel(deps, sessionID, event.model);
    let recorded = 0;
    for (const message of messages) {
      if (!message || message.role !== "assistant") continue;
      const messageID = message.id || message.messageID;
      if (!messageID) continue;
      const text = readMessageText(message);
      if (!text) continue;
      if (deps.stores.packages.recordText({ sessionID, messageID, text, trust: TRUST.MODEL_UTTERANCE })) recorded += 1;
    }
    deps.telemetry.record(STEP.CONTEXT_OBSERVED, {
      sessionID,
      data: { messages: messages.length, recorded, ...deps.stores.packages.summarise(sessionID) },
    });
    return undefined;
  });
  return true;
}

/**
 * Remember the model that this session is using (D-019).
 *
 * The host carries a ModelRef: `providerID`, `id`, and an optional `variant`. Keep only
 * those fields, so a larger event object does not reach the transport.
 */
function rememberSessionModel(deps, sessionID, model) {
  if (!sessionID || !model || typeof model !== "object") return;
  const models = deps.stores && deps.stores.models;
  if (!models || typeof models.set !== "function") return;
  const providerID = model.providerID;
  const id = model.id || model.modelID;
  if (!providerID || !id) return;
  const remembered = { providerID, id };
  if (model.variant) remembered.variant = model.variant;
  models.set(sessionID, remembered);
}

/** The model that this session was last seen using, or undefined. */
function readSessionModel(deps, sessionID) {
  const models = deps.stores && deps.stores.models;
  if (!models || typeof models.get !== "function" || !sessionID) return undefined;
  return models.get(sessionID);
}

/** Read assistant text from a message, without holding parts that are not text. */
function readMessageText(message) {
  if (typeof message.text === "string") return message.text;
  const parts = message.parts || message.content;
  if (!Array.isArray(parts)) return "";
  const texts = [];
  for (const part of parts) {
    if (part && typeof part.text === "string") texts.push(part.text);
  }
  return texts.join("\n");
}

/**
 * Register the tool gate. This hook fires for every tool call, and a thrown error blocks
 * the call (docs/how-it-works.md §3.1).
 *
 * `permission.evaluate` is not enough on its own: the host triggers it from one place,
 * the permission assert path, so a tool call that resolves to `allow` never reaches it.
 * The host wraps this hook as `try(hook) catch(block)`, so a throw is the only way to stop
 * a call here.
 */
export function registerToolBefore(ctx, deps) {
  if (!ctx.tool || typeof ctx.tool.hook !== "function") return false;
  ctx.tool.hook("execute.before", async (event) => {
    const sessionID = event && event.sessionID;
    if (!sessionID) return undefined;

    const call = toPermissionEvent(event);
    let result;
    try {
      result = await runEvaluation({
        event: call,
        stores: deps.stores,
        telemetry: deps.telemetry,
        ctx,
        seen: deps.seen,
        readFileDigest: (path) => deps.fileLayer.digest(path),
        readFileText: (path) => deps.fileLayer.readText(path),
        options: deps.options,
        model: readSessionModel(deps, sessionID),
      });
    } catch {
      throw new Error("NotNativeReviewer could not review this call, so it denied it.");
    }

    if (result && result.effect === "deny") {
      const message = String(result.message || "NotNativeReviewer denied this call.");
      deps.telemetry.record(STEP.DECISION_APPLIED, {
        sessionID,
        ok: false,
        data: { source: "tool.before", effect: "deny", reason: result.reason },
      });
      // A throw is what blocks the call at this layer.
      throw new Error(message);
    }
    return undefined;
  });
  return true;
}

/**
 * Present a tool event as the permission event that the evaluation expects.
 * The tool event names the call as `tool` and its arguments as `input`.
 */
function toPermissionEvent(event) {
  const tool = String(event.tool || "tool").toLowerCase();
  const input = event.input && typeof event.input === "object" ? event.input : {};
  const named = readResources(input, tool);
  return {
    sessionID: event.sessionID,
    action: tool,
    resources: named.resources,
    // A tool call whose arguments name no target cannot be checked against the ledger.
    // The gate records that, so a file-changing call denies rather than reading as a
    // create of a file that does not exist (§6).
    hasNamedResource: named.named,
    metadata: input,
    effect: "allow",
    source: event.callID || event.id ? { type: "tool", id: event.callID || event.id } : undefined,
  };
}

/**
 * The targets that a tool call names, from its input.
 *
 * The built-in tools name their target `path`: the read tool takes `{path}`, and the
 * write and edit tools take `{path, content}` and `{path, oldString, newString}`.
 * @returns {{ resources: string[], named: boolean }}
 */
function readResources(input, tool) {
  const resources = [];
  for (const key of ["path", "filePath", "file_path", "pattern", "command", "url", "query"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) resources.push(value);
  }
  if (resources.length === 0 && typeof input.target === "string" && input.target.length > 0) resources.push(input.target);
  if (resources.length === 0) return { resources: [tool], named: false };
  return { resources, named: true };
}

/**
 * Register the tool result hook. The gate keeps the digest of the tool result and a
 * short summary for the observation lane. It never keeps the full result.
 *
 * The host sends the call's arguments as `input` and an empty `resources`, so the target
 * comes from the same reader that the gate uses before the call. Without that the lane
 * says "on (no target)" and its relevance filter can never match a path.
 */
export function registerToolAfter(ctx, deps) {
  if (!ctx.tool || typeof ctx.tool.hook !== "function") return false;
  ctx.tool.hook("execute.after", async (event) => {
    const sessionID = event && event.sessionID;
    if (!sessionID) return undefined;
    const tool = String(event.tool || "tool");
    const input = event.input && typeof event.input === "object" ? event.input : {};
    const named = readResources(input, tool.toLowerCase());
    const targetPaths = named.named ? named.resources : [];
    const resultBytes = byteLengthOfJSON(event.result);
    const text = summariseToolResult({ tool, targetPaths, resultBytes, ok: event.status !== "error" });
    deps.stores.observations.recordObservation({
      sessionID,
      id: event.id || event.callID || digest(tool + targetPaths.join(",")),
      text,
      targetPaths,
    });
    deps.telemetry.record(STEP.EVENT_OBSERVED, {
      sessionID,
      data: { tool, targetPaths: targetPaths.length, resultBytes },
    });
    // A call that changed a file just left known content on disk. Recording it here is
    // what lets the agent edit the same file again without reading it first (§6).
    recordChangedFile(deps, event, tool, targetPaths);
    return undefined;
  });
  return true;
}

/**
 * Record the digest of a file that a call just changed.
 *
 * The path comes from the call arguments, not from the tool name: the host reports an
 * `edit` result under the name `write`, so the name cannot decide this. A failed call
 * changed nothing, so it records nothing.
 */
function recordChangedFile(deps, event, tool, targetPaths) {
  if (!isFileWriting(tool)) return;
  if (event.status === "error") return;
  for (const path of targetPaths) {
    recordWriteDigest(
      {
        stores: deps.stores,
        telemetry: deps.telemetry,
        readFileDigest: (target) => deps.fileLayer.digest(target),
      },
      { ...event, action: tool },
      path,
    );
  }
}

/** Whether a tool result names a call that wrote file content. */
function isFileWriting(tool) {
  const name = String(tool || "").toLowerCase();
  return name === "write" || name === "edit" || name === "patch" || name === "multiedit";
}

/**
 * Register the event stream. The gate infers turn end from the event stream, because
 * the host provides no turn-end hook (§5.4, Q11). At turn end the package is released.
 */
export function registerEvents(ctx, deps) {
  if (!ctx.event || typeof ctx.event.subscribe !== "function") return false;
  try {
    ctx.event.subscribe({ types: ["session.idle", "session.status", "session.end"] }, (event) => {
      const sessionID = event && (event.sessionID || (event.properties && event.properties.sessionID));
      if (!sessionID) return;
      if (isTurnEnd(event)) {
        deps.stores.packages.release(sessionID);
        deps.telemetry.record(STEP.TURN_ENDED, { sessionID, data: { eventType: event.type } });
      } else {
        deps.telemetry.record(STEP.EVENT_OBSERVED, { sessionID, data: { eventType: event.type } });
      }
    });
  } catch {
    return false;
  }
  return true;
}

/** Whether an event marks the end of a turn. */
function isTurnEnd(event) {
  const type = String((event && event.type) || "");
  return type === "session.idle" || type === "session.end";
}

/** The byte length of the JSON form of a value, without keeping the value. */
function byteLengthOfJSON(value) {
  if (value === undefined || value === null) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}
