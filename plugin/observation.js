/**
 * Read record — the gate's own record of the file content a session has seen.
 *
 * The read record holds a content digest per canonical path for the read-before-write
 * invariant (docs/how-it-works.md §6). The gate computes the digest at read time, and
 * again at write time, and compares them (§3.1).
 *
 * Tool calls and results are not kept here. They are not part of the conversation the
 * reviewer reads.
 *
 * No imports.
 */

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
 * Holds the read record for one session.
 * One instance per session; the gate keeps a map keyed by sessionID.
 */
export class ObservationStore {
  constructor() {
    /** @type {Map<string, { reads: Map<string, object> }>} */
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

  /** Forget a session when the host says it ended. */
  forget(sessionID) {
    return this._sessions.delete(sessionID);
  }

  /** Counts only, for telemetry. */
  summarise(sessionID) {
    const state = this._sessions.get(sessionID);
    if (!state) return { reads: 0 };
    return { reads: state.reads.size };
  }

  _state(sessionID) {
    let state = this._sessions.get(sessionID);
    if (!state) {
      state = { reads: new Map() };
      this._sessions.set(sessionID, state);
    }
    return state;
  }
}


