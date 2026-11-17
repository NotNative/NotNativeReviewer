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
  /**
   * The task text that another agent gave this session. It is authority inside the
   * delegated session, but it is subordinate to the primary conversation and can never
   * outrank the user (docs/how-it-works.md §5.2).
   */
  AGENT_DELEGATED: "agent_delegated",
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
 * Holds the conversation package for one session: the current package, and the snapshot
 * taken at the newest user input.
 *
 * Authority rule: only a user input creates a package.
 *   - A prompt or an answer creates the package when the session has none, and appends to
 *     it afterwards.
 *   - Every user input also refreshes `previous`, a snapshot of the package as it stood at
 *     that input. If the current package later loses its records, a review can fall back to
 *     the snapshot instead of denying a call it should have judged.
 *   - Agent text appends to the current package as evidence. It never creates a package and
 *     never moves the snapshot.
 *
 * The transcript keeps growing, so a bare "ok" still authorizes the proposal before it. A
 * snapshot is a shallow copy: a record's text and time never change after it is written.
 *
 * No host event forgets a package. The map is bounded by a number of sessions and evicts
 * the least recently used one when it is full, so a long-lived host cannot grow it without
 * limit.
 */
export class ReviewerPackageStore {
  /**
   * @param {{ maxSessions?: number }} [options]
   */
  constructor(options = {}) {
    /** @type {Map<string, { current: object | null, previous: object | null, used: number }>} */
    this._sessions = new Map();
    this._maxSessions = Number.isInteger(options.maxSessions) && options.maxSessions > 0 ? options.maxSessions : 64;
    this._clock = 0;
  }

  /**
   * Record a user input: a prompt, a question answer, or a page answer.
   *
   * @param {{ sessionID: string, id: string, text: string, at?: number }} input
   * @returns {{ recorded: boolean, snapshot: boolean }}
   */
  recordUserInput(input) {
    return this._recordUser(input);
  }

  /**
   * Record agent text. Appends only: a package is never created here.
   *
   * @param {{ sessionID: string, id: string, text: string, trust: string, at?: number }} input
   * @returns {boolean} true when the record was added
   */
  recordText(input) {
    if (!input || !input.sessionID || !input.id) return false;
    const state = this._sessions.get(input.sessionID);
    if (!state || !state.current) return false;
    const added = appendRecord(state.current, input);
    if (added) this._touch(input.sessionID, state);
    return added;
  }

  /**
   * Select records for the reviewer prompt, under the byte budget.
   *
   * The current package answers when it holds a user record. Otherwise the snapshot taken
   * at the newest user input answers, so a package that lost its records does not turn into
   * a denial. `source` names the one that answered, so telemetry can show a fallback.
   *
   * A delegated session also returns `primary`: the conversation that delegated it, held as
   * the authoritative layer. `previous` in this store is a fallback for the same session;
   * `primary` belongs to another, higher session and is never replaced by this one.
   *
   * @param {{ sessionID: string }} request
   * @returns {{ items: Array<object>, latestUserID: string | null, metadata: object,
   *   source: string, delegated: boolean, primary: object | null }}
   */
  selectForReview(request) {
    const state = request && this._sessions.get(request.sessionID);
    if (!state || !state.current) {
      return { items: [], latestUserID: null, metadata: emptyMetadata(), source: "none", delegated: false, primary: null };
    }
    const extra = { delegated: Boolean(state.parentID), primary: state.primary || null };
    const current = selectWithAuthority(state.current.records);
    if (current.authority) return { ...current.result, source: "current", ...extra };
    if (state.previous) {
      const previous = selectWithAuthority(state.previous.records);
      if (previous.authority) return { ...previous.result, source: "previous", ...extra };
    }
    return { ...current.result, source: "none", ...extra };
  }

  /**
   * Record that `childID` was delegated by `parentID`, and capture the primary layer.
   *
   * The capture happens once, at delegation time: the child is judged against the user's
   * intent as it stood when the work was handed over. A nested delegation keeps the deeper
   * user layer, so a chain of agents still traces back to the user.
   *
   * Any prompt text that arrived before the link was known is reclassified as delegated, so
   * a race in the event order cannot leave agent text holding user authority.
   *
   * @param {string} childID
   * @param {string} parentID
   * @returns {{ linked: boolean, inherited: boolean }}
   */
  linkParent(childID, parentID) {
    if (!childID || !parentID || childID === parentID) return { linked: false, inherited: false };
    let state = this._sessions.get(childID);
    if (!state) {
      state = { current: null, previous: null, used: 0, parentID: null, primary: null };
      this._sessions.set(childID, state);
    }
    if (state.parentID === parentID) return { linked: false, inherited: Boolean(state.primary) };
    state.parentID = parentID;
    state.primary = this._capturePrimary(parentID);
    reclassifyAsDelegated(state.current);
    reclassifyAsDelegated(state.previous);
    this._touch(childID, state);
    return { linked: true, inherited: Boolean(state.primary) };
  }

