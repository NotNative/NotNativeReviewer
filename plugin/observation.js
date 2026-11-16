/**
 * Observation lane — the gate's own record of what happened in a session.
 *
 * Two jobs:
 *   1. The read record for the read-before-write invariant
 *      (docs/how-it-works.md §6).
 *   2. The observation lane text for the reviewer: tool observations, classed
 *      `untrusted_tool`, which carry evidence and never authority (§6).
 *
 * The read record holds a content digest per canonical path. The gate computes the
 * digest at read time, and again at write time, and compares them (§3.1).
 *
 * Imports only `bytes.js`, a sibling module.
 */

import { byteLength, trimToBytes } from "./bytes.js";

/** Caps for the observation lane (§6.3). */
export const LANE_CAP = Object.freeze({
  ITEMS: 10,
  PER_ITEM_BYTES: 2048,
  TOTAL_BYTES: 12288,
});

/** The result of a read-before-write check. */
export const WRITE_VERDICT = Object.freeze({
  /** The path does not exist, so the call creates it. No read is required. */
  CREATE: "create",
  /** The session read the path, and the digest matches. Continue to alignment review. */
  MATCH: "match",
  /** The session never read the path, and the path exists. Deny. */
  UNREAD: "unread",
  /** The digest changed since the read. Deny. */
  STALE: "stale",
});

/**
 * Holds the observation state for one session.
 * One instance per session; the gate keeps a map keyed by sessionID.
 */
export class ObservationStore {
  constructor() {
    /** @type {Map<string, { reads: Map<string, object>, observations: object[] }>} */
    this._sessions = new Map();
  }

  /**
   * Record a read, with the digest of the content at read time.
   * The key is the canonical path (§6).
   *
   * A read that this gate did not see cannot be recorded, so a later write of that file
   * denies. That is the intended direction: the ledger holds what the gate observed.
   *
   * @param {{ sessionID: string, canonicalPath: string, digest: string, at?: string }} input
   */
  recordRead(input) {
    const state = this._state(input.sessionID);
    state.reads.set(input.canonicalPath, {
      digest: input.digest,
      at: input.at || new Date().toISOString(),
    });
  }

  /**
   * Record a create, so a later modify of the same file has a baseline (§6).
   *
   * A create leaves the file with known content: the text the gate saw the call write.
   * Recording that digest lets the agent edit its own new file, which it could not do if
   * the baseline were empty.
   *
   * @param {{ sessionID: string, canonicalPath: string, digest?: string }} input
   */
  recordCreate(input) {
    this.recordRead({
      sessionID: input.sessionID,
      canonicalPath: input.canonicalPath,
      // An unknown digest is a digest no content matches, so a later write still checks
      // the file and denies when the content differs from what this call left behind.
      digest: typeof input.digest === "string" ? input.digest : "",
    });
  }

  /** Whether the session holds a read record for the canonical path. */
  hasRead(sessionID, canonicalPath) {
    const state = this._sessions.get(sessionID);
    return Boolean(state && state.reads.has(canonicalPath));
  }

  /** The digest the session recorded at read time, or null. */
  readDigest(sessionID, canonicalPath) {
    const state = this._sessions.get(sessionID);
    const entry = state && state.reads.get(canonicalPath);
    return entry ? entry.digest : null;
  }

  /**
   * Check one target against the read record (§3.1).
   *
   * @param {{
   *   sessionID: string,
   *   canonicalPath: string,
   *   targetExists: boolean,
   *   currentDigest: string | null,
   * }} input
   * @returns {{ verdict: string, reason?: string }}
   */
  checkWrite(input) {
    if (!input.targetExists) return { verdict: WRITE_VERDICT.CREATE };
    const recorded = this.readDigest(input.sessionID, input.canonicalPath);
    if (recorded === null) return { verdict: WRITE_VERDICT.UNREAD, reason: "write_unread" };
    if (input.currentDigest === null) {
      // The file exists but the gate could not read it. Do not guess.
      return { verdict: WRITE_VERDICT.STALE, reason: "write_stale" };
    }
    if (recorded !== input.currentDigest) return { verdict: WRITE_VERDICT.STALE, reason: "write_stale" };
    return { verdict: WRITE_VERDICT.MATCH };
  }

  /**
   * Record a tool observation for the observation lane.
   * The text is a short summary that the gate builds; it never holds the whole output.
   *
   * @param {{ sessionID: string, id: string, text: string, targetPaths?: readonly string[] }} input
   */
  recordObservation(input) {
    const state = this._state(input.sessionID);
    state.observations.push({
      id: String(input.id),
      text: typeof input.text === "string" ? input.text : "",
      targetPaths: input.targetPaths || [],
      at: new Date().toISOString(),
    });
    if (state.observations.length > 64) state.observations.shift();
  }

  /**
   * Select observations that relate to the requested targets (§6.2).
   * Each selected item gets a fair share of the per-item cap, so one large item cannot
   * push the other items out.
   *
   * @param {{ sessionID: string, targetPaths?: readonly string[] }} request
   * @returns {{ items: Array<{id: string, text: string}>, metadata: object }}
   */
  selectObservations(request) {
    const state = this._sessions.get(request.sessionID);
    if (!state) return { items: [], metadata: { total: 0, selected: 0 } };
    const targets = request.targetPaths || [];
    const relevant = state.observations.filter((o) => targets.some((t) => o.text.includes(t) || o.targetPaths.includes(t)));
    const chosen = (relevant.length > 0 ? relevant : state.observations).slice(-LANE_CAP.ITEMS);
    const items = [];
    let totalBytes = 0;
    for (const observation of chosen) {
      const budget = Math.min(LANE_CAP.PER_ITEM_BYTES, Math.max(LANE_CAP.TOTAL_BYTES - totalBytes, 0));
      if (budget <= 0) break;
      const text = trimToBytes(observation.text, budget);
      totalBytes += byteLength(text);
      items.push({ id: observation.id, text });
    }
    return {
      items,
      metadata: { total: state.observations.length, selected: items.length, bytes: totalBytes },
    };
  }

  /** Counts only, for telemetry. */
  summarise(sessionID) {
    const state = this._sessions.get(sessionID);
    if (!state) return { reads: 0, observations: 0 };
    return { reads: state.reads.size, observations: state.observations.length };
  }

  _state(sessionID) {
    let state = this._sessions.get(sessionID);
    if (!state) {
      state = { reads: new Map(), observations: [] };
      this._sessions.set(sessionID, state);
    }
    return state;
  }
}

/**
 * Build a short observation text from a tool result.
 * The gate does not keep tool output in full: the summary names the target and the
 * result size, so the reviewer knows the tool ran without carrying the payload.
 *
 * @param {{ tool: string, targetPaths?: readonly string[], resultBytes?: number, ok?: boolean }} input
 */
export function summariseToolResult(input) {
  const targets = input.targetPaths && input.targetPaths.length > 0 ? input.targetPaths.join(", ") : "(no target)";
  const state = input.ok === false ? "failed" : "succeeded";
  const size = typeof input.resultBytes === "number" ? `, ${input.resultBytes} bytes of result` : "";
  return `${input.tool} ${state} on ${targets}${size}.`;
}


