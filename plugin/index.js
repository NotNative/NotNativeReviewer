/**
 * NotNativeReviewer — tool-use permission reviewer for OpenCode.
 *
 * Entrypoint for the OpenCode plugin loader.
 *
 * Constraint (docs/coding-discipline.md §3): this module exposes a plain
 * default export of `{ id, setup }` and imports no host package. It imports only its own
 * sibling modules, so it loads from a directory where no node_modules exists.
 *
 * The gate registers five hooks (docs/how-it-works.md §3):
 *
 *   ctx.permission.hook("evaluate")     the enforcement point (D-018)
 *   ctx.session.hook("prompt")          records user input in the package
 *   ctx.session.hook("context")         records agent text in the package
 *   ctx.event.subscribe                 question answers, session cleanup
 *   ctx.tool.hook("execute.after")      the result digest for read-before-write
 *
 * Telemetry is local and carries no content (docs/coding-discipline.md §4).
 */

import { STEP, Telemetry } from "./telemetry.js";
import { ReviewerPackageStore } from "./package.js";
import { ObservationStore } from "./observation.js";
import { buildFileLayer } from "./files.js";
import { buildDedupe } from "./dedupe.js";
import { registerHooks } from "./hooks.js";
import { parseTtlMinutes, readPluginDirectory, readSettings, SETTINGS_FILE } from "./settings.js";
import { DEFAULT_TTL_MINUTES, StateFile } from "./state.js";
import { registerProbe } from "./probe.js";
import { VERSION } from "./version.js";

export const id = "notnativereviewer";

/** The telemetry file name, next to this module. */
export const TELEMETRY_FILE = "notnativereviewer-telemetry.jsonl";

/**
 * The default telemetry sink.
 *
 * The host runs as `opencode serve --stdio`, so stdout is the protocol channel. A record
 * written with `console.log` would go into the wire instead of a log, which loses the
 * record and risks corrupting the transport. The sink therefore writes a file next to the
 * plugin, and falls back to stderr, which no protocol uses.
 *
 * A file needs one append per line. The layer probes for a writer the same way that
 * `files.js` probes for a reader.
 *
 * @returns {((line: string) => void) | undefined}
 */
function defaultSink() {
  const path = joinPath(readPluginDirectory(), TELEMETRY_FILE);
  const append = detectAppend();
  if (append) {
    return (line) => {
      try {
        append(path, `${line}\n`);
      } catch {
        // A logging failure must not change a decision (coding-discipline.md §5).
      }
    };
  }
  if (typeof console !== "undefined" && typeof console.error === "function") {
    return (line) => console.error(`[notnativereviewer] ${line}`);
  }
  return undefined;
}

/** Find a synchronous append-to-file writer, or null. */
function detectAppend() {
  const fs = nodeFs();
  if (fs && typeof fs.appendFileSync === "function") return (path, text) => fs.appendFileSync(path, text, "utf8");
  const scope = typeof globalThis !== "undefined" ? globalThis : {};
  if (scope.Deno && typeof scope.Deno.writeTextFileSync === "function") {
    return (path, text) => scope.Deno.writeTextFileSync(path, text, { append: true });
  }
  return null;
}

/**
 * Write the state file in one step.
 *
 * The text goes to a temporary name and is renamed over the real one, so a reader never sees
 * half a file. A failure leaves the previous file in place, which still restores or still
 * fails closed; either way nothing is invented.
 *
 * @returns {((path: string, text: string) => void) | null}
 */
function detectWriter() {
  const fs = nodeFs();
  if (!fs || typeof fs.writeFileSync !== "function") return null;
  return (path, text) => {
    const temp = `${path}.tmp`;
    fs.writeFileSync(temp, text, "utf8");
    try {
      if (typeof fs.chmodSync === "function") fs.chmodSync(temp, 0o600);
    } catch {
      // A file mode is best effort; Windows takes its permissions from the profile directory.
    }
    if (typeof fs.renameSync === "function") {
      fs.renameSync(temp, path);
      return;
    }
    fs.writeFileSync(path, text, "utf8");
  };
}

/** The Node filesystem module, when the host exposes it. */
function nodeFs() {
  const scope = typeof globalThis !== "undefined" ? globalThis : {};
  if (typeof scope.require === "function") {
    try {
      const fs = scope.require("node:fs");
      if (fs) return fs;
    } catch {
      // Fall through.
    }
  }
  const process = scope.process;
  if (process && typeof process.getBuiltinModule === "function") {
    try {
      const fs = process.getBuiltinModule("node:fs");
      if (fs) return fs;
    } catch {
      // Fall through.
    }
  }
  return null;
}