  /** Whether the session was delegated by another session. */
  isDelegated(sessionID) {
    const state = this._sessions.get(sessionID);
    return Boolean(state && state.parentID);
  }

  /** The primary layer for a delegated session, or null. */
  primaryFor(sessionID) {
    const state = this._sessions.get(sessionID);
    return (state && state.primary) || null;
  }

  /** Capture the authoritative conversation of the parent session. */
  _capturePrimary(parentID) {
    const parent = this._sessions.get(parentID);
    if (!parent) return null;
    // A nested delegation inherits the user layer, not the middle agent's task text.
    if (parent.primary) return cloneSelection(parent.primary);
    if (!parent.current) return null;
    const selected = selectWithAuthority(parent.current.records);
    if (!selected.authority) return null;
    return {
      items: selected.result.items.map((item) => ({ ...item })),
      latestUserID: selected.result.latestUserID,
      anchors: readValidAnchors(selected.result.items),
    };
  }

  /**
   * Forget a session.
   *
   * Only an explicit operator action or a test calls this. The host event stream never
   * does, because a lifecycle event that arrives at the wrong moment must not delete the
   * evidence behind a live call.
   */
  forget(sessionID) {
    return this._sessions.delete(sessionID);
  }

  /** Read-only summary for telemetry. Counts and trust composition only, no text. */
  summarise(sessionID) {
    const state = this._sessions.get(sessionID);
    if (!state || !state.current) {
      return {
        records: 0,
        bytes: 0,
        trusts: {},
        previous: Boolean(state && state.previous),
        parent: Boolean(state && state.parentID),
        primary: Boolean(state && state.primary),
      };
    }
    const trusts = {};
    let bytes = 0;
    for (const record of state.current.records) {
      trusts[record.trust] = (trusts[record.trust] || 0) + 1;
      bytes += record.bytes;
    }
    return {
      records: state.current.records.length,
      bytes,
      trusts,
      previous: Boolean(state.previous),
      parent: Boolean(state.parentID),
      primary: Boolean(state.primary),
    };
  }

  /**
   * The records that state persistence writes (§5.6).
   *
   * Only user and delegated-task text is exported. Agent text is evidence, and the gate sees
   * it again as the session continues; authority is what a reload would otherwise lose.
   *
   * @param {number} [perSession] newest records to keep for one session
   * @returns {Array<{ id: string, parent: string | null, users: Array<object> }>}
   */
  exportForState(perSession = 32) {
    const sessions = [];
    for (const [sessionID, state] of this._sessions) {
      const records = (state.current ? state.current.records : [])
        .filter((record) => record.trust === TRUST.USER_AUTHORED || record.trust === TRUST.AGENT_DELEGATED)
        .slice(-perSession)
        .map((record) => ({ id: record.id, text: record.text, at: record.at }));
      if (records.length === 0) continue;
      sessions.push({ id: sessionID, parent: state.parentID || null, users: records });
    }
    return sessions;
  }

  /** Add one user record, and refresh the snapshot a review can fall back to. */
  _recordUser(input) {
    if (!input || !input.sessionID || !input.id) return { recorded: false, snapshot: false };
    const text = trimToBytes(String(input.text || ""), CAP.PACKAGE_PER_ITEM_BYTES);
    if (text.trim() === "") return { recorded: false, snapshot: false };

    let state = this._sessions.get(input.sessionID);
    if (!state) {
      state = { current: null, previous: null, used: 0 };
      this._sessions.set(input.sessionID, state);
    }
    // A repeated input is the same input. It must not duplicate the record.
    if (state.current && state.current.seen.has(input.id)) return { recorded: false, snapshot: false };

    if (!state.current) state.current = newPackage();

    // Text from a delegated session is the other agent's task, not the user's instruction.
    const trust = state.parentID ? TRUST.AGENT_DELEGATED : TRUST.USER_AUTHORED;
    const added = appendRecord(state.current, { ...input, text, trust });
    if (!added) return { recorded: false, snapshot: false };
    // The snapshot is the package as it stands at this input: it keeps the newest authority
    // and the conversation before it, so a fallback is still a review of real evidence.
    state.previous = clonePackage(state.current);
    this._touch(input.sessionID, state);
    return { recorded: true, snapshot: true };
  }

