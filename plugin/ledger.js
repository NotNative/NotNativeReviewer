/**
 * Ledger — the gate's own record of the file content that a session has seen.
 *
 * The invariant is the one in docs/how-it-works.md §6: a call that changes a file must
 * follow a read of that same file, and the file must not have changed since.
 *
 * The gate keeps this record itself. It does not ask the host, and it does not trust the
 * conversation, because a tool result in the conversation can be written by anything that
 * the model read. The record is a digest per canonical path:
 *
 *   - a `read` of an existing file records the digest of its content;
 *   - a `write` that creates a missing file records the digest of the text it wrote;
 *   - a later change of that file must present a digest that still matches.
 *
 * Two consequences are deliberate:
 *   - A file that the gate could not read has no entry, so a write of it denies. The gate
 *     says what it saw, and it saw nothing.
 *   - A call that names no file cannot be checked, so a file-changing call denies. A tool
 *     name is not a path.
 *
 * Imports `floor.js`, `files.js`, `observation.js` and `telemetry.js`, all siblings.
 */

import { readTargetPaths } from "./floor.js";
import { canonicalPath, digestText } from "./files.js";
import { WRITE_VERDICT } from "./observation.js";
import { STEP } from "./telemetry.js";

/** The failure codes this module reports. The caller maps them to a message. */
export const LEDGER_REASON = Object.freeze({
  UNREAD: "write_unread",
  STALE: "write_stale",
});

/**
 * Record what a safe read saw, before the call passes (§6).
 *
 * Only a `read` records content. `grep`, `glob` and `list` name a pattern, and an entry
 * that a later write could not match would deny a legitimate edit for no reason.
 */
export function recordReads(input, event) {
  if (!isFileReading(event && event.action)) return;
  for (const path of readTargetPaths(event)) {
    const key = canonicalPath(path);
    if (key === "") continue;
    const state = input.readFileDigest(path);
    // No readable content means no promise to keep. The file stays unrecorded, so a
    // later write of it denies as unread.
    if (!state || state.exists !== true || state.digest === null) continue;
    input.stores.observations.recordRead({
      sessionID: event.sessionID,
      canonicalPath: key,
      digest: state.digest,
    });
    input.telemetry.record(STEP.LEDGER_APPEND, {
      sessionID: event.sessionID,
      data: { check: "read", verdict: "recorded", pathLen: key.length },
    });
  }
}

/**
 * Check the read-before-write invariant for a call that changes a file (§6).
 *
 * @returns {{ denied: boolean, reason?: string }}
 */
export async function checkWriteInvariant(input, event) {
  const targetPaths = readTargetPaths(event);
  if (!isFileChanging(event)) return { denied: false };
  if (targetPaths.length === 0 || event.hasNamedResource === false) {
    input.telemetry.record(STEP.LEDGER_APPEND, {
      sessionID: event.sessionID,
      data: { check: "read_before_write", verdict: "unnamed_target" },
    });
    return { denied: true, reason: LEDGER_REASON.UNREAD };
  }

  for (const path of targetPaths) {
    const key = canonicalPath(path);
    if (key === "") continue;
    const state = await resolveFileState(input, path);
    const verdict = input.stores.observations.checkWrite({
      sessionID: event.sessionID,
      canonicalPath: key,
      targetExists: state.exists,
      currentDigest: state.digest,
    });
    input.telemetry.record(STEP.LEDGER_APPEND, {
      sessionID: event.sessionID,
      data: { check: "read_before_write", verdict: verdict.verdict, pathLen: key.length },
    });
    if (verdict.verdict === WRITE_VERDICT.UNREAD) return { denied: true, reason: LEDGER_REASON.UNREAD };
    if (verdict.verdict === WRITE_VERDICT.STALE) return { denied: true, reason: LEDGER_REASON.STALE };
    if (verdict.verdict === WRITE_VERDICT.CREATE) recordCreatedContent(input, event, key);
  }
  return { denied: false };
}

/**
 * Record the content that a create leaves behind, so the agent can edit its own new file.
 *
 * The gate knows the text only when the call carries it, as a `write` does. When the text
 * is absent the gate records nothing, and a later write of that file denies as unread.
 */
function recordCreatedContent(input, event, key) {
  const content = readWrittenContent(event);
  if (typeof content !== "string") return;
  input.stores.observations.recordCreate({
    sessionID: event.sessionID,
    canonicalPath: key,
    digest: digestText(content),
  });
}

/** The text that a write call will put in the file, when the call carries it. */
function readWrittenContent(event) {
  const metadata = event && event.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  return typeof metadata.content === "string" ? metadata.content : null;
}

/** Whether an action reads the content of a named file. */
function isFileReading(action) {
  return String(action || "").toLowerCase() === "read";
}

/**
 * Record the content that a call left on disk, after the call succeeded (§6).
 *
 * The gate reads the file again instead of trusting the arguments, because the arguments
 * say what the model intended and the file says what happened. This is what lets an agent
 * edit a file twice: after the first edit the recorded digest is the new content, so the
 * second edit matches and needs no read of its own.
 *
 * A create is covered by the same path. The write itself needs no read, and this entry is
 * what a later edit of the new file matches.
 *
 * @param {{ readFileDigest: (path: string) => object }} input
 * @param {object} event the tool result event
 * @param {string} path the file that the call changed
 * @returns {boolean} whether an entry was recorded
 */
export function recordWriteDigest(input, event, path) {
  const key = canonicalPath(path);
  if (key === "" || !event || !event.sessionID) return false;
  const state = input.readFileDigest(path);
  if (!state || state.exists !== true || state.digest === null) return false;
  input.stores.observations.recordRead({
    sessionID: event.sessionID,
    canonicalPath: key,
    digest: state.digest,
  });
  input.telemetry.record(STEP.LEDGER_APPEND, {
    sessionID: event.sessionID,
    data: { check: "write", verdict: "recorded", pathLen: key.length },
  });
  return true;
}

/** Whether a call changes file content. */
export function isFileChanging(event) {
  const action = String(event && event.action || "").toLowerCase();
  return action === "write" || action === "edit" || action === "patch" || action === "multiedit";
}

/** Ask the gate's own file layer for the state of one path. */
async function resolveFileState(input, path) {
  try {
    const state = await input.readFileDigest(path);
    return { exists: Boolean(state && state.exists), digest: state ? state.digest : null };
  } catch {
    return { exists: true, digest: null };
  }
}
