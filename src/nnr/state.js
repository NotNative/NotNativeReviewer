/**
 * State across a reload — the package and the read ledger on disk (docs/how-it-works.md §5.6).
 *
 * An install or a restart unloads the plugin, and the in-memory package and ledger go with
 * it. For a session the user is watching that is harmless: the next message re-anchors it.
 * For an unattended run it is not, because the gate's own test cycle installs the plugin
 * again, and the second install would deny for want of a conversation.
 *
 * So the gate writes each session's user records, its parent link, and the read ledger to one
 * file next to its own modules, and reads it back at setup. Four rules keep that from
 * becoming a master key:
 *
 *   1. Only user records are written. Agent text is evidence and the gate will see it again;
 *      authority is the thing a reload would otherwise lose.
 *   2. The file is read once, at setup. Nothing in the event stream can restore it, so a
 *      running session cannot conjure authority by asking for it.
 *   3. A session restores until the user speaks again, across any number of reloads, and
 *      each new input replaces the record. There is no clock on authority; an operator who
 *      wants one can set `NNR_STATE_TTL_MINUTES`.
 *   4. A defect restores nothing. A truncated write, an unknown version, a record with no
 *      time: fail closed, then carry on as though the file were absent.
 *
 * No imports.
 */

/** The file name, next to the plugin modules, beside the audit log. */
export const STATE_FILE = "notnativereviewer-state.json";

/** The format version. A file with any other version is ignored. */
export const STATE_VERSION = 1;

/**
 * How long a restored package lives, if a settings file names a minute value.
 *
 * The rule is no clock: authority persists until the user speaks again. A number here is a
 * deliberate override by an operator who wants a stale conversation to stop counting
 * sooner than the next input would. The shipped file leaves it out.
 */
export const DEFAULT_TTL_MINUTES = 0;

/** The most one state file may hold. Older sessions are dropped to stay under it. */
const MAX_STATE_BYTES = 262144;

/** Per-session caps, so one long conversation cannot crowd out the others. */
const MAX_SESSIONS = 64;
const MAX_USERS_PER_SESSION = 32;
const MAX_READS_PER_SESSION = 256;

/**
 * The newest record may sit this far ahead of this process's clock and still restore.
 *
 * A timestamp is a host time, and two processes can disagree about the clock. An hour ahead
 * is a disagreement; a day ahead is not a clock the gate trusts.
 */
const CLOCK_SKEW_MS = 60 * 60 * 1000;

/**
 * The state file for one plugin directory.
 *
 * The gate constructs it at setup, restores into the stores, and saves after each change.
 */
export class StateFile {
  /**
   * @param {{
   *   directory: string,
   *   ttlMs: number,
   *   layer: { readText: (path: string) => string },
   *   writer: ((path: string, text: string) => void) | null,
   *   now?: () => number,
   *   onFailure?: (reason: string) => void,
   * }} options
   */
  constructor(options) {
    const settings = options || {};
    this._directory = String(settings.directory || ".");
    // `null` means no clock: persist until the user speaks again. `0` turns it off.
    this._ttlMs = Number.isFinite(settings.ttlMs) && settings.ttlMs >= 0 ? settings.ttlMs : null;
    this._layer = settings.layer || null;
    this._writer = typeof settings.writer === "function" ? settings.writer : null;
    this._now = typeof settings.now === "function" ? settings.now : () => Date.now();
    this._onFailure = typeof settings.onFailure === "function" ? settings.onFailure : null;
  }

  /** Whether persistence is on at all. No clock is on; `0` minutes is off. */
  get enabled() {
    return this._ttlMs !== 0 && this._writer !== null;
  }

  /** Whether a session's newest record is older than an explicit TTL would allow. */
  _isExpired(session, now) {
    const newest = newestTime(session.users);
    if (newest <= 0) return true;
    if (newest - now > CLOCK_SKEW_MS) return true;
    if (this._ttlMs === null) return false;
    return now - newest > this._ttlMs;
  }

  /**
   * Replay a previous run's user records, parent links, and read ledger into the stores.
   *
   * @param {{ packages: object, observations: object }} stores
   * @returns {{ ok: boolean, reason: string, sessions: number, reads: number, links: number,
   *   expired: number, ageMinutes: number }}
   */
  restoreInto(stores) {
    if (this._ttlMs === 0) return summary(false, "disabled");
    const parsed = this._readState();
    if (!parsed.ok) return summary(false, parsed.reason);

    const now = this._now();
    const fresh = [];
    let expired = 0;
    for (const session of parsed.state.sessions) {
      if (this._isExpired(session, now)) {
        expired += 1;
        continue;
      }
      fresh.push({ ...session, newest: newestTime(session.users) });
    }
    fresh.sort((a, b) => b.newest - a.newest);
    const kept = fresh.slice(0, MAX_SESSIONS);

    for (const session of kept) {
      for (const record of session.users) {
        stores.packages.recordUserInput({ sessionID: session.id, id: record.id, text: record.text, at: record.at });
      }
    }
    let links = 0;
    for (const session of kept) {
      // A child's own records were replayed as user text; the link reclassifies them as the
      // delegated task and captures the primary layer, exactly as a live delegation does.
      if (session.parent && stores.packages.linkParent(session.id, session.parent).linked) links += 1;
    }
    const ids = new Set(kept.map((session) => session.id));
    let reads = 0;
    for (const read of parsed.state.reads) {
      if (!ids.has(read.session)) continue;
      stores.observations.recordRead({
        sessionID: read.session,
        canonicalPath: read.path,
        digest: read.digest,
        at: read.at,
      });
      reads += 1;
    }
    const newest = kept.length > 0 ? kept[0].newest : 0;
    return {
      ...summary(true, "restored"),
      sessions: kept.length,
      reads,
      links,
      expired,
      ageMinutes: newest > 0 ? Math.max(0, Math.round((now - newest) / 60000)) : 0,
    };
  }

