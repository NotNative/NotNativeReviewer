/**
 * Question answers — append the user's answer to the reviewer package.
 *
 * Two paths reach the gate:
 *   - OpenCode's question tool emits `question.replied` and `question.v2.replied`.
 *   - OpenChamber's `render.page` with `awaitAnswer` returns the answer as a tool result,
 *     because OpenCode never sees that wait.
 *
 * Both carry the user's own words, so both append as `user_authored` in conversation
 * order. A render answer is accepted only from the host's `openchamber_render` tool, and
 * only when the call says it waited.
 *
 * Imports only sibling modules.
 */

import { byteLength, trimToBytes } from "./bytes.js";
import { digest, STEP } from "./telemetry.js";

/** A question or page answer is a choice, not a document. */
const MAX_ANSWER_BYTES = 2048;

/**
 * Append an answer from a `question.replied` event.
 *
 * @param {{ telemetry: object, stores: object }} deps
 * @param {object} event the host event
 * @returns {boolean} true when an answer was appended
 */
export function recordQuestionReply(deps, event) {
  if (!isQuestionReply(event)) return false;
  const payload = readPayload(event);
  const sessionID = payload.sessionID || (event && event.sessionID);
  if (!sessionID) return false;
  const answers = readQuestionText(payload.answers);
  if (answers === "") return false;
  const requestID = payload.requestID ? String(payload.requestID) : digest(answers);
  const text = `The user answered a question: ${answers}`;
  return appendAnswer(deps, { sessionID, id: `question:${requestID}`, text, source: "question" });
}

/**
 * Append an answer from an `openchamber_render` tool result.
 *
 * The host returns the answer inside the tool result. The call must be `render.page` with
 * `awaitAnswer` set, and the answer must say that the user answered. Any other result is
 * evidence, not authority, and is not appended.
 *
 * @param {{ telemetry: object, stores: object }} deps
 * @param {object} event the `tool.execute.after` event
 * @returns {boolean} true when an answer was appended
 */
export function recordRenderAnswer(deps, event) {
  if (!event || String(event.tool || "").toLowerCase() !== "openchamber_render") return false;
  if (!isWaitingRender(readValue(event.input))) return false;
  const answer = findAnswer(readValue(event.result), 0);
  if (!answer) return false;
  const summary = typeof answer.summary === "string" ? answer.summary.trim() : "";
  if (summary === "") return false;
  const note = readNote(answer.data);
  const text = `The user answered on a page: ${summary}${note ? `\nConditions: ${note}` : ""}`;
  const callID = event.callID || event.id;
  const id = callID ? `render:${callID}` : `render:${digest(text)}`;
  return appendAnswer(deps, { sessionID: event.sessionID, id, text, source: "render" });
}

/** Whether the event is a question reply. */
function isQuestionReply(event) {
  const type = String((event && event.type) || "");
  return type === "question.replied" || type === "question.v2.replied";
}

/** The event's payload, whichever shape the host uses. */
function readPayload(event) {
  if (event && event.properties && typeof event.properties === "object") return event.properties;
  if (event && event.data && typeof event.data === "object") return event.data;
  return {};
}

/** Turn the per-question answer lists into one line of the user's choices. */
function readQuestionText(answers) {
  if (!Array.isArray(answers)) return "";
  const parts = [];
  for (const answer of answers) {
    const labels = readLabels(answer);
    if (labels !== "") parts.push(labels);
  }
  return parts.join("; ");
}

/** One answer: a selected label, or a list of selected labels. */
function readLabels(answer) {
  if (typeof answer === "string") return answer.trim();
  if (!Array.isArray(answer)) return "";
  return answer
    .filter((label) => typeof label === "string" && label.trim() !== "")
    .map((label) => label.trim())
    .join(", ");
}

/** Parse a JSON string, or return the value unchanged. */
function readValue(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Whether a render call waited for the user's answer. */
function isWaitingRender(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const parameters = input.parameters && typeof input.parameters === "object" ? input.parameters : {};
  const action = String(input.action || parameters.action || "");
  if (action !== "render.page") return false;
  return input.awaitAnswer === true || parameters.awaitAnswer === true;
}

/**
 * Find the answer in a tool result.
 *
 * The host can hand over the result as the envelope, as a content string, or as metadata.
 * The search is bounded and looks only at the shapes the render tool produces.
 */
function findAnswer(value, depth) {
  if (!value || typeof value !== "object" || depth > 3) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAnswer(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value.ok === false) return null;
  if (isAnswer(value)) return value;
  if (isAnswer(value.answer)) return value.answer;
  const meta = value.metadata && value.metadata.openchamber;
  if (meta && isAnswer(meta.answer)) return meta.answer;
  if (value.data && typeof value.data === "object") {
    if (isAnswer(value.data.answer)) return value.data.answer;
    if (isAnswer(value.data)) return value.data;
  }
  for (const key of ["output", "content", "result", "text"]) {
    const nested = readValue(value[key]);
    if (!nested || typeof nested !== "object") continue;
    const found = findAnswer(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Whether a value is the render tool's answer object. */
function isAnswer(value) {
  return Boolean(value && typeof value === "object" && value.answered === true && typeof value.summary === "string");
}

/** The user's note from the page, when one was written. */
function readNote(data) {
  if (!data || typeof data !== "object") return "";
  return typeof data.note === "string" ? data.note.trim() : "";
}

/** Append the answer and record that the package grew. */
function appendAnswer(deps, input) {
  const packages = deps.stores && deps.stores.packages;
  if (!packages || typeof packages.recordUserInput !== "function") return false;
  const text = trimToBytes(input.text, MAX_ANSWER_BYTES);
  if (text.trim() === "") return false;
  // An answer appends to the request that prompted it. It creates a package only when the
  // session has none, and it moves the fallback snapshot like any other user input.
  const appended = packages.recordUserInput({ sessionID: input.sessionID, id: input.id, text });
  if (!appended.recorded) return false;
  deps.telemetry.record(STEP.PACKAGE_UPDATED, {
    sessionID: input.sessionID,
    data: { source: input.source, bytes: byteLength(text), ...packages.summarise(input.sessionID) },
  });
  return true;
}
