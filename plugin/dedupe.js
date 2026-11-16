/**
 * Dedupe — one review per tool call, when the host sends the same call twice.
 *
 * A tool call reaches the gate through two hooks:
 *
 *   1. `tool.execute.before`, which the host runs before the tool executes; and
 *   2. `permission.evaluate`, which the host runs when the tool asserts its own
 *      permission inside `execute`.
 *
 * The host produces both with the same call identity, and it produces them at nearly the
 * same moment: the two arrivals overlap rather than follow one another. The gate would
 * therefore review one call twice — two model calls, twice the latency, and two records
 * for one event. A measured session showed 2.19 evaluations per tool result.
 *
 * The registry holds the *decision*, not the fact that a call was seen. The second arrival
 * is answered with the first arrival's result, so a duplicate can never be looser than the
 * original: a deny stays a deny, an ask stays an ask. It holds the in-flight promise, not
 * a finished value, because the second arrival usually happens before the first review has
 * answered.
 *
 * A call is remembered for a short window, and the entry is claimed once. The window
 * separates "the same call again" from "another call that happens to repeat the
 * arguments"; a third sighting is a new call and is reviewed.
 *
 * No imports.
 */

/** How long a reviewed call stays claimable by its twin, in milliseconds. */
export const DEDUPE_WINDOW_MS = 15000;

/** The most calls to remember at once, so a long session cannot grow without bound. */
const MAX_ENTRIES = 256;

/**
 * Build the registry.
 *
 * @param {{ windowMs?: number }} [options]
 * @returns {{
 *   join: (key: string) => Promise<object> | null,
 *   start: (key: string) => ((result: object) => void) | null,
 *   size: () => number,
 *   clear: () => void,
 * }}
 */
export function buildDedupe(options = {}) {
  const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : DEDUPE_WINDOW_MS;
  /** @type {Map<string, { at: number, settle: (result: object) => void, promise: Promise<object> }>} */
  const pending = new Map();

  /** Drop entries that are older than the window, then the oldest beyond the cap. */
  function prune(now) {
    for (const [key, entry] of pending) {
      if (now - entry.at > windowMs) pending.delete(key);
    }
    while (pending.size > MAX_ENTRIES) {
      const oldest = pending.keys().next();
      if (oldest.done) break;
      pending.delete(oldest.value);
    }
  }

  return {
    /**
     * Join a call that is already being reviewed.
     *
     * @returns {Promise<object> | null} the earlier decision, or null when this caller
     *   must review the call itself.
     */
    join(key) {
      if (!key) return null;
      prune(Date.now());
      const entry = pending.get(key);
      if (!entry) return null;
      pending.delete(key);
      return entry.promise;
    },
    /**
     * Announce that this caller is reviewing a call, so its twin can join.
     *
     * @returns {((result: object) => void) | null} a function to report the decision, or
     *   null when this call is not identifiable and so cannot be deduped.
     */
    start(key) {
      if (!key) return null;
      const now = Date.now();
      prune(now);
      let settle = () => {};
      const promise = new Promise((resolve) => {
        settle = resolve;
      });
      pending.set(key, { at: now, settle, promise });
      return (result) => {
        const entry = pending.get(key);
        if (entry) entry.settle(result);
        settle(result);
      };
    },
    size() {
      return pending.size;
    },
    clear() {
      pending.clear();
    },
  };
}

/**
 * The identity of a call, or an empty string when the event carries none.
 *
 * A tool event names the call `id`. A permission event names it `source.id`. The host
 * fills both from one value, so the two forms join.
 *
 * @param {{ sessionID?: string, source?: { id?: string }, callID?: string, id?: string }} event
 * @returns {string}
 */
export function callKey(event) {
  if (!event) return "";
  const id = event.callID || event.id || (event.source && event.source.id);
  if (!id) return "";
  return `${event.sessionID || ""}\u0000${String(id)}`;
}
