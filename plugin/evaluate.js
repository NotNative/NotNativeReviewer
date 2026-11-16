/**
 * Evaluate — the enforcement step for one permission evaluation.
 *
 * This module runs the sequence that docs/how-it-works.md §4 describes:
 *   1. Classify the call deterministically (§4.1).
 *   2. Check the read-before-write invariant for a modify (§6).
 *   3. Build the bounded request projection (§5).
 *   4. Ask the reviewer, with one repair (§4.2, §4.3).
 *   5. Apply the decision, or fail closed (§7).
 *
 * Every step writes a telemetry record. Telemetry carries no content.
 *
 * The module never throws into the host hook: a failure becomes a deny.
 */

import { byteLength, trimToBytes, budgetText } from "./bytes.js";
import { CLASS, classifyCall, detectCatastrophe, readCommandBase, readScriptPaths, readTargetPaths } from "./floor.js";
import {
  FAILURE_REASON,
  OUTCOME,
  buildFailureDecision,
  mapDecisionToEffect,
  parseReviewerOutput,
  validateDecision,
} from "./grammar.js";
import { readValidAnchors } from "./package.js";
import { checkWriteInvariant, recordReads } from "./ledger.js";
import { callKey } from "./dedupe.js";
import { buildReviewerRequest, callReviewer, REVIEW_DEADLINE_MS } from "./reviewer.js";
import { STEP } from "./telemetry.js";

/**
 * Run the evaluate sequence for one call.
 *
 * `seen` is the dedupe registry. The host can send one tool call through two hooks, so a
 * call that was already reviewed is answered from the earlier decision instead of being
 * reviewed again (§3.2). A skipped call writes its own record, so the count still
 * accounts for it.
 *
 * @param {{
 *   event: object,
 *   stores: { packages: object, observations: object, models?: object },
 *   telemetry: object,
 *   ctx: object,
 *   seen?: { claim: (key: string) => boolean, remember: (key: string) => void },
 *   readFileDigest: (path: string) => Promise<{ exists: boolean, digest: string | null }> | { exists: boolean, digest: string | null },
 *   readFileText: (path: string) => Promise<string> | string,
 *   options?: object,
 * }} input
 * @returns {Promise<{ effect: string, message?: string, reason?: string }>}
 */
export async function runEvaluation(input) {
  const { event, telemetry } = input;
  const sessionID = event && event.sessionID;
  const started = Date.now();

  telemetry.record(STEP.EVALUATE_START, {
    sessionID,
    data: {
      action: event && event.action,
      hostEffect: event && event.effect,
      resources: event && event.resources ? event.resources.length : 0,
      hasSource: Boolean(event && event.source),
    },
  });

  // The same call can arrive twice, once from each hook, and the two arrivals overlap.
  // A caller that joins the earlier review is answered with that review's decision, so a
  // duplicate can never be looser than the original.
  const key = callKey(event);
  if (input.seen) {
    const earlier = input.seen.join(key);
    if (earlier) {
      const joined = await earlier;
      telemetry.record(STEP.DECISION_APPLIED, {
        sessionID,
        data: { outcome: "joined", effect: joined && joined.effect, reason: "duplicate_call" },
      });
      telemetry.record(STEP.EVALUATE_END, {
        sessionID,
        data: { effect: joined && joined.effect, reason: "duplicate_call", ms: Date.now() - started },
      });
      return joined;
    }
  }
  const settle = input.seen ? input.seen.start(key) : null;

  try {
    const result = await evaluateCall(input);
    if (settle) settle(result);
    telemetry.record(STEP.EVALUATE_END, {
      sessionID,
      data: { effect: result.effect, reason: result.reason, ms: Date.now() - started },
    });
    return result;
  } catch (error) {
    const decision = buildFailureDecision(FAILURE_REASON.REVIEWER_UNAVAILABLE, errorName(error));
    if (settle) settle({ effect: "deny", message: decision.message, reason: decision.reason_code });
    telemetry.record(STEP.FAIL_CLOSED, { sessionID, ok: false, data: { reason: decision.reason_code, errorName: errorName(error) } });
    return { effect: "deny", message: decision.message, reason: decision.reason_code };
  }
}