  /** Mark a session as most recently used, and keep the map bounded. */
  _touch(sessionID, state) {
    this._clock += 1;
    state.used = this._clock;
    // Re-insert, so iteration order stays least-recently-used first.
    this._sessions.delete(sessionID);
    this._sessions.set(sessionID, state);
    while (this._sessions.size > this._maxSessions) {
      const oldest = this._sessions.keys().next();
      if (oldest.done) break;
      this._sessions.delete(oldest.value);
    }
  }
}

/** An empty package. */
function newPackage() {
  return { seq: 0, records: [], seen: new Set() };
}

/**
 * Copy a package's list and id set. The records themselves are never mutated after they are
 * written, so the copy shares them and costs one array and one set.
 */
function clonePackage(pkg) {
  return { seq: pkg.seq, records: pkg.records.slice(), seen: new Set(pkg.seen) };
}

/** Reclassify a package's own prompt records as delegated, when the link arrives late. */
function reclassifyAsDelegated(pkg) {
  if (!pkg) return;
  pkg.records = pkg.records.map((record) =>
    record.trust === TRUST.USER_AUTHORED ? { ...record, trust: TRUST.AGENT_DELEGATED } : record,
  );
}

/** Copy a captured primary selection, so neither session can mutate the other's copy. */
function cloneSelection(selection) {
  return {
    items: selection.items.map((item) => ({ ...item })),
    latestUserID: selection.latestUserID,
    anchors: selection.anchors.slice(),
  };
}

/** Append one record to a package, in conversation order, and keep it bounded. */
function appendRecord(pkg, input) {
  if (!input || !input.id) return false;
  const text = trimToBytes(String(input.text || ""), CAP.PACKAGE_PER_ITEM_BYTES);
  if (text.trim() === "") return false;
  if (pkg.seen.has(input.id)) return false;
  pkg.seen.add(input.id);
  pkg.seq += 1;
  pkg.records.push({
    id: String(input.id),
    trust: input.trust,
    text,
    at: Number.isFinite(input.at) ? input.at : Date.now(),
    seq: pkg.seq,
    bytes: byteLength(text),
  });
  // An assistant message is often recorded after the answer it precedes. Order by the
  // host's message time, with the append sequence as a stable tie-breaker.
  pkg.records.sort((a, b) => a.at - b.at || a.seq - b.seq);
  if (pkg.records.length > CAP.RECORDS) pkg.records.splice(0, pkg.records.length - CAP.RECORDS);
  return true;
}

/** The metadata of a package that holds nothing. */
function emptyMetadata() {
  return { total: 0, selected: 0, omitted: 0, bytes: 0, truncated: false };
}

/**
 * Select one package, and guarantee that the newest user record is in the selection.
 *
 * Without the guarantee, a long agentic turn can push the user's request out of the newest
 * window and leave the reviewer judging a call with no stated authority. The guarantee is
 * the difference between a rare false deny and a reliable review.
 */
function selectWithAuthority(records) {
  const selected = selectRecords(records);
  let items = selected.items;
  if (readValidAnchors(items).length === 0) {
    const newest = newestAuthority(records);
    if (newest) {
      const budgeted = budgetText(newest.text, CAP.PACKAGE_PER_ITEM_BYTES);
      if (budgeted.text !== "") {
        items = withAuthorityItem(items, {
          id: newest.id,
          trust: newest.trust,
          text: budgeted.text,
          truncated: budgeted.truncated,
          at: newest.at,
        });
      }
    }
  }
  const latestUserID = readLatestUserID(items);
  return {
    authority: latestUserID !== null,
    result: {
      items,
      latestUserID,
      metadata: { ...selected.metadata, selected: items.length },
    },
  };
}

/** The newest authority record in a package, or null. */
function newestAuthority(records) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if (AUTHORITY_CLASSES.has(records[i].trust)) return records[i];
  }
  return null;
}

/** Put the authority record at the head of the selection and keep the caps. */
function withAuthorityItem(items, authority) {
  const next = [authority, ...items];
  while (next.length > CAP.PACKAGE_ITEMS) next.splice(1, 1);
  let bytes = 0;
  for (const item of next) bytes += byteLength(item.text);
  while (bytes > CAP.PACKAGE_TOTAL_BYTES && next.length > 1) {
    const dropped = next.splice(1, 1)[0];
    bytes -= byteLength(dropped.text);
  }
  return next;
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