  /**
   * Write the current stores to the state file.
   *
   * @param {{ packages: object, observations: object }} stores
   * @returns {boolean} whether anything was written
   */
  save(stores) {
    if (!this.enabled) return false;
    const now = this._now();
    const exported = stores.packages.exportForState(MAX_USERS_PER_SESSION);
    const sessions = keepRestorable(exported, (session) => !this._isExpired(session, now));
    if (sessions.length === 0) return false;
    const ids = new Set(sessions.map((session) => session.id));
    const reads = stores.observations.exportForState(MAX_READS_PER_SESSION).filter((read) => ids.has(read.session));
    const budgeted = trimToBudget(sessions, reads);
    const text = JSON.stringify({ version: STATE_VERSION, writtenAt: now, sessions: budgeted.sessions, reads: budgeted.reads });
    try {
      this._writer(joinPath(this._directory, STATE_FILE), text);
      return true;
    } catch (error) {
      if (this._onFailure) this._onFailure(error && error.message ? String(error.message) : "write_failed");
      return false;
    }
  }

  /** Read and validate the state file. */
  _readState() {
    if (!this._layer || typeof this._layer.readText !== "function") return { ok: false, reason: "no_reader" };
    let text = "";
    try {
      text = this._layer.readText(joinPath(this._directory, STATE_FILE));
    } catch {
      return { ok: false, reason: "absent" };
    }
    const state = parseState(text);
    if (!state) {
      // The file layer answers an unreadable path with an empty string, so a state
      // file that is absent and one that is empty look the same here. Both are
      // "no state yet": fail closed with no records, not a corruption alarm.
      return { ok: false, reason: text === "" ? "absent" : "corrupt" };
    }
    return { ok: true, reason: "read", state };
  }
}

/** An empty restore summary. */
function summary(ok, reason) {
  return { ok, reason, sessions: 0, reads: 0, links: 0, expired: 0, ageMinutes: 0 };
}

/** Parse a state file, or return null when any part of it is not trusted. */
function parseState(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (value.version !== STATE_VERSION) return null;
  if (!Number.isFinite(value.writtenAt)) return null;
  if (!Array.isArray(value.sessions) || !Array.isArray(value.reads)) return null;

  const sessions = [];
  for (const raw of value.sessions) {
    const session = parseSession(raw);
    if (session) sessions.push(session);
  }
  const reads = [];
  for (const raw of value.reads) {
    const read = parseRead(raw);
    if (read) reads.push(read);
  }
  return { writtenAt: value.writtenAt, sessions, reads };
}

/** One session, or null when it holds nothing usable. */
function parseSession(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || raw.id === "") return null;
  if (!Array.isArray(raw.users)) return null;
  const users = [];
  for (const record of raw.users) {
    if (!record || typeof record !== "object") continue;
    if (typeof record.id !== "string" || record.id === "") continue;
    if (typeof record.text !== "string" || record.text.trim() === "") continue;
    if (!Number.isFinite(record.at)) continue;
    users.push({ id: record.id, text: record.text, at: record.at });
  }
  if (users.length === 0) return null;
  const parent = typeof raw.parent === "string" && raw.parent !== "" ? raw.parent : null;
  return { id: raw.id, parent, users };
}

/** One read entry, or null when it is incomplete. */
function parseRead(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.session !== "string" || raw.session === "") return null;
  if (typeof raw.path !== "string" || raw.path === "") return null;
  if (typeof raw.digest !== "string") return null;
  return { session: raw.session, path: raw.path, digest: raw.digest, at: typeof raw.at === "string" ? raw.at : undefined };
}

/** The newest timestamp among a session's user records. */
function newestTime(users) {
  let newest = 0;
  for (const record of users) {
    if (record.at > newest) newest = record.at;
  }
  return newest;
}

/**
 * Keep the sessions that a later setup could restore, newest first.
 *
 * The same rule the restore applies, so a save never writes a record that could not come
 * back: a file that outlives its authority is a file that restores nothing.
 */
function keepRestorable(sessions, isFresh) {
  const fresh = [];
  for (const session of sessions) {
    if (!isFresh(session)) continue;
    fresh.push({ ...session, newest: newestTime(session.users) });
  }
  fresh.sort((a, b) => b.newest - a.newest);
  return fresh
    .slice(0, MAX_SESSIONS)
    .map((session) => ({ id: session.id, parent: session.parent, users: session.users }));
}

/** Keep the state file under its byte cap by dropping the oldest sessions. */
function trimToBudget(sessions, reads) {
  let kept = sessions;
  for (;;) {
    const ids = new Set(kept.map((session) => session.id));
    const keptReads = reads.filter((read) => ids.has(read.session));
    const text = JSON.stringify({ version: STATE_VERSION, writtenAt: 1, sessions: kept, reads: keptReads });
    if (text.length <= MAX_STATE_BYTES - 64 || kept.length <= 1) {
      return { sessions: kept, reads: keptReads };
    }
    kept = kept.slice(0, kept.length - 1);
  }
}

/** Join a directory and a file name with the separator that the directory uses. */
function joinPath(directory, name) {
  const base = String(directory || ".");
  const separator = base.includes("\\") ? "\\" : "/";
  return base.endsWith(separator) ? `${base}${name}` : `${base}${separator}${name}`;
}
