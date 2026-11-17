/**
 * Diagnostic probe: dump the host context's structure (temporary, version 20261117-2).
 *
 * Answers one question: is there a surface that names a session's parent? The plugin sees
 * `ctx`, and that object is the only thing the host hands it besides events. This dump names
 * every property of it, one level deep, with the names of that property's own keys, so the
 * shape is visible without guessing.
 *
 * It is removed once the surface is known.
 */

import { STEP } from "./telemetry.js";

export async function registerProbe(ctx, telemetry) {
  if (!ctx) return;
  dumpSurface(ctx, telemetry);

  await probeCall(ctx, telemetry, "session.get", async () => {
    const directory = ctx.location && ctx.location.directory;
    const id = processSessionID();
    // The host's own call signature: an id and the directory it serves. A rejected attempt
    // is recorded, not thrown, so the next shape can be tried from the log alone.
    const reply = await ctx.session.get(id, { directory });
    return reply;
  });

  // The hook-native path (§5.4): the prompt hook already receives every session's first
  // input, including a subagent's. If the host attaches the parent anywhere, it is on that
  // event. This dumps the event's own shape, once per prompt, until the surface is known.
  if (ctx.session && typeof ctx.session.hook === "function") {
    ctx.session.hook("prompt", async (event) => {
      dumpEventShape(telemetry, event);
      return undefined;
    });
  }
}

/** Dump the host context's shape, one record per property. */
function dumpSurface(ctx, telemetry) {
  const dump = {};
  for (const key of Object.keys(ctx)) {
    const value = ctx[key];
    dump[key] = { type: describe(value), keys: keysOf(value).slice(0, 40) };
  }

  // One record per property. The log keeps a short string whole and replaces a long one
  // with a digest, so a line per key is what survives the sink. A member list longer than
  // the cap is split into chunks, so the full surface is readable in the log.
  for (const [key, value] of Object.entries(dump)) {
    const names = value.keys;
    const text = `${key} (${value.type}): ${names.join(" ")}`;
    telemetry.record(STEP.CTX_DUMP, { data: { line: text.length <= 48 ? text : `${key} (${value.type})` } });
    if (text.length <= 48) continue;
    telemetry.record(STEP.CTX_DUMP, { data: { [`${key}.count`]: names.length } });
    // Each chunk stays under the sink's 48-character limit, so every name reaches the log.
    for (let start = 0; start < names.length;) {
      const chunk = [];
      while (start < names.length && [...chunk, names[start]].join(",").length <= 44) {
        chunk.push(names[start]);
        start += 1;
      }
      telemetry.record(STEP.CTX_DUMP, { data: { [`${key}.${chunk[0]}`]: chunk.join(",") } });
    }
  }
}

/** Describe a value for the log: a type, or a short count. */
function describe(value) {
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

/** A member's own names, plus the prototype's, which often holds the methods. */
function keysOf(value) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return [];
  const names = [];
  for (const key of Object.keys(value)) names.push(key);
  // A getter or a prototype method is often the useful part on a host object.
  let proto = null;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    proto = null;
  }
  if (proto && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key !== "constructor" && !names.includes(key)) names.push(`proto:${key}`);
    }
  }
  return names;
}

/**
 * The keys of a hook event, two levels deep, and any session id it carries.
 *
 * Field names and a value that looks like a session id are the only content. A prompt's
 * text is never recorded, so the dump cannot become a second transcript.
 */
function dumpEventShape(telemetry, event) {
  if (!event || typeof event !== "object") return;
  for (const [key, value] of Object.entries(event).slice(0, 12)) {
    const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).slice(0, 14).join(",") : "";
    telemetry.record(STEP.CTX_DUMP, { data: { [`ev.${key}`]: keys.length <= 40 ? keys || describe(value) : `${keys.length} keys` } });
    if (typeof value === "string" && value.startsWith("ses")) {
      telemetry.record(STEP.CTX_DUMP, { data: { [`ev.${key}.id`]: value.slice(0, 40) } });
    }
  }
  const prompt = event.prompt;
  if (prompt && typeof prompt === "object") {
    for (const [key, value] of Object.entries(prompt).slice(0, 14)) {
      telemetry.record(STEP.CTX_DUMP, { data: { [`ev.prompt.${key}`]: describe(value) } });
      if (typeof value === "string" && value.startsWith("ses")) {
        telemetry.record(STEP.CTX_DUMP, { data: { [`ev.prompt.${key}.id`]: value.slice(0, 40) } });
      }
    }
  }
}

/** The session this process is serving, when the host sets it in the environment. */
function processSessionID() {
  const env = typeof process !== "undefined" && process.env ? process.env : {};
  return env.OPENCODE_SESSION_ID || "";
}

/** Run one host call and record the field names it answered with, or the error. */
async function probeCall(ctx, telemetry, name, call) {
  try {
    const value = await call();
    const fields = value && typeof value === "object" ? Object.keys(value).join(",") : describe(value);
    telemetry.record(STEP.CTX_DUMP, { data: { [`call.${name}`]: fields.length <= 44 ? fields : `${name}: ${fields.length} chars` } });
    for (let start = 0; start < fields.length; start += 44) {
      telemetry.record(STEP.CTX_DUMP, { data: { [`call.${name}.${start}`]: fields.slice(start, start + 44) } });
    }
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    telemetry.record(STEP.CTX_DUMP, { ok: false, data: { [`call.${name}.error`]: message.slice(0, 44) } });
  }
}
