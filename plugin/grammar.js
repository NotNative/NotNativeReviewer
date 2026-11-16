/**
 * Grammar — the closed decision set and its validation.
 *
 * The reviewer returns one decision from a closed outcome set
 * (docs/how-it-works.md §4.3). This module validates the decision
 * against that set, rejects unknown keys, and maps the outcome to an OpenCode effect.
 *
 * Failure posture (§8): every failure path fails closed. A malformed decision is denied,
 * not allowed. The gate never loosens a decision the host configuration made.
 *
 * No imports.
 */

/** The closed outcome set, mapped to the effect the gate applies (§7). */
export const OUTCOME = Object.freeze({
  APPROVE: "approve",
  DENY_WITH_GUIDANCE: "deny_with_guidance",
  HARD_DENY: "hard_deny",
  ESCALATE_TO_OPERATOR: "escalate_to_operator",
});

/** The effect that each outcome applies to the host decision. */
const OUTCOME_EFFECT = Object.freeze({
  [OUTCOME.APPROVE]: "unchanged",
  [OUTCOME.DENY_WITH_GUIDANCE]: "deny",
  [OUTCOME.HARD_DENY]: "deny",
  [OUTCOME.ESCALATE_TO_OPERATOR]: "ask",
});

/**
 * The fields a decision uses (§7). A field outside this set is dropped rather than
 * rejected, because a small model adds fields such as `reason` or `tool`
 * (docs/how-it-works.md §4.3).
 */
export const GRAMMAR_FIELDS = Object.freeze([
  "outcome",
  "confidence",
  "reason_code",
  "guidance",
  "authority_anchors",
  "effect_assessment",
]);

/** The effect assessment values (§7). */
export const EFFECT_ASSESSMENT = Object.freeze({
  READ_ONLY: "read_only",
  STATE_CHANGING: "state_changing",
  UNKNOWN: "unknown",
});

/** Reason codes for a gate-side failure (§8). These are not reviewer output. */
export const FAILURE_REASON = Object.freeze({
  REVIEWER_UNAVAILABLE: "reviewer_unavailable",
  REVIEWER_TIMEOUT: "reviewer_timeout",
  REVIEWER_OUTPUT_MALFORMED: "reviewer_output_malformed",
  REVIEWER_ROLE_VIOLATION: "reviewer_role_violation",
  REVIEWER_ANCHOR_INVALID: "reviewer_anchor_invalid",
  PACKAGE_UNAVAILABLE: "package_unavailable",
  PRIMARY_UNAVAILABLE: "primary_unavailable",
  WRITE_UNREAD: "write_unread",
  WRITE_STALE: "write_stale",
  CATASTROPHIC_COMMAND: "catastrophic_command",
});

/** A reason code pattern: lowercase words separated by one underscore (§7). */
const REASON_CODE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** The guidance cap, in characters. */
export const GUIDANCE_MAX_CHARS = 600;

/** The anchor cap (§7). */
export const ANCHOR_MAX_COUNT = 6;

/**
 * Parse reviewer output into a decision object.
 * The output may be bare JSON, or JSON inside a fenced block, or JSON inside prose.
 *
 * @param {string} text the reviewer output
 * @returns {{ ok: boolean, decision?: object, error?: string }}
 */
export function parseReviewerOutput(text) {
  if (typeof text !== "string") return { ok: false, error: "output_not_string" };
  const candidate = extractJSONObject(text);
  if (candidate === null) return { ok: false, error: "no_json_object" };
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "not_object" };
  }
  return { ok: true, decision: parsed };
}

/**
 * Find the first balanced JSON object in a text. Scans from the first `{` and counts
 * braces outside of string literals, so a `}` inside a guidance string does not end the
 * object early.
 * @returns {string | null}
 */
function extractJSONObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Validate a parsed decision against the grammar.
 *
 * `requiredAnchors` is set for a delegated session: it holds the record ids of the primary
 * conversation. An approval must cite at least one of them, which is how the gate enforces
 * that a subagent's task cannot authorize work the user did not ask for. A denial needs no
 * anchor, so the subordinate layer can always refuse.
 *
 * @param {object} decision
 * @param {readonly string[]} validAnchors record identifiers that the package holds
 * @param {readonly string[]} [requiredAnchors] ids that an approval must cite
 * @returns {{ ok: boolean, errors: readonly string[], decision?: NormalisedDecision }}
 */