/** The directory that holds the state file. A test can name a temporary one. */
function stateDirectory(options) {
  const named = options && options.stateDirectory;
  if (typeof named === "string" && named !== "") return named;
  return readPluginDirectory();
}

/** Join a directory and a file name with the separator that the directory uses. */
function joinPath(directory, name) {
  const base = String(directory || ".");
  const separator = base.includes("\\") ? "\\" : "/";
  return base.endsWith(separator) ? `${base}${name}` : `${base}${separator}${name}`;
}

/**
 * Read the test postures (docs/how-it-works.md §10).
 *
 * A shell variable does not reach a host that was started another way, so the gate reads
 * its own file, `nnr.env`, from the plugin directory. The environment is read as
 * a fallback, so a CI run can still set a posture without a file. A file value wins over an
 * environment value, because the file is the one that the operator installed.
 *
 * @returns {{ options: object, source: string, errors: string[] }}
 */
function readPostures() {
  const env = typeof process !== "undefined" && process.env ? process.env : {};
  const fromEnv = {};
  if (env.NNR_FORCE_DENY === "1") fromEnv.forceDeny = true;
  if (env.NNR_FORCE_ALLOW === "1") fromEnv.forceAllow = true;
  const envTtl = parseTtlMinutes(env.NNR_STATE_TTL_MINUTES);
  if (envTtl.minutes !== null) fromEnv.stateTtlMs = envTtl.minutes * 60000;

  let fromFile = {};
  let present = false;
  let errors = [];
  try {
    const read = readSettings(readPluginDirectory(), { fsLayer: buildFileLayer() });
    fromFile = read.options;
    present = read.present;
    errors = read.errors;
  } catch (error) {
    errors = [`could not read ${SETTINGS_FILE}: ${error && error.message}`];
  }
  if (envTtl.error) errors = [envTtl.error, ...errors];

  const options = { ...fromEnv, ...fromFile };
  const source = postureSource(fromFile, fromEnv, present);
  return { options, source, errors };
}

/**
 * Name the layer that supplied the active posture.
 *
 * A forced close wins, so it is the posture to attribute when both are set. A file value
 * wins over an environment value for the same key. When no posture is on, a file that was
 * read is still the source, because it set the value to off.
 *
 * @param {object} fromFile the postures that the settings file enabled
 * @param {object} fromEnv the postures that the environment enabled
 * @param {boolean} present whether the settings file was read
 * @returns {string}
 */
function postureSource(fromFile, fromEnv, present) {
  if (fromFile.forceDeny || fromEnv.forceDeny) return fromFile.forceDeny ? SETTINGS_FILE : "environment";
  if (fromFile.forceAllow || fromEnv.forceAllow) return fromFile.forceAllow ? SETTINGS_FILE : "environment";
  return present ? SETTINGS_FILE : "defaults";
}

/**
 * Merge the settings with the options that the caller passes.
 *
 * An explicit option wins, so a test can set a posture that the file does not. A key whose
 * value is `undefined` is not a value: it leaves the lower layer in place, so a caller can
 * pass one key and still take the other from the file.
 */
