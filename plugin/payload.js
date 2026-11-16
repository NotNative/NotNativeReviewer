/**
 * Payload — the file content that the reviewer sees for one call.
 *
 * A call carries a path, not content. The reviewer cannot read a file, so the gate reads
 * what the call names and shows it alongside the call (§4.1, D-013). A shell call names a
 * command, so the gate reads the files that the command runs, which reviews a script before
 * it executes (§5.1).
 *
 * Imports `bytes.js` and `floor.js`, both siblings.
 */

import { byteLength, trimToBytes, budgetText } from "./bytes.js";
import { readCommandBase, readScriptPaths } from "./floor.js";

/**
 * Read the file content for this call, so the reviewer judges content and not a path
 * (§4.1, D-013). The excerpt shrinks before anything else (§6.4).
 *
 * A shell call carries a command, so its first target is the command text and not a file.
 * For that call the gate reads the files that the command names, so that a script is
 * reviewed before it runs (§5.1).
 */
export async function readPayloadExcerpt(input, event, targetPaths) {
  const payloadBytes = (input.options && input.options.payloadBytes) || 16384;
  if (targetPaths.length === 0) return "";

  const isShell = isShellAction(event && event.action);
  const command = String(targetPaths[0]);
  const base = isShell ? readCommandBase(command) : "";
  const all = isShell ? readScriptPaths(command) : [targetPaths[0]];
  // A value that the command uses as its own directory is not a file that it opens.
  const paths = all.filter((path) => !samePath(path, base));
  if (paths.length === 0) return isShell ? `command: ${command}` : "";

  const parts = [];
  for (const path of paths) {
    const read = await readNamedFile(input, path, base, payloadBytes);
    if (read.text === "") continue;
    parts.push(isShell ? `### file: ${read.path}\n${read.text}` : read.text);
  }
  if (parts.length === 0) {
    // The gate could not read the file. Show the command, so the reviewer still sees what
    // will run rather than an empty section it cannot interpret. Say that the content is
    // absent, so the reviewer asks rather than assuming the call is unexplained.
    return isShell ? `command: ${command}\n(file content unavailable: the gate could not read ${paths.join(", ")})` : "";
  }
  return budgetText(parts.join("\n\n"), payloadBytes).text;
}

/**
 * The command text of a shell call, or an empty string for another kind of call.
 * The command is the first target that the tool gate recorded.
 */
export function readShellCommand(event) {
  if (!isShellAction(event && event.action)) return "";
  const resources = event && event.resources;
  if (!Array.isArray(resources) || resources.length === 0) return "";
  return typeof resources[0] === "string" ? resources[0] : "";
}

/** Whether an action is a shell command. */
export function isShellAction(action) {
  const name = String(action || "").toLowerCase();
  return name === "shell" || name === "bash" || name === "sh";
}

/** Whether a named path is the command's own directory, compared loosely. */
function samePath(a, b) {
  if (!b) return false;
  const fold = (value) => String(value).replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return fold(a) === fold(b);
}

/**
 * Read one path that a command names, trying the command's own directory first.
 *
 * `git -C /repo rm src/x.js` names `src/x.js` relative to `/repo`. Reading it relative to
 * the gate's directory would find nothing, and the reviewer would judge a deletion with no
 * sight of what it deletes (§5.1).
 *
 * @returns {{ path: string, text: string }} the path that was read, and its content
 */
async function readNamedFile(input, path, base, payloadBytes) {
  for (const candidate of candidatePaths(path, base)) {
    const text = await readOneFile(input, candidate, payloadBytes);
    if (text !== "") return { path: candidate, text };
  }
  return { path, text: "" };
}

/** The paths to try for one named file: the command's directory first, then as written. */
function candidatePaths(path, base) {
  if (base === "" || isAbsolutePath(path)) return [path];
  return [joinPath(base, path), path];
}

/** Whether a path already names its own root. */
function isAbsolutePath(path) {
  return path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
}

/** Join a directory and a relative path, using one separator throughout. */
function joinPath(base, path) {
  const trimmed = base.replace(/[\\/]+$/, "");
  const relative = path.replace(/^[\\/]+/, "");
  const usesBackslash = trimmed.includes("\\") && !trimmed.includes("/");
  const joined = usesBackslash ? `${trimmed}\\${relative}` : `${trimmed}/${relative}`;
  // A file name with `/` in it reads the same either way on POSIX. On Windows one separator
  // avoids a path such as `C:\\repo/src/x.js`.
  return usesBackslash ? joined.replace(/\//g, "\\") : joined;
}

/** Read one file as an excerpt, or return an empty string when the gate cannot read it. */
async function readOneFile(input, path, payloadBytes) {
  try {
    const text = await input.readFileText(path);
    if (typeof text !== "string" || text === "") return "";
    return byteLength(text) <= payloadBytes ? text : trimToBytes(text, payloadBytes);
  } catch {
    return "";
  }
}
