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

export function registerProbe(ctx, telemetry) {
  if (!ctx) return;
  const describe = (value) => {
    if (value === null) return "null";
    if (Array.isArray(value)) return `array(${value.length})`;
    return typeof value;
  };
  const keysOf = (value) => {
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
  };

  const dump = {};
  for (const key of Object.keys(ctx)) {
    const value = ctx[key];
    dump[key] = { type: describe(value), keys: keysOf(value).slice(0, 40) };
  }

  telemetry.record(STEP.CTX_DUMP, { data: { surface: dump } });
}