export function validateDecision(decision, validAnchors, requiredAnchors) {
  const errors = [];
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return { ok: false, errors: ["not_object"] };
  }

  const shaped = reshape(decision, errors);
  if (shaped === null) return { ok: false, errors };

  const outcome = shaped.outcome;
  if (!Object.values(OUTCOME).includes(outcome)) errors.push("invalid_outcome");

  const confidence = shaped.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push("invalid_confidence");
  }

  const reasonCode = shaped.reason_code;
  if (typeof reasonCode !== "string" || !REASON_CODE_PATTERN.test(reasonCode)) {
    errors.push("invalid_reason_code");
  }

  if (shaped.guidance !== undefined && shaped.guidance !== null) {
    if (typeof shaped.guidance !== "string") errors.push("invalid_guidance");
    else if (shaped.guidance.length > GUIDANCE_MAX_CHARS) errors.push("guidance_too_long");
  }

  if (shaped.effect_assessment !== undefined && !Object.values(EFFECT_ASSESSMENT).includes(shaped.effect_assessment)) {
    errors.push("invalid_effect_assessment");
  }

  const anchorErrors = checkAnchors(shaped.authority_anchors, validAnchors);
  errors.push(...anchorErrors);

  // A delegated session may not approve on its own task text alone.
  const required = Array.isArray(requiredAnchors) ? requiredAnchors : [];
  if (required.length > 0 && shaped.outcome === OUTCOME.APPROVE) {
    const cited = Array.isArray(shaped.authority_anchors) ? shaped.authority_anchors : [];
    if (!cited.some((anchor) => required.includes(anchor))) errors.push("missing_primary_anchor");
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], decision: normaliseDecision(shaped) };
}

/**
 * Reshape a raw object into the grammar fields (docs/how-it-works.md §4.3).
 *
 * A small local model rarely returns the exact shape, so this step tolerates the shapes
 * that carry the same meaning, and drops fields that the grammar does not use. It never
 * invents a decision: when it cannot find a field that the grammar needs, it records an
 * error and the caller fails closed.
 *
 * Tolerated:
 *   - a synonym field name, such as `effect` for `outcome`, or `reason` for `reason_code`;
 *   - an outcome in a different case or with a space, such as `APPROVE` or `hard deny`;
 *   - an outcome word that means the same thing, such as `allow` or `deny`;
 *   - a confidence as a string, or as a percentage above 1;
 *   - a reason code with a space or a hyphen in place of an underscore;
 *   - any field that the grammar does not use, which is dropped.
 *
 * @param {object} raw
 * @param {string[]} errors collects the reason when a field cannot be found
 * @returns {object | null}
 */
function reshape(raw, errors) {
  const out = {};

  const outcome = pick(raw, ["outcome", "effect", "decision", "verdict"]);
  const outcomeWord = outcome === undefined ? undefined : OUTCOME_ALIASES[normaliseWord(outcome)];
  if (outcomeWord === undefined) errors.push("invalid_outcome");
  else out.outcome = outcomeWord;

  const confidence = pick(raw, ["confidence", "confidence_score", "certainty"]);
  if (confidence !== undefined) out.confidence = readConfidence(confidence);

  const reasonCode = pick(raw, ["reason_code", "reason", "reasonCode", "code"]);
  if (reasonCode !== undefined) out.reason_code = normaliseReasonCode(reasonCode);

  const guidance = pick(raw, ["guidance", "message", "explanation", "advice"]);
  if (guidance !== undefined && guidance !== null) out.guidance = guidance;

  const assessment = pick(raw, ["effect_assessment", "side_effect", "sideEffect"]);
  if (assessment !== undefined) out.effect_assessment = EFFECT_ALIASES[normaliseWord(assessment)] || assessment;

  const anchors = pick(raw, ["authority_anchors", "anchors", "authorityAnchors"]);
  if (anchors !== undefined) out.authority_anchors = anchors;

  return out;
}

