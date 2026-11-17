/**
 * Hooks — registration for each host hook point.
 *
 * Each function returns true when the host provided the hook and the gate registered on
 * it, and false when it did not — a visible degradation that the gate records, and the
 * host surface shows as partially ungoverned. The core arrives through `core.js`.
 */
import { loadCore } from "./core.js";

const core = await loadCore();
const { digest, STEP } = core.telemetry;
const { runEvaluation } = core.evaluate;
const { recordWriteDigest } = core.ledger;
const { readParentID } = core.parentLink;
const { TRUST } = core.package;
const { recordQuestionReply, recordRenderAnswer } = core.questions;

/** How many sessions' models to remember. Bounded, because sessions may never end. */
const MAX_REMEMBERED_MODELS = 256;

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

/** Write the state file after a change (§5.6). A failed write never decides a call. */
function saveState(deps) {
  try {
    if (deps.state && typeof deps.state.save === "function") deps.state.save(deps.stores);
  } catch {
    // The in-memory stores still answer.
  }
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
    saveState(deps);
    return result;
  });
  return true;
}

/**
 * Write a gate result onto the host event. A deny always applies. An allow or ask applies
 * only when it is at least as strict as the host decision, so the gate cannot loosen one.
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
 * Register the prompt hook. Every user input joins the package. The hook records; it does
 * not reject, because the host gives the prompt hook no rejection API.
 */
export function registerPrompt(ctx, deps) {
  if (!ctx.session || typeof ctx.session.hook !== "function") return false;
  ctx.session.hook("prompt", async (event) => {
    const prompt = event && event.prompt;
    const sessionID = event && event.sessionID;
    if (!sessionID || !prompt) return undefined;
    const messageID = prompt.messageID || prompt.id || digest(String(prompt.text || ""));
    const at = prompt.time && Number.isFinite(prompt.time.created) ? prompt.time.created : Date.now();
    // A prompt may arrive before the host reports the session's parent, so resolve it once,
    // before the first record is written.
    await ensureDelegation(ctx, deps, sessionID);
    const admitted = deps.stores.packages.recordUserInput({
      sessionID,
      id: messageID,
      text: String(prompt.text || ""),
      at,
    });
    const recorded = admitted.recorded;
    deps.telemetry.record(STEP.PROMPT_ADMITTED, {
      sessionID,
      data: {
        delivery: prompt.delivery,
        textBytes: typeof prompt.text === "string" ? prompt.text.length : 0,
        files: Array.isArray(prompt.files) ? prompt.files.length : 0,
        messageDigest: messageID ? digest(messageID) : null,
        recorded,
        snapshot: admitted.snapshot,
        ...deps.stores.packages.summarise(sessionID),
      },
    });
    if (recorded) {
      deps.telemetry.record(STEP.PACKAGE_UPDATED, {
        sessionID,
        data: { source: "prompt", ...deps.stores.packages.summarise(sessionID) },
      });
    }
    if (admitted.snapshot) {
      deps.telemetry.record(STEP.PACKAGE_SNAPSHOT, {
        sessionID,
        data: { source: "prompt", ...deps.stores.packages.summarise(sessionID) },
      });
    }
    saveState(deps);
    return undefined;
  });
  return true;
}

/**
 * Learn whether this session was delegated, before its first prompt is recorded.
 *
 * The parent id comes from a read of one session record, never inference (§5.4). A failed
 * lookup leaves the session top-level, which is the behaviour of a session the user opened
 * directly.
 *
 * @param {object} ctx the host context
 * @param {object} deps the gate dependencies
 * @param {string} sessionID
 */
async function ensureDelegation(ctx, deps, sessionID) {
  const packages = deps.stores && deps.stores.packages;
  if (!packages || typeof packages.linkParent !== "function") return;
  if (typeof packages.isDelegated === "function" && packages.isDelegated(sessionID)) return;
  // Only a session with no records yet can be a fresh child, so this runs once per session.
  if (packages.summarise(sessionID).records > 0) return;
  const { parentID, via } = await readParentID(ctx, sessionID);
  if (!parentID) return;
  const result = packages.linkParent(sessionID, parentID);
  if (result.linked) {
    deps.telemetry.record(STEP.DELEGATION_OBSERVED, {
      sessionID,
      data: { inherited: result.inherited, via },
    });
  }
}

