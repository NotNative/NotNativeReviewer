/**
 * Settings — the gate's own configuration file.
 *
 * The host loader passes only `ctx`, and the process environment of the host is not under
 * the operator's control: a variable set in a shell does not reach a host that was started
 * another way. The gate therefore reads a file next to its own modules.
 *
 * The file is `nnr.env`, in the plugin directory:
 *
 *   NNR_FORCE_DENY=1
 *   NNR_FORCE_ALLOW=0
 *
 * Rules for the file (docs/how-it-works.md §10):
 *   - One `KEY=VALUE` pair on each line.
 *   - A `#` starts a comment. An empty line is ignored.
 *   - An unquoted value has trailing whitespace removed.
 *   - A key that the gate does not know is ignored, so an old file still loads.
 *   - A missing file is not an error. The gate runs with its defaults.
 *
 * The file is read once, at setup. A change needs a restart, as an install does.
 *
 * Imports only `files.js`.
 */

import { buildFileLayer } from "./files.js";

/** The file name, next to the plugin modules. */
export const SETTINGS_FILE = "nnr.env";

/** The keys that the gate reads. Any other key is ignored. */
export const KNOWN_KEYS = Object.freeze(["NNR_FORCE_DENY", "NNR_FORCE_ALLOW", "NNR_STATE_TTL_MINUTES"]);

/**
 * Parse the text of a settings file into a plain object.
 *
 * @param {string} text
 * @returns {{ values: Record<string, string>, errors: string[] }}
 */
export function parseSettings(text) {
  const values = {};
  const errors = [];
  if (typeof text !== "string") return { values, errors };

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseLine(lines[i], i + 1);
    if (parsed.error) errors.push(parsed.error);
    else if (parsed.key) values[parsed.key] = parsed.value;
  }
  return { values, errors };
}

/**
 * Parse one line.
 *
 * @param {string} raw
 * @param {number} lineNumber
 * @returns {{ key?: string, value?: string, error?: string }}
 */
function parseLine(raw, lineNumber) {
  const stripped = String(raw).replace(/#.*$/, "").trim();
  if (stripped === "") return {};

  const split = stripped.indexOf("=");
  if (split === -1) return { error: `line ${lineNumber}: no '=' in '${stripped}'` };

  const key = stripped.slice(0, split).trim();
  const value = stripped.slice(split + 1).trim();
  if (key === "") return { error: `line ${lineNumber}: empty key` };
  if (!KNOWN_KEYS.includes(key)) return {};
  return { key, value };
}

/**
 * Read the settings file and turn it into gate options.
 *
 * @param {string} directory the plugin directory
 * @param {{ fsLayer?: object }} [options]
 * @returns {{ options: object, present: boolean, errors: string[] }}
 */
export function readSettings(directory, options = {}) {
  const layer = options.fsLayer || buildFileLayer();
  const path = joinPath(directory, SETTINGS_FILE);

  let text = "";
  try {
    text = layer.readText(path);
  } catch {
    text = "";
  }
  if (typeof text !== "string" || text === "") return { options: {}, present: false, errors: [] };

  const { values, errors } = parseSettings(text);
  const parsed = toOptions(values);
  const ttl = parseTtlMinutes(values.NNR_STATE_TTL_MINUTES);
  if (ttl.error) errors.push(ttl.error);
  if (ttl.minutes !== null) parsed.stateTtlMs = ttl.minutes * 60000;
  return { options: parsed, present: true, errors };
}

/**
 * Read the state TTL from a settings value.
 *
 * The value is a whole number of minutes, and `0` turns persistence off. A value the gate
 * cannot read disables persistence and reports why: an unreadable setting must not leave
 * the user's authority on disk for longer than the operator meant.
 *
 * @param {string | undefined} raw
 * @returns {{ minutes: number | null, error?: string }}
 */
export function parseTtlMinutes(raw) {
  if (raw === undefined || raw === null) return { minutes: null };
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) return { minutes: Number(text) };
  return { minutes: 0, error: "NNR_STATE_TTL_MINUTES: expected a whole number of minutes (0 disables)" };
}

/**
 * Turn the parsed values into gate options. Only the exact value `1` enables a posture,
 * so a typo leaves the gate in its normal state rather than in a test state.
 *
 * @param {Record<string, string>} values
 * @returns {object}
 */
function toOptions(values) {
  const options = {};
  if (values.NNR_FORCE_DENY === "1") options.forceDeny = true;
  if (values.NNR_FORCE_ALLOW === "1") options.forceAllow = true;
  return options;
}

/** Join a directory and a file name with the separator that the directory uses. */
function joinPath(directory, name) {
  const base = String(directory || ".");
  const separator = base.includes("\\") ? "\\" : "/";
  return base.endsWith(separator) ? `${base}${name}` : `${base}${separator}${name}`;
}

/**
 * The directory that holds this module, when the host exposes it.
 * A host that does not expose it falls back to the current directory.
 *
 * @returns {string}
 */
export function readPluginDirectory() {
  try {
    if (typeof import.meta !== "undefined" && import.meta.url) {
      const url = new URL(import.meta.url);
      const path = decodeURIComponent(url.pathname);
      const cut = path.replace(/\/[^/]+$/, "");
      // Windows keeps a leading slash in the path of a file URL. Remove it.
      return /^\/[A-Za-z]:/.test(cut) ? cut.slice(1) : cut;
    }
  } catch {
    // Fall through.
  }
  return ".";
}
