/**
 * Reviewer package — the conversation text for one session.
 *
 * The package holds what the user and the agent said, in conversation order. User records
 * carry authority. Agent records carry evidence. Tool calls and tool results are not part
 * of the package: the reviewer sees the conversation, and the call under review.
 *
 * Rules that this module enforces:
 *   - A user input appends a `user_authored` record. A question or page answer is a user
 *     input like any other.
 *   - Agent text appends a `model_utterance` record. It is evidence, never authority.
 *   - Records keep conversation order. A record can arrive after a later one (an assistant
 *     message is recorded by the next context hook), so insertion is by the time the host
 *     gave the message, not by the order the gate happened to see it.
 *   - Selection keeps the newest records under the caps, then presents them in order.
 *   - Writing is idempotent on message ID.
 *
 * Imports only `bytes.js`, a sibling module.
 */

import { byteLength, budgetText, trimToBytes } from "./bytes.js";

/** Trust classes (§5.2). Only the first two can authorise a call. */
export const TRUST = Object.freeze({
  USER_AUTHORED: "user_authored",
  USER_ASSENTED: "user_assented",
  SYNTHETIC: "synthetic",
  MODEL_UTTERANCE: "model_utterance",
});

/** Trust classes that can authorise a call (§7: anchor rules). */
export const AUTHORITY_CLASSES = Object.freeze(new Set([TRUST.USER_AUTHORED, TRUST.USER_ASSENTED]));

/** Caps (§6.3). The operator accepted these as proposals to tune (Q5). */
export const CAP = Object.freeze({
  RECORDS: 256,
  PACKAGE_ITEMS: 32,
  PACKAGE_PER_ITEM_BYTES: 4096,
  PACKAGE_TOTAL_BYTES: 16384,
});

/**
 * Holds the conversation package for one session.
 *
 * One instance per session. The gate keeps a map of these, keyed by sessionID.
 */
export class ReviewerPackageStore {
  constructor() {
    /** @type {Map<string, object>} */
    this._sessions = new Map();
  }

  /**
   * Record a user input: a prompt, a question answer, or a page answer.
   *
   * @param {{ sessionID: string, id: string, text: string, at?: number }} input
   * @returns {boolean} true when the record was added
   */
  recordUserInput(input) {
    return this._record({ ...input, trust: TRUST.USER_AUTHORED });
  }

  /**
   * Record agent or synthetic text. The caller supplies the trust class.
   *
   * @param {{ sessionID: string, id: string, text: string, trust: string, at?: number }} input
   * @returns {boolean} true when the record was added
   */
  recordText(input) {
    return this._record(input);
  }

  /**
   * Select records for the reviewer prompt, under the byte budget.
   * Newest are kept, then presented in conversation order.
   *
   * @param {{ sessionID: string }} request
   * @returns {{ items: Array<object>, latestUserID: string | null, metadata: object }}
   */
  selectForReview(request) {
    const state = this._sessions.get(request.sessionID);
    if (!state) {
      return { items: [], latestUserID: null, metadata: { total: 0, selected: 0, omitted: 0, bytes: 0, truncated: false } };
    }
    const selected = selectRecords(state.records);
    return { ...selected, latestUserID: readLatestUserID(selected.items) };
  }

  /** Forget a session when the host says it ended. */
  forget(sessionID) {
    return this._sessions.delete(sessionID);
  }

  /** Read-only summary for telemetry. Counts and trust composition only, no text. */
  summarise(sessionID) {
    const state = this._sessions.get(sessionID);
    if (!state) return { records: 0, bytes: 0, trusts: {} };
    const trusts = {};
    let bytes = 0;
    for (const record of state.records) {
      trusts[record.trust] = (trusts[record.trust] || 0) + 1;
      bytes += record.bytes;
    }
    return { records: state.records.length, bytes, trusts };
  }

  /** Add one record, in conversation order, and keep the package bounded. */
  _record(input) {
    if (!input.sessionID || !input.id) return false;
    const text = trimToBytes(String(input.text || ""), CAP.PACKAGE_PER_ITEM_BYTES);
    if (text.trim() === "") return false;

    const state = this._state(input.sessionID);
    if (state.seen.has(input.id)) return false;
    state.seen.add(input.id);
    state.seq += 1;

    state.records.push({
      id: String(input.id),
      trust: input.trust,
      text,
      at: Number.isFinite(input.at) ? input.at : Date.now(),
      seq: state.seq,
      bytes: byteLength(text),
    });
    // An assistant message is often recorded after the answer it precedes. Order by the
    // host's message time, with the append sequence as a stable tie-breaker.
    state.records.sort((a, b) => a.at - b.at || a.seq - b.seq);
    if (state.records.length > CAP.RECORDS) state.records.splice(0, state.records.length - CAP.RECORDS);
    return true;
  }

  /** The session state, created on first use. */
  _state(sessionID) {
    let state = this._sessions.get(sessionID);
    if (!state) {
      state = { seq: 0, records: [], seen: new Set() };
      this._sessions.set(sessionID, state);
    }
    return state;
  }
}

/**
 * Select records newest first, stopping at the caps, then reverse into conversation
 * order. The oldest records are dropped first, so the most recent text survives whole.
 */
function selectRecords(records) {
  const selected = [];
  let totalBytes = 0;
  let omitted = 0;

  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (selected.length >= CAP.PACKAGE_ITEMS) {
      omitted += 1;
      continue;
    }
    const remaining = CAP.PACKAGE_TOTAL_BYTES - totalBytes;
    if (remaining <= 0) {
      omitted += 1;
      continue;
    }
    const budgeted = budgetText(record.text, Math.min(CAP.PACKAGE_PER_ITEM_BYTES, remaining));
    if (budgeted.text === "") {
      omitted += 1;
      continue;
    }
    totalBytes += byteLength(budgeted.text);
    selected.push({
      id: record.id,
      trust: record.trust,
      text: budgeted.text,
      truncated: budgeted.truncated,
      at: record.at,
    });
  }

  selected.reverse();
  return {
    items: selected,
    metadata: {
      total: records.length,
      selected: selected.length,
      omitted,
      bytes: totalBytes,
      truncated: selected.some((item) => item.truncated),
    },
  };
}

/** The newest user record in the selected package, for the prompt's inline marker. */
function readLatestUserID(items) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (AUTHORITY_CLASSES.has(items[i].trust)) return items[i].id;
  }
  return null;
}

/**
 * The anchors that the reviewer may cite: records of class user_authored or
 * user_assented that are present in the selected package (§7).
 *
 * @param {Array<{id: string, trust: string}>} items
 * @returns {readonly string[]}
 */
export function readValidAnchors(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((i) => AUTHORITY_CLASSES.has(i.trust)).map((i) => i.id);
}