/** The outcome words that carry the meaning of a grammar outcome. */
const OUTCOME_ALIASES = Object.freeze({
  approve: OUTCOME.APPROVE,
  approved: OUTCOME.APPROVE,
  allow: OUTCOME.APPROVE,
  allowed: OUTCOME.APPROVE,
  ok: OUTCOME.APPROVE,
  deny_with_guidance: OUTCOME.DENY_WITH_GUIDANCE,
  denywithguidance: OUTCOME.DENY_WITH_GUIDANCE,
  soft_deny: OUTCOME.DENY_WITH_GUIDANCE,
  deny: OUTCOME.DENY_WITH_GUIDANCE,
  hard_deny: OUTCOME.HARD_DENY,
  harddeny: OUTCOME.HARD_DENY,
  deny_hard: OUTCOME.HARD_DENY,
  escalate_to_operator: OUTCOME.ESCALATE_TO_OPERATOR,
  escalatetooperator: OUTCOME.ESCALATE_TO_OPERATOR,
  escalate: OUTCOME.ESCALATE_TO_OPERATOR,
  ask: OUTCOME.ESCALATE_TO_OPERATOR,
  ask_operator: OUTCOME.ESCALATE_TO_OPERATOR,
});

/** The effect assessment words that carry the meaning of an assessment. */
const EFFECT_ALIASES = Object.freeze({
  read_only: EFFECT_ASSESSMENT.READ_ONLY,
  readonly: EFFECT_ASSESSMENT.READ_ONLY,
  read: EFFECT_ASSESSMENT.READ_ONLY,
  state_changing: EFFECT_ASSESSMENT.STATE_CHANGING,
  statechanging: EFFECT_ASSESSMENT.STATE_CHANGING,
  write: EFFECT_ASSESSMENT.STATE_CHANGING,
  unknown: EFFECT_ASSESSMENT.UNKNOWN,
});

/** Read the first field that is present under any of the names. */
function pick(raw, names) {
  for (const name of names) {
    if (raw[name] !== undefined && raw[name] !== null) return raw[name];
  }
  return undefined;
}

/**
 * Reduce a word to a comparable form: lower case, and only letters, digits and underscores.
 * Thus `hard deny`, `hard-deny` and `HARD_DENY` compare the same.
 */
