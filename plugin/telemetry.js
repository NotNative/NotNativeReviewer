/**
 * Telemetry — local, append-only step log.
 *
 * Purpose: the operator can audit and trace what the gate did. The log records steps,
 * decisions, reasons, and timings. It never records content: no prompt text, no file
 * bytes, no tool arguments, no model output. A field that would carry content is
 * replaced by a digest or a count.
 *
 * Format: one JSON object per line (JSONL). Each record has `seq`, `ts`, `sessionID`
 * (or a digest of it), `step`, `ok`, `data`. `data` values are numbers, booleans,
 * short enum strings, digests, and counts only.
 *
 * Writing never throws. A telemetry failure must not change a permission decision.
 *
 * No imports: this module must load in an OpenCode discovery directory where no
 * node_modules exists (docs/coding-discipline.md §3).
 */

/**
 * FNV-1a 32-bit. Used to make a stable, short fingerprint of text without keeping it.
 * @param {string} text
 * @returns {string} 8 lowercase hex characters
 */
export function digest(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The steps that the log recognises. A step outside this list is a defect. */
export const STEP = Object.freeze({
  SETUP: "setup",
  HOOK_REGISTERED: "hook.registered",
  PROMPT_ADMITTED: "prompt.admitted",
  PACKAGE_UPDATED: "package.updated",
  PACKAGE_SNAPSHOT: "package.snapshot",
  PACKAGE_FALLBACK: "package.fallback",
  DELEGATION_OBSERVED: "delegation.observed",
  CONTEXT_OBSERVED: "context.observed",
  EVENT_OBSERVED: "event.observed",
  EVALUATE_START: "evaluate.start",
  FLOOR_CLASSIFIED: "floor.classified",
  PROJECTION_BUILT: "projection.built",
  REVIEWER_CALLED: "reviewer.called",
  REVIEWER_ANSWERED: "reviewer.answered",
  DECISION_VALIDATED: "decision.validated",
  DECISION_REPAIRED: "decision.repaired",
  DECISION_APPLIED: "decision.applied",
  EVALUATE_END: "evaluate.end",
  FAIL_CLOSED: "fail.closed",
  LEDGER_APPEND: "ledger.append",
  UNGOVERNED: "ungoverned",
});

/**
 * A telemetry sink.
 *
 * The caller supplies `write`, because the plugin must not import a filesystem module.
 * In OpenCode, the plugin can use `ctx.storage` or a `Bun` global. When neither is
 * available, the sink buffers in memory and the gate reports that the log is memory-only.
 */
export class Telemetry {
  /**
   * @param {{ write?: (line: string) => void, sessionDigest?: (id: string) => string }} options
   */
  constructor(options = {}) {
    /** @type {(line: string) => void | undefined} */
    this._write = options.write;
    this._sessionDigest = options.sessionDigest || ((id) => digest(id));
    this._seq = 0;
    this._buffered = [];
    this._dropped = 0;
    this._writeFailures = 0;
    /** @type {boolean} */
    this.degraded = false;
  }

  /**
   * Record one step.
   * @param {string} step one of STEP
   * @param {{ sessionID?: string, ok?: boolean, data?: Record<string, unknown> }} detail
   */
  record(step, detail = {}) {
    if (!Object.values(STEP).includes(step)) {
      // A step outside the vocabulary is a programming defect. Record it, do not throw.
      step = STEP.UNGOVERNED;
    }
    const rec = {
      seq: (this._seq += 1),
      ts: new Date().toISOString(),
      step,
      ok: detail.ok !== false,
      v: 1,
    };
    if (detail.sessionID) rec.s = this._sessionDigest(detail.sessionID);
    if (detail.data) rec.data = sanitise(detail.data);

    const line = safeStringify(rec);
    if (this._write) {
      try {
        this._write(line);
        return rec;
      } catch {
        this._writeFailures += 1;
        this.degraded = true;
      }
    }
    // No sink, or the sink failed. Keep the record in memory, bounded.
    this._buffered.push(line);
    if (this._buffered.length > 512) {
      this._buffered.shift();
      this._dropped += 1;
      this.degraded = true;
    }
    return rec;
  }

  /** A summary for the status surface. Counts only. */
  status() {
    return {
      records: this._seq,
      buffered: this._buffered.length,
      dropped: this._dropped,
      writeFailures: this._writeFailures,
      degraded: this.degraded,
    };
  }

  /** The buffered lines, for a caller that flushes memory-only telemetry later. */
  drain() {
    const out = this._buffered.slice();
    this._buffered.length = 0;
    return out;
  }
}

/**
 * Keep only values that carry no content: numbers, booleans, short enum strings,
 * digests, and counts. Longer strings are replaced by a digest and a length, so a
 * caller cannot leak content into the log by passing a message.
 */
function sanitise(data) {
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "number") {
      out[key] = Number.isFinite(value) ? value : null;
      continue;
    }
    if (typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (typeof value === "string") {
      // A short string is treated as an enum or a digest. A long string is content.
      if (value.length <= 48) {
        out[key] = value;
      } else {
        out[`${key}.len`] = value.length;
        out[`${key}.sha`] = digest(value);
      }
      continue;
    }
    if (Array.isArray(value)) {
      out[`${key}.count`] = value.length;
      const enums = value.filter((v) => typeof v === "string" && v.length <= 48);
      if (enums.length === value.length && value.length <= 16) out[key] = enums;
      continue;
    }
    if (typeof value === "object") {
      out[`${key}.keys`] = Object.keys(value).length;
      continue;
    }
    out[key] = String(value).slice(0, 48);
  }
  return out;
}

/** JSON.stringify that cannot throw on a cycle and never emits a newline inside a record. */
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ seq: -1, ts: new Date().toISOString(), step: STEP.UNGOVERNED, ok: false, v: 1 });
  }
}