/** The sequence, in order. Split from runEvaluation to keep each function short. */
async function evaluateCall(input) {
  const { event, stores, telemetry, ctx } = input;
  const sessionID = event.sessionID;
  const targetPaths = readTargetPaths(event);

  const classification = classifyCall(event);
  telemetry.record(STEP.FLOOR_CLASSIFIED, {
    sessionID,
    data: { class: classification.class, reason: classification.reason, isEgress: classification.isEgress },
  });

  const posture = applyPosture(input, event, telemetry, sessionID, classification);
  if (posture) return posture;

  if (!classification.reachesReview) {
    // A read is where the gate learns a file's content, so the ledger records it before
    // the call passes. Without this the write check can never find a read to match (§6).
    recordReads(input, event);
    return applyUnchanged(event, telemetry, sessionID, "floor_safe");
  }

  const catastrophe = denyCatastrophe(event, telemetry, sessionID);
  if (catastrophe) return catastrophe;

  const writeCheck = await checkWriteInvariant(input, event);
  if (writeCheck.denied) {
    const decision = buildFailureDecision(writeCheck.reason);
    return applyDeny(event, telemetry, sessionID, decision, writeCheck.reason);
  }

  const projection = await buildProjection(input, event, targetPaths, classification);
  recordProjection(telemetry, sessionID, projection);

  if (projection.missingPackage) {
    const decision = buildFailureDecision(FAILURE_REASON.PACKAGE_UNAVAILABLE);
    return applyDeny(event, telemetry, sessionID, decision, FAILURE_REASON.PACKAGE_UNAVAILABLE);
  }

  const reviewed = await reviewWithRepair(input, projection, sessionID);
  if (!reviewed.ok) {
    const decision = buildFailureDecision(reviewed.reason);
    return applyDeny(event, telemetry, sessionID, decision, reviewed.reason);
  }

  return applyDecision(event, telemetry, sessionID, reviewed.decision);
}

/** Record the projection and the package that answered; a fallback gets its own step. */
function recordProjection(telemetry, sessionID, projection) {
  telemetry.record(STEP.PROJECTION_BUILT, {
    sessionID,
    data: {
      packageItems: projection.packageItems.length,
      validAnchors: projection.validAnchors.length,
      hasLatestUser: Boolean(projection.latestUserID),
      payloadExcerptBytes: byteLength(projection.payloadExcerpt || ""),
      // `request` is null when the package is missing, so guard the read.
      promptBytes: projection.request ? byteLength(projection.request.prompt) : 0,
      missingPackage: Boolean(projection.missingPackage),
      packageSource: projection.source || "none",
    },
  });
  if (projection.source === "previous") telemetry.record(STEP.PACKAGE_FALLBACK, { sessionID, data: { used: "previous" } });
}

/**
 * Test postures: close every reviewed call, or open every reviewed call
 * (docs/how-it-works.md §10).
 *
 * Neither posture touches a floor-safe call, so the test shows the reviewer path acting
 * and not the floor. The postures exist so that an operator can watch the gate act
 * without a model in the loop, and without trusting a model's judgement.
 */
function forceDenyReason(input) {
  const options = input.options || {};
  if (options.forceDeny) return FAILURE_REASON.REVIEWER_UNAVAILABLE;
  return null;
}

/** Whether the options ask for the forced-allow posture. */
function isForcedAllow(input) {
  const options = input.options || {};
  return Boolean(options.forceAllow);
}

/**
 * Apply a test posture (docs/how-it-works.md §10), or return null when no posture is set.
 *
 * A posture overrides the classification, so it applies to every call. It runs before the
 * floor bypass: a posture that skipped a floor-safe call would not be a test of the gate.
 * A forced close wins when both postures are set.
 */