/**
 * Register the context hook. The hook runs before each agent-loop model request.
 *
 * The gate records both sides by role (§5.3): `assistant` as `model_utterance`, evidence and
 * never authority; `user` as user input, which is authority. The role flags separate the two,
 * so an answer that reaches the model by any path — typed prompt, card answer, question
 * reply — anchors the package even when no prompt hook fired for it.
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
      if (!message || typeof message.role !== "string") continue;
      if (message.role === "assistant") {
        const messageID = message.id || message.messageID;
        if (!messageID) continue;
        const text = readMessageText(message);
        if (!text) continue;
        const at = readMessageTime(message);
        if (deps.stores.packages.recordText({ sessionID, id: messageID, text, trust: TRUST.MODEL_UTTERANCE, at })) recorded += 1;
        continue;
      }
      if (message.role === "user") {
        const text = readMessageText(message);
        if (!text) continue;
        // The host's id is the one the prompt hook would also see, so the same message is
        // never recorded twice; a digest stands in when the host names nothing.
        const messageID = message.id || message.messageID || `ctx:${digest(text)}`;
        const at = readMessageTime(message);
        if (deps.stores.packages.recordUserInput({ sessionID, id: messageID, text, at }).recorded) recorded += 1;
      }
    }
    deps.telemetry.record(STEP.CONTEXT_OBSERVED, {
      sessionID,
      data: { messages: messages.length, recorded, ...deps.stores.packages.summarise(sessionID) },
    });
    return undefined;
  });
  return true;
}

/** The time a message was created, or now. */
function readMessageTime(message) {
  return message.time && Number.isFinite(message.time.created) ? message.time.created : Date.now();
}/**
 * Remember the model that this session is using (D-019).
 *
 * The host carries a ModelRef: `providerID`, `id`, and an optional `variant`. Keep only
 * those fields, so a larger event object does not reach the transport.
 *
 * The map is capped so that a host which never ends sessions cannot grow it without limit.
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
  while (models.size > MAX_REMEMBERED_MODELS) {
    const oldest = models.keys().next();
    if (oldest.done) break;
    models.delete(oldest.value);
  }
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
    // A read that passed changed the ledger; the package may have changed too (§5.6).
    saveState(deps);
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
 * Register the tool result hook. The gate records the digest of a file that a write left
 * on disk, and appends a render-page answer to the package. It does not keep the tool
 * result: tool calls and results are not part of the conversation the reviewer reads.
 *
 * The host sends the call's arguments as `input` and an empty `resources`, so the target
 * comes from the same reader that the gate uses before the call.
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
    deps.telemetry.record(STEP.EVENT_OBSERVED, {
      sessionID,
      data: { tool, targetPaths: targetPaths.length },
    });
    // A call that changed a file just left known content on disk. Recording it here is
    // what lets the agent edit the same file again without reading it first (§6).
    recordChangedFile(deps, event, tool, targetPaths);
    // A render page that waited for an answer carries the user's choice. Append it to the
    // package, so the reviewer can treat it as authority for the calls that follow.
    try {
      recordRenderAnswer(deps, event);
    } catch {
      // A malformed tool result must not break the tool result hook.
    }
    // A read or a write changed the ledger, and a page answer may have changed authority.
    saveState(deps);
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
 * Register the event stream. Question answers join the package.
 *
 * The stream observes and records; it never forgets. A lifecycle event that arrives at the
 * wrong moment (a subagent ending, an idle parent, a reconnecting client) must not delete
 * the evidence behind a live call. Only a new user input supersedes a package, and the
 * superseded one is retained as the previous package.
 */
export function registerEvents(ctx, deps) {
  if (!ctx.event || typeof ctx.event.subscribe !== "function") return false;
  try {
    ctx.event.subscribe(
      {
        types: [
          "session.created",
          "session.updated",
          "session.end",
          "session.deleted",
          "session.idle",
          "session.status",
          "question.replied",
          "question.v2.replied",
        ],
      },
      (event) => {
        // A question answer is user authority, not a lifecycle event. Append it and stop.
        if (event && typeof event.type === "string" && event.type.startsWith("question.")) {
          try {
            recordQuestionReply(deps, event);
          } catch {
            // A malformed answer must not break the event stream.
          }
          saveState(deps);
          return;
        }
        // A created or updated session names its parent. That link is the only evidence
        // that this session is a delegate rather than a session the user opened.
        const info = event && event.properties && event.properties.info;
        if (info && typeof info.id === "string" && typeof info.parentID === "string" && info.parentID !== "") {
          const linked = deps.stores.packages.linkParent(info.id, info.parentID);
          if (linked.linked) {
            deps.telemetry.record(STEP.DELEGATION_OBSERVED, {
              sessionID: info.id,
              data: { inherited: linked.inherited, via: "event" },
            });
            saveState(deps);
          }
          return;
        }
        const sessionID = event && (event.sessionID || (event.properties && event.properties.sessionID));
        if (!sessionID) return;
        deps.telemetry.record(STEP.EVENT_OBSERVED, { sessionID, data: { eventType: event.type } });
      },
    );
  } catch {
    return false;
  }
  return true;
}
