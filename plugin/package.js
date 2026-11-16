/**
 * Reviewer package — the authority basis for a review epoch.
 *
 * The package holds the user input that starts the epoch and the text of preceding
 * turns, each tagged with a trust class (docs/how-it-works.md §5).
 *
 * Rules that this module enforces:
 *   - Any admitted user input starts a new review epoch (§5.1.3, D-022). The previous
 *     epoch's records become previous-epoch records and enter the window.
 *   - Selection fills newest first, in reference order (§5.1.2). The oldest records are
 *     truncated first, so the most recent text survives whole.
 *   - Truncation is reported in the package metadata (§5.1.2).
 *   - Writing is idempotent on message ID, because the prompt hook is not exactly-once
 *     (docs/how-it-works.md §4).
 *   - The turn-opening user input is never truncated (§6.4).
 *
 * Imports only `bytes.js`, a sibling module.
 */

import { byteLength, budgetText } from "./bytes.js";

/** Trust classes (§5.2). Only the first two can authorise a call. */
export const TRUST = Object.freeze({
  USER_AUTHORED: "user_authored",
  USER_ASSENTED: "user_assented",
  SYNTHETIC: "synthetic",
  MODEL_UTTERANCE: "model_utterance",
  UNTRUSTED_TOOL: "untrusted_tool",
});

/** Trust classes that can authorise a call (§7: anchor rules). */
export const AUTHORITY_CLASSES = Object.freeze(new Set([TRUST.USER_AUTHORED, TRUST.USER_ASSENTED]));

/** Caps (§6.3). The operator accepted these as proposals to tune (Q5). */
export const CAP = Object.freeze({
  PACKAGE_ITEMS: 32,
  PACKAGE_PER_ITEM_BYTES: 4096,
  PACKAGE_TOTAL_BYTES: 16384,
  PACKAGE_TURN_WINDOW: 8,
});

/**
 * Holds the reviewer package for one session.
 *
 * One instance per session. The gate keeps a map of these, keyed by sessionID.
 */
export class ReviewerPackageStore {
  constructor() {
    /** @type {Map<string, PackageState>} */
    this._sessions = new Map();
  }

  /**
   * Record an admitted user prompt and start a new review epoch.
   *
   * Idempotent on messageID: a repeat admission of the same message does not start a
   * second epoch and does not duplicate the record.
   *
   * @param {{ sessionID: string, messageID: string, text: string, delivery?: string }} input
   * @returns {{ epoch: number, locked: boolean, replaced: boolean }}
   */
  admitPrompt(input) {
    const state = this._state(input.sessionID);
    if (state.seenMessageIDs.has(input.messageID)) {
      return { epoch: state.epoch, locked: false, replaced: false };
    }
    state.seenMessageIDs.add(input.messageID);
    state.epoch += 1;
    state.lockedAt = null;

    // A newer user input supersedes the earlier one as the instruction in force. The
    // earlier inputs stay in the package as context, but only the newest still opens the
    // epoch, because that is the one whose intent governs the calls that follow it (§5.5).
    for (const record of state.records) {
      record.epoch = state.epoch - 1;
      record.isEpochOpening = false;
    }

    const record = makeRecord({
      id: input.messageID,
      trust: TRUST.USER_AUTHORED,
      text: typeof input.text === "string" ? input.text : "",
      turn: state.turnCount + 1,
    });
    record.isEpochOpening = true;
    state.records.push(record);
    state.turnCount += 1;
    state.currentEpoch = state.epoch;
    state.lockedAt = new Date().toISOString();
    return { epoch: state.epoch, locked: true, replaced: true };
  }

  /**
   * Record agent or synthetic text into the ledger. This text is evidence, never
   * authority (§5.2). The caller supplies the trust class.
   *
   * @param {{ sessionID: string, messageID: string, text: string, trust: string }} input
   */
  recordText(input) {
    const state = this._state(input.sessionID);
    if (state.seenMessageIDs.has(input.messageID)) return false;
    state.seenMessageIDs.add(input.messageID);
    state.records.push(
      makeRecord({
        id: input.messageID,
        trust: input.trust,
        text: typeof input.text === "string" ? input.text : "",
        turn: state.turnCount,
      }),
    );
    return true;
  }

  /**
   * Note that a user input refers to a specific model message, so that message becomes
   * user-assented (§5.1.3). The pair is the authority, not the model text alone.
   *
   * @param {{ sessionID: string, messageID: string }} input
   */
  markAssented(input) {
    const state = this._sessions.get(input.sessionID);
    if (!state) return false;
    const record = state.records.find((r) => r.id === input.messageID);
    if (!record) return false;
    if (record.trust === TRUST.MODEL_UTTERANCE) record.trust = TRUST.USER_ASSENTED;
    return true;
  }

  /** Whether a session holds a locked package for its current epoch. */
  hasLockedPackage(sessionID) {
    const state = this._sessions.get(sessionID);
    return Boolean(state && state.lockedAt !== null);
  }

  /** The current epoch number for a session, or 0. */
  readEpoch(sessionID) {
    const state = this._sessions.get(sessionID);
    return state ? state.epoch : 0;
  }

  /**
   * Select records for the reviewer prompt, under the byte budget.
   * Newest first, in reference order, stopping when the budget is spent (§5.1.2).
   *
   * @param {{ sessionID: string, targetPaths?: readonly string[] }} request
   * @returns {{ epoch: number, items: Array<{id: string, trust: string, text: string, truncated: boolean}>, current: object | null, metadata: object }}
   */
  selectForReview(request) {
    const state = this._sessions.get(request.sessionID);
    if (!state || state.lockedAt === null) {
      return { epoch: 0, items: [], current: null, metadata: { locked: false, total: 0, omitted: 0 } };
    }
    const selected = selectRecords(state, request.targetPaths || []);
    return { epoch: state.epoch, ...selected, current: readCurrentInstruction(state) };
  }