function applyPosture(input, event, telemetry, sessionID, classification) {
  const denied = forceDenyReason(input);
  if (denied) {
    const decision = buildFailureDecision(denied);
    return applyDeny(event, telemetry, sessionID, decision, denied);
  }
  if (isForcedAllow(input)) {
    telemetry.record(STEP.DECISION_VALIDATED, { sessionID, data: { forced: "allow", floor: classification.class } });
    return applyUnchanged(event, telemetry, sessionID, "forced_allow");
  }
  return null;
}

/**
 * Build the projection: the conversation, the payload excerpt, and the reviewer request.
 *
 * Tool calls and tool results are not part of the package. The reviewer sees what the user
 * saw: the conversation, and the call it is judging.
 */
async function buildProjection(input, event, targetPaths, classification) {
  const sessionID = event.sessionID;
  const selected = input.stores.packages.selectForReview({ sessionID });
  const validAnchors = readValidAnchors(selected.items);

  // Without a user record in the selected package there is no authority to judge against.
  if (selected.items.length === 0 || validAnchors.length === 0) {
    return { missingPackage: true, packageItems: [], latestUserID: null, validAnchors: [], payloadExcerpt: "", request: null, source: selected.source };
  }
  const payloadExcerpt = await readPayloadExcerpt(input, event, targetPaths);

  const request = buildReviewerRequest({
    packageItems: selected.items,
    latestUserID: selected.latestUserID,
    validAnchors,
    payloadExcerpt,
    call: event,
    classification,
  });

  return {
    missingPackage: false,
    packageItems: selected.items,
    latestUserID: selected.latestUserID,
    validAnchors,
    payloadExcerpt,
    request,
    packageMetadata: selected.metadata,
    source: selected.source,
  };
}

/**
 * Deny a command that destroys a system root, or return null (§4.4).
 *
 * This runs before the reviewer, so the outcome does not depend on a model. The check is
 * narrow on purpose: only a system-wide root, a whole home tree, a partition format, a
 * device write, or a fork bomb. Any other destructive command stays a reviewer decision,
 * because the user may have asked for it.
 */
function denyCatastrophe(event, telemetry, sessionID) {
  const catastrophe = detectCatastrophe(readShellCommand(event));
  if (!catastrophe) return null;
  telemetry.record(STEP.FLOOR_CLASSIFIED, {
    sessionID,
    data: { class: CLASS.CONSEQUENTIAL, catastrophe: catastrophe.reason },
  });
  const decision = buildFailureDecision(FAILURE_REASON.CATASTROPHIC_COMMAND, catastrophe.detail);
  return applyDeny(event, telemetry, sessionID, decision, FAILURE_REASON.CATASTROPHIC_COMMAND);
}

/**
 * Read the file content for this call, so the reviewer judges content and not a path
 * (§4.1, D-013). The excerpt shrinks before anything else (§6.4).
 *
 * A shell call carries a command, so its first target is the command text and not a file.
 * For that call the gate reads the files that the command names, so that a script is
 * reviewed before it runs (§5.1).
 */
async function readPayloadExcerpt(input, event, targetPaths) {
  const payloadBytes = (input.options && input.options.payloadBytes) || 16384;
  if (targetPaths.length === 0) return "";

  const isShell = isShellAction(event && event.action);
  const command = String(targetPaths[0]);
  const base = isShell ? readCommandBase(command) : "";
  const all = isShell ? readScriptPaths(command) : [targetPaths[0]];
  // A value that the command uses as its own directory is not a file that it opens.
  const paths = all.filter((path) => !samePath(path, base));
  if (paths.length === 0) return isShell ? `command: ${command}` : "";

  const parts = [];
  for (const path of paths) {
    const read = await readNamedFile(input, path, base, payloadBytes);
    if (read.text === "") continue;
    parts.push(isShell ? `### file: ${read.path}\n${read.text}` : read.text);
  }
  if (parts.length === 0) {
    // The gate could not read the file. Show the command, so the reviewer still sees what
    // will run rather than an empty section it cannot interpret. Say that the content is
    // absent, so the reviewer asks rather than assuming the call is unexplained.
    return isShell ? `command: ${command}\n(file content unavailable: the gate could not read ${paths.join(", ")})` : "";
  }
  return budgetText(parts.join("\n\n"), payloadBytes).text;
}