function mergeOptions(fromFile, fromCaller) {
  const merged = { ...fromFile };
  for (const [key, value] of Object.entries(fromCaller || {})) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Register the hooks.
 *
 * A hook that the host does not provide is skipped and recorded as ungoverned, so a
 * host change degrades the gate visibly instead of crashing it.
 *
 * The second argument carries gate options. The host loader passes only `ctx`, so the
 * options are used by tests, and by the settings file and environment postures below.
 *
 * @param {object} ctx the host context
 * @param {{ deadlineMs?: number, model?: object, payloadBytes?: number,
 *          forceDeny?: boolean, forceAllow?: boolean }} [options]
 */
export const setup = async (ctx, options = {}) => {
  const telemetry = new Telemetry({ write: defaultSink() });
  // `models` holds the model that each session is using, captured from the context hook
  // (D-019), so the reviewer call names the same model.
  const stores = { packages: new ReviewerPackageStore(), observations: new ObservationStore(), models: new Map() };
  // A caller may pass a file layer, so a test can supply known file content.
  const fileLayer = options.fsProvider ? buildFileLayer({ fsProvider: options.fsProvider }) : buildFileLayer();
  const postures = readPostures();
  const settings = mergeOptions(postures.options, options);
  // One review per tool call, though the host can send a call through two hooks (§3.2).
  const seen = buildDedupe();
  // The package and the ledger survive a reload until the user speaks again (§5.6). An
  // explicit `stateTtlMs` adds a clock; `0` turns persistence off.
  const ttlMs = Number.isFinite(settings.stateTtlMs) ? settings.stateTtlMs : null;
  const state = new StateFile({
    directory: stateDirectory(settings),
    ttlMs,
    layer: buildFileLayer(),
    writer: detectWriter(),
    onFailure: (reason) => telemetry.record(STEP.STATE_RESTORED, { ok: false, data: { reason: `write:${reason}` } }),
  });

  telemetry.record(STEP.SETUP, {
    data: {
      version: VERSION,
      hasGenerateText: Boolean(pickGenerate(ctx)),
      forceDeny: Boolean(settings.forceDeny),
      forceAllow: Boolean(settings.forceAllow),
      postureSource: postures.source,
      settingsErrors: postures.errors.length,
      postureConflict: Boolean(settings.forceDeny && settings.forceAllow),
      // A probe of the link surface (§5.4): which places a plugin can ask about a session's
      // parent actually exist on this host. Recorded once, at setup.
      linkSurface: describeLinkSurface(ctx),
    },
  });

  if (settings.forceDeny && settings.forceAllow) {
    telemetry.record(STEP.UNGOVERNED, {
      ok: false,
      data: { setting: SETTINGS_FILE, error: "both postures are on; a forced close wins" },
    });
  }

  for (const error of postures.errors) {
    telemetry.record(STEP.UNGOVERNED, { ok: false, data: { setting: SETTINGS_FILE, error } });
  }

  const restored = state.restoreInto(stores);
  telemetry.record(STEP.STATE_RESTORED, {
    ok: restored.ok,
    data: {
      reason: restored.reason,
      sessions: restored.sessions,
      reads: restored.reads,
      links: restored.links,
      expired: restored.expired,
      ageMinutes: restored.ageMinutes,
      ttlMinutes: ttlMs === null ? "until_next_user_input" : Math.round(ttlMs / 60000),
    },
  });

  registerHooks(ctx, { telemetry, stores, fileLayer, options: settings, seen, state });

  telemetry.record(STEP.UNGOVERNED, {
    data: { gate: "active", note: "hooks registered; the gate denies a call when the reviewer cannot decide" },
  });

  // Exposed for a diagnostic: the gate's own record of the host context, not a public API.
  ctx.notnativereviewer = { telemetry, stores, context: ctx };
  // Temporary probe (version 20261117-2): dump the host context once, at setup.
  registerProbe(ctx, telemetry);
  return undefined;
};

/**
 * Describe the host surfaces that could name a session's parent (§5.4).
 *
 * A plugin is given `ctx`, and the question "which of these can tell me a session's parent?"
 * has to be answered from what is actually present, not from the documentation. This probe
 * names the presence of each surface so the log shows which ones a build can try. It never
 * calls the host, so it cannot slow setup or fail.
 *
 * @param {object} ctx the host context
 * @returns {string}
 */
function describeLinkSurface(ctx) {
  const has = (object, key) => Boolean(object && typeof object[key] === "function");
  const client = ctx && ctx.client;
  const session = client && client.session;
  const hooks = ctx && ctx.session && typeof ctx.session.hook === "function";
  const event = ctx && ctx.event && typeof ctx.event.subscribe === "function";
  const surfaces = [];
  if (has(session, "get")) surfaces.push("client.session.get");
  if (has(session, "list")) surfaces.push("client.session.list");
  if (has(session, "messages")) surfaces.push("client.session.messages");
  if (hooks) surfaces.push("session.hook");
  if (event) surfaces.push("event.subscribe");
  return surfaces.length === 0 ? "none" : surfaces.join(",");
}

/** Whether the host can make a reviewer call. */
function pickGenerate(ctx) {
  const experimental = ctx && ctx.experimental && ctx.experimental.generate;
  if (experimental && typeof experimental.text === "function") return true;
  const legacy = ctx && ctx.generate;
  return Boolean(legacy && typeof legacy.text === "function");
}

/**
 * The plugin object that the OpenCode loader reads.
 *
 * The loader needs a default export of `{ id, setup }`. The `files.js` export of
 * `byteLength` is a re-export; the loader reads only this object.
 */
export default { id, setup };