  /** Release a session's package at turn end (§5.4). */
  release(sessionID) {
    const state = this._sessions.get(sessionID);
    if (!state) return false;
    state.lockedAt = null;
    return true;
  }

  /** Read-only summary for telemetry. Counts and trust composition only, no text. */
  summarise(sessionID) {
    const state = this._sessions.get(sessionID);
    if (!state) return { epoch: 0, records: 0, bytes: 0, locked: false, trusts: {} };
    const trusts = {};
    let bytes = 0;
    for (const record of state.records) {
      trusts[record.trust] = (trusts[record.trust] || 0) + 1;
      bytes += byteLength(record.text);
    }
    return { epoch: state.epoch, records: state.records.length, bytes, locked: state.lockedAt !== null, trusts };
  }

  /** The session state, created on first use. */
  _state(sessionID) {
    let state = this._sessions.get(sessionID);
    if (!state) {
      state = { epoch: 0, currentEpoch: 0, turnCount: 0, lockedAt: null, records: [], seenMessageIDs: new Set() };
      this._sessions.set(sessionID, state);
    }
    return state;
  }
}

/** Build one package record. */
function makeRecord(input) {
  return {
    id: String(input.id),
    trust: input.trust,
    text: input.text,
    turn: input.turn,
    epoch: input.turn,
    isEpochOpening: false,
    bytes: byteLength(input.text),
  };
}

/**
 * Select records newest first, stopping at the caps. The epoch-opening user input is
 * kept even when the budget is spent, because it is the authority basis (§6.4).
 */
function selectRecords(state, targetPaths) {
  const ordered = orderRecords(state, targetPaths);
  const items = [];
  let totalBytes = 0;
  let omitted = 0;

  for (const record of ordered) {
    if (items.length >= CAP.PACKAGE_ITEMS) {
      omitted += 1;
      continue;
    }
    const remaining = CAP.PACKAGE_TOTAL_BYTES - totalBytes;
    if (remaining <= 0 && !record.isEpochOpening) {
      omitted += 1;
      continue;
    }
    const perItem = Math.min(CAP.PACKAGE_PER_ITEM_BYTES, Math.max(remaining, 0));
    // A record that is the epoch-opening input is never dropped, but it is capped.
    if (perItem <= 0 && !record.isEpochOpening) {
      omitted += 1;
      continue;
    }
    const budgeted = budgetText(record.text, perItem || CAP.PACKAGE_PER_ITEM_BYTES);
    totalBytes += byteLength(budgeted.text);
    items.push({ id: record.id, trust: record.trust, text: budgeted.text, truncated: budgeted.truncated, turn: record.turn });
  }

  return {
    items,
    metadata: {
      locked: true,
      total: ordered.length,
      selected: items.length,
      omitted,
      bytes: totalBytes,
      truncated: items.some((i) => i.truncated),
      windowTurns: CAP.PACKAGE_TURN_WINDOW,
    },
  };
}

/**
 * Order records for selection. Newest first. A record whose text names a requested
 * target path moves ahead of other records in the same turn, because it is the text
 * most likely to justify the call.
 *
 * The instruction in force goes first, whatever the path filter says. When the budget is
 * spent, the text that survives must be the text whose intent governs the call (§5.5).
 */
function orderRecords(state, targetPaths) {
  const windowFloor = Math.max(1, state.turnCount - CAP.PACKAGE_TURN_WINDOW + 1);
  const inWindow = state.records.filter((r) => r.turn >= windowFloor || r.isEpochOpening);
  const current = readCurrentInstruction(state);
  const isCurrent = (r) => Boolean(current && r.id === current.id);
  const referenced = inWindow.filter((r) => !isCurrent(r) && mentionsAny(r.text, targetPaths));
  const unreferenced = inWindow.filter((r) => !isCurrent(r) && !mentionsAny(r.text, targetPaths));
  const newestFirst = (a, b) => b.turn - a.turn;
  return [
    ...inWindow.filter(isCurrent),
    ...referenced.sort(newestFirst),
    ...unreferenced.sort(newestFirst),
  ];
}

/** Whether a text names any of the target paths. */
function mentionsAny(text, targetPaths) {
  if (!targetPaths || targetPaths.length === 0) return false;
  for (const p of targetPaths) {
    if (p && text.includes(p)) return true;
  }
  return false;
}

/**
 * The user instruction in force: the newest user-authored record, whatever its turn.
 *
 * A conversation drifts. A session can start as a comparison of two repositories and turn
 * into a code change, and the ask that governed the first calls no longer governs the
 * later ones. The newest user input is the one whose intent is in force, so the reviewer
 * is told which record that is.
 *
 * @returns {{ id: string, text: string } | null}
 */
function readCurrentInstruction(state) {
  for (let i = state.records.length - 1; i >= 0; i -= 1) {
    const record = state.records[i];
    if (AUTHORITY_CLASSES.has(record.trust)) {
      return { id: record.id, text: record.text, turn: record.turn };
    }
  }
  return null;
}

/**
 * The user records that a newer user input supersedes.
 *
 * The gate does not claim to know what the user meant. It only reports the order, so the
 * reviewer can judge a call against the instruction in force and treat an older ask as
 * history rather than as a standing order.
 *
 * @param {Array<{id: string, trust: string, turn: number}>} items the selected records
 * @param {number} currentTurn the turn of the instruction in force
 * @returns {readonly string[]}
 */
export function readSuperseded(items, currentTurn) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => AUTHORITY_CLASSES.has(item.trust) && item.turn < currentTurn)
    .map((item) => item.id);
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
