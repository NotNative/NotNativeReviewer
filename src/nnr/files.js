/**
 * File layer — the gate's own access to file content and file state.
 *
 * The reviewer is tool-less (§7). The gate reads files on its behalf and puts the bytes
 * in the payload excerpt. The gate also computes a digest at read time and at write time
 * for the read-before-write invariant (§3.1).
 *
 * The plugin must not import `node:fs` unconditionally, because it loads from a directory
 * where no node_modules exists and the host may not expose node built-ins the same way.
 * This layer therefore probes for a reader in the host first, and uses a minimal reader
 * last.
 *
 * Imports only `bytes.js` and `telemetry.js`.
 */

import { byteLength } from "./bytes.js";
import { digest } from "./telemetry.js";

/**
 * Build the file layer.
 *
 * @param {{ fsProvider?: object }} options
 * @returns {{ digest: (path: string) => object, readText: (path: string) => string }}
 */
export function buildFileLayer(options = {}) {
  const provider = options.fsProvider || detectProvider();
  return {
    /**
     * The state of one path: whether it exists, and the digest of its content.
     * A synchronous result keeps the evaluate path simple and fast.
     *
     * The path is read as the caller wrote it, so the file system resolves it. The ledger
     * key is a separate concern, and `canonicalPath` builds it (§6).
     */
    digest(path) {
      if (!provider) return { exists: false, digest: null };
      try {
        const text = provider.readFileSync(path, "utf8");
        return { exists: true, digest: digest(text) };
      } catch (error) {
        if (isNotFound(error)) return { exists: false, digest: null };
        return { exists: true, digest: null };
      }
    },
    /** The content of one path, or an empty string when the gate cannot read it. */
    readText(path) {
      if (!provider) return "";
      try {
        return provider.readFileSync(path, "utf8");
      } catch {
        return "";
      }
    },
  };
}

/**
 * A stable key for a file path.
 *
 * A tool call carries the path that the model wrote. A permission event carries a
 * resource string, which can be a `file://` URL with a trailing wildcard. The ledger
 * and the file reader must see one form, or a read would not match a later write.
 *
 * This key names a file the gate already resolved. It is not a security boundary. A
 * shape the gate cannot resolve keeps a raw form, so a mismatch denies rather than
 * allows.
 *
 * @param {string} path
 * @returns {string}
 */
export function canonicalPath(path) {
  let value = typeof path === "string" ? path.trim() : "";
  if (value === "") return "";
  if (/^file:\/\//i.test(value)) {
    value = value.slice("file://".length);
    try {
      value = decodeURIComponent(value);
    } catch {
      // A stray percent sign. Keep the text as written.
    }
  }
  value = value.replace(/\\/g, "/").replace(/\/+\*?$/, "");
  if (/^\/[a-z]:\//i.test(value)) value = value.slice(1);
  value = removeDotSegments(value);
  if (value === "") return "";
  // A drive-letter path names the same file in either case, so the key folds case.
  return /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
}

/** Remove `.` and `..` segments, so `a/./b` and `a/b` name one file. */
function removeDotSegments(value) {
  const absolute = value.startsWith("/");
  const out = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(segment);
  }
  const joined = out.join("/");
  return absolute ? `/${joined}` : joined;
}

/**
 * Find a synchronous file reader.
 *
 * OpenCode runs on Bun. Bun does not read a file synchronously through `Bun.file`, whose
 * `.text()` returns a promise. Bun does provide node built-ins, so the layer uses
 * `node:fs` through `require` when the host provides it. `require` is probed rather than
 * imported, so this module loads in a directory with no node_modules.
 */
function detectProvider() {
  const globalScope = typeof globalThis !== "undefined" ? globalThis : {};

  if (typeof globalScope.require === "function") {
    try {
      const fs = globalScope.require("node:fs");
      if (fs && typeof fs.readFileSync === "function") return fs;
    } catch {
      // Fall through to the next probe.
    }
  }
  if (typeof globalScope.process === "object" && globalScope.process && typeof globalScope.process.getBuiltinModule === "function") {
    try {
      const fs = globalScope.process.getBuiltinModule("node:fs");
      if (fs && typeof fs.readFileSync === "function") return fs;
    } catch {
      // Fall through.
    }
  }
  if (globalScope.Deno && typeof globalScope.Deno.readTextFileSync === "function") {
    return { readFileSync: (path) => globalScope.Deno.readTextFileSync(path) };
  }
  return null;
}

/** Whether an error means "the path does not exist". */
function isNotFound(error) {
  if (!error) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR" || /no such file/i.test(String(error.message));
}

/**
 * A digest of a text, sized for a log. The gate records the digest, never the content.
 * @param {string} text
 * @returns {string}
 */
export function digestText(text) {
  return digest(typeof text === "string" ? text : "");
}

/** The byte length of a text, re-exported so callers need one import. */
export { byteLength };