/** Whether a named path is the command's own directory, compared loosely. */
function samePath(a, b) {
  if (!b) return false;
  const fold = (value) => String(value).replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return fold(a) === fold(b);
}

/**
 * Read one path that a command names, trying the command's own directory first.
 *
 * `git -C /repo rm src/x.js` names `src/x.js` relative to `/repo`. Reading it relative to
 * the gate's directory would find nothing, and the reviewer would judge a deletion with no
 * sight of what it deletes (§5.1).
 *
 * @returns {{ path: string, text: string }} the path that was read, and its content
 */
async function readNamedFile(input, path, base, payloadBytes) {
  for (const candidate of candidatePaths(path, base)) {
    const text = await readOneFile(input, candidate, payloadBytes);
    if (text !== "") return { path: candidate, text };
  }
  return { path, text: "" };
}

/** The paths to try for one named file: the command's directory first, then as written. */
function candidatePaths(path, base) {
  if (base === "" || isAbsolutePath(path)) return [path];
  return [joinPath(base, path), path];
}

/** Whether a path already names its own root. */
function isAbsolutePath(path) {
  return path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
}

/** Join a directory and a relative path, using one separator throughout. */
function joinPath(base, path) {
  const trimmed = base.replace(/[\\/]+$/, "");
  const relative = path.replace(/^[\\/]+/, "");
  const usesBackslash = trimmed.includes("\\") && !trimmed.includes("/");
  const joined = usesBackslash ? `${trimmed}\\${relative}` : `${trimmed}/${relative}`;
  // A file name with `/` in it reads the same either way on POSIX. On Windows one separator
  // avoids a path such as `C:\\repo/src/x.js`.
  return usesBackslash ? joined.replace(/\//g, "\\") : joined;
}

/** Whether an action is a shell command. */
function isShellAction(action) {
  const name = String(action || "").toLowerCase();
  return name === "shell" || name === "bash" || name === "sh";
}

/**
 * The command text of a shell call, or an empty string for another kind of call.
 * The command is the first target that the tool gate recorded.
 */
function readShellCommand(event) {
  if (!isShellAction(event && event.action)) return "";
  const resources = event && event.resources;
  if (!Array.isArray(resources) || resources.length === 0) return "";
  return typeof resources[0] === "string" ? resources[0] : "";
}

/** Read one file as an excerpt, or return an empty string when the gate cannot read it. */
async function readOneFile(input, path, payloadBytes) {
  try {
    const text = await input.readFileText(path);
    if (typeof text !== "string" || text === "") return "";
    return byteLength(text) <= payloadBytes ? text : trimToBytes(text, payloadBytes);
  } catch {
    return "";
  }
}

/** Name the reviewer's model for the audit record. */
function readModelIdentity(model) {
  if (!model || typeof model !== "object") return "host_default";
  const provider = String(model.providerID || "");
  const id = String(model.id || model.modelID || "");
  if (!provider && !id) return "host_default";
  return `${provider}/${id}`;
}

/**
 * Ask the reviewer. On a grammar failure, ask once more with the valid anchor list
 * (§7). The repair never patches a decision locally.
 */
async function reviewWithRepair(input, projection, sessionID) {
  const { telemetry, ctx } = input;
  if (projection.missingPackage) {
    telemetry.record(STEP.FAIL_CLOSED, { sessionID, ok: false, data: { reason: FAILURE_REASON.PACKAGE_UNAVAILABLE } });
    return { ok: false, reason: FAILURE_REASON.PACKAGE_UNAVAILABLE };
  }

  const first = await askOnce(input, projection, sessionID, false);
  if (first.ok) return first;

  telemetry.record(STEP.DECISION_REPAIRED, { sessionID, ok: false, data: { firstError: first.error } });
  const second = await askOnce(input, projection, sessionID, true);
  if (second.ok) return second;

  // Both attempts failed. Report the second failure, so the failure posture names the
  // real cause and not a generic unavailability.
  return { ok: false, reason: second.reason, error: second.error };
}

/** One reviewer call, then parse and validate. */
async function askOnce(input, projection, sessionID, isRepair) {
  const { telemetry, ctx } = input;
  const model = (input.options && input.options.model) || input.model;
  telemetry.record(STEP.REVIEWER_CALLED, {
    sessionID,
    data: { repair: isRepair, deadlineMs: REVIEW_DEADLINE_MS, model: readModelIdentity(model) },
  });

  const reply = await callReviewer(ctx, projection.request, {
    deadlineMs: (input.options && input.options.deadlineMs) || REVIEW_DEADLINE_MS,
    sessionID,
    model,
    onStep: (step, data) => telemetry.record(STEP.REVIEWER_ANSWERED, { sessionID, data: { sub: step, ...data } }),
  });

  if (!reply.ok) {
    telemetry.record(STEP.FAIL_CLOSED, { sessionID, ok: false, data: { reason: reply.reason, ms: reply.ms } });
    return { ok: false, reason: failureReasonForTransport(reply.reason), error: reply.reason };
  }

  const parsed = parseReviewerOutput(reply.text);
  if (!parsed.ok) {
    telemetry.record(STEP.DECISION_VALIDATED, { sessionID, ok: false, data: { error: parsed.error } });
    return { ok: false, reason: FAILURE_REASON.REVIEWER_OUTPUT_MALFORMED, error: parsed.error };
  }

  const validated = validateDecision(parsed.decision, projection.validAnchors);
  if (!validated.ok) {
    telemetry.record(STEP.DECISION_VALIDATED, { sessionID, ok: false, data: { errors: validated.errors.length, error: validated.errors[0] } });
    return { ok: false, reason: failureReasonForValidation(validated.errors), error: validated.errors[0] };
  }

  telemetry.record(STEP.DECISION_VALIDATED, {
    sessionID,
    data: {
      outcome: validated.decision.outcome,
      confidence: validated.decision.confidence,
      reasonCode: validated.decision.reason_code,
      anchors: validated.decision.authority_anchors.length,
      effectAssessment: validated.decision.effect_assessment,
    },
  });
  return { ok: true, decision: validated.decision };
}

/** Map a transport failure to the failure posture (§8). */
function failureReasonForTransport(reason) {
  if (reason === "timeout") return FAILURE_REASON.REVIEWER_TIMEOUT;
  return FAILURE_REASON.REVIEWER_UNAVAILABLE;
}

/** Map a validation failure to the failure posture (§8). */
function failureReasonForValidation(errors) {
  const joined = errors.join(" ");
  if (joined.includes("anchor")) return FAILURE_REASON.REVIEWER_ANCHOR_INVALID;
  return FAILURE_REASON.REVIEWER_OUTPUT_MALFORMED;
}

/** Apply a validated decision to the event. */
function applyDecision(event, telemetry, sessionID, decision) {
  const applied = mapDecisionToEffect(decision, event.effect);
  event.effect = applied.effect;
  if (applied.message) event.message = applied.message;
  telemetry.record(STEP.DECISION_APPLIED, {
    sessionID,
    data: { outcome: decision.outcome, effect: applied.effect, hadMessage: Boolean(applied.message) },
  });
  return { effect: applied.effect, message: applied.message, reason: decision.reason_code };
}

/** Apply a deny, and record why. */
function applyDeny(event, telemetry, sessionID, decision, reason) {
  event.effect = "deny";
  event.message = decision.message;
  telemetry.record(STEP.DECISION_APPLIED, { sessionID, ok: false, data: { outcome: OUTCOME.HARD_DENY, effect: "deny", reason } });
  return { effect: "deny", message: decision.message, reason };
}

/** Leave the host decision unchanged, and record it. */
function applyUnchanged(event, telemetry, sessionID, reason) {
  telemetry.record(STEP.DECISION_APPLIED, { sessionID, data: { outcome: "unchanged", effect: event.effect, reason } });
  return { effect: event.effect, reason };
}

/** An error name, safe to log. */
function errorName(error) {
  return error && error.name ? error.name : "Error";
}