function normaliseWord(value) {
  if (typeof value !== "string") return "";
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Read a confidence as a number from 0 to 1, or return the raw value so it fails. */
function readConfidence(value) {
  let number = value;
  if (typeof value === "string") number = Number(value.trim().replace(/%$/, ""));
  if (typeof number !== "number" || !Number.isFinite(number)) return value;
  if (number > 1 && number <= 100) return number / 100;
  return number;
}

/** Reduce a reason code to the lowercase underscore form that the grammar expects. */
function normaliseReasonCode(value) {
  if (typeof value !== "string") return value;
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Anchors must name records of class user_authored or user_assented that are present in
 * the selected conversation (§7). An anchor that names another class, or a record not in
 * the package, is invalid.
 */
function checkAnchors(anchors, validAnchors) {
  if (anchors === undefined || anchors === null) return [];
  if (!Array.isArray(anchors)) return ["invalid_anchors"];
  if (anchors.length > ANCHOR_MAX_COUNT) return ["too_many_anchors"];
  const allowed = new Set(validAnchors || []);
  const errors = [];
  for (const anchor of anchors) {
    if (typeof anchor !== "string") {
      errors.push("invalid_anchor_type");
      continue;
    }
    if (!allowed.has(anchor)) errors.push(`anchor_not_in_package:${anchor}`);
  }
  return errors;
}

/** Produce a decision with only the grammar fields, trimmed to the caps. */
function normaliseDecision(decision) {
  const out = {
    outcome: decision.outcome,
    confidence: decision.confidence,
    reason_code: decision.reason_code,
    effect_assessment: decision.effect_assessment || EFFECT_ASSESSMENT.UNKNOWN,
    authority_anchors: Array.isArray(decision.authority_anchors) ? decision.authority_anchors.slice(0, ANCHOR_MAX_COUNT) : [],
  };
  if (typeof decision.guidance === "string" && decision.guidance.trim().length > 0) {
    out.guidance = decision.guidance.trim().slice(0, GUIDANCE_MAX_CHARS);
  }
  return out;
}

/**
 * Map a validated decision to a host effect.
 *
 * @param {{ outcome: string }} decision
 * @param {"allow" | "ask" | "deny"} hostEffect the effect the configuration produced
 * @returns {{ effect: "allow" | "ask" | "deny", message?: string }}
 */
export function mapDecisionToEffect(decision, hostEffect) {
  const applied = OUTCOME_EFFECT[decision.outcome];
  if (applied === "unchanged") {
    // Approve leaves the host decision alone. It never loosens a deny into an allow.
    return { effect: hostEffect };
  }
  const message = buildMessage(decision);
  return { effect: applied, message };
}

/**
 * Build the message that reaches the model. It carries the guidance when the reviewer
 * supplied it, and names the anchors so the model knows what the user asked for.
 */
function buildMessage(decision) {
  if (decision.outcome === OUTCOME.DENY_WITH_GUIDANCE && decision.guidance) {
    return decision.guidance;
  }
  if (decision.outcome === OUTCOME.HARD_DENY) {
    return "NotNativeReviewer denied this call: it does not match what the user asked for.";
  }
  if (decision.outcome === OUTCOME.ESCALATE_TO_OPERATOR) {
    return decision.guidance || "NotNativeReviewer asks the operator to confirm this call.";
  }
  return "";
}

/**
 * Build the fail-closed decision for a gate-side failure (§8).
 * An unavailability failure does not latch a substantive denial for later calls.
 *
 * @param {string} reasonCode one of FAILURE_REASON
 * @param {string} [detail] short text; the telemetry layer digests anything long
 * @returns {{ outcome: string, effect: "deny", message: string, reason_code: string, confidence: number }}
 */
export function buildFailureDecision(reasonCode, detail) {
  const message = failureMessage(reasonCode, detail);
  return {
    outcome: OUTCOME.HARD_DENY,
    effect: "deny",
    message,
    reason_code: reasonCode,
    confidence: 1,
  };
}

/** The operator-facing and model-facing text for a failure reason. */
function failureMessage(reasonCode, detail) {
  switch (reasonCode) {
    case FAILURE_REASON.REVIEWER_UNAVAILABLE:
      return "NotNativeReviewer could not reach its reviewer, so it denied this call.";
    case FAILURE_REASON.REVIEWER_TIMEOUT:
      return "NotNativeReviewer's reviewer did not answer in time, so it denied this call.";
    case FAILURE_REASON.REVIEWER_OUTPUT_MALFORMED:
      return "NotNativeReviewer's reviewer gave no readable decision twice, so it denied this call. Do the same work another way, or ask the user.";
    case FAILURE_REASON.REVIEWER_ROLE_VIOLATION:
      return "NotNativeReviewer's reviewer tried to call a tool, so it denied this call.";
    case FAILURE_REASON.REVIEWER_ANCHOR_INVALID:
      return "NotNativeReviewer's reviewer cited text that is not in the user's request, so it denied this call.";
    case FAILURE_REASON.PACKAGE_UNAVAILABLE:
      return "NotNativeReviewer has no record of the user's request in this session, so it denied this call. Do not retry this call. Ask the user a short clarifying question about what they want done, for example: 'In order to do this, could you specify what you need done?' Ask about the goal, not for permission, and do not ask for an approval, a keyword, or a retry.";
    case FAILURE_REASON.PRIMARY_UNAVAILABLE:
      return "NotNativeReviewer could not find the user's conversation behind this delegated session, so it denied this call. Do not retry this call. Tell the user which part you were asked to do, and ask them to restate the overall goal.";
    case FAILURE_REASON.WRITE_UNREAD:
      return "This call changes a file that the conversation has not read. Read it first, then retry.";
    case FAILURE_REASON.WRITE_STALE:
      return "The file changed after the conversation read it. Read it again, then retry.";
    case FAILURE_REASON.CATASTROPHIC_COMMAND:
      return `NotNativeReviewer blocked this command: it would destroy a system root (${detail || "catastrophic target"}). No model decided this. Ask the user to confirm, and never run it on their behalf.`;
    default:
      return detail ? `NotNativeReviewer denied this call (${reasonCode}).` : "NotNativeReviewer denied this call.";
  }
}
