/**
 * Floor — deterministic classification before any model involvement.
 *
 * The floor does two things (docs/how-it-works.md §4.1):
 *   1. It decides whether a call reaches semantic review.
 *   2. It separates the egress class, which always reaches semantic review.
 *
 * The floor does NOT skip observation. Every call is recorded, including a call that
 * the floor passes.
 *
 * Rule from §3: the safe/consequential split comes from the tool's declared side
 * effect and scope, not from pattern matching on tool names or arguments. When the
 * declared effect is absent or ambiguous, the call is consequential.
 *
 * The shell is the one exception, and it is not a pattern match on a name: the command
 * text is the only statement of what the call will do. `read-grammar.js` reads it against a
 * closed grammar of read verbs (§4.1.3). Anything outside that grammar is consequential, so
 * the exception can only open a read, never a write.
 *
 * Imports one sibling: `read-grammar.js`, which is pure and has no imports of its own.
 */

import { isReadOnlyCommand, tokeniseCommand } from "./read-grammar.js";

/** The outcome of classification. */
export const CLASS = Object.freeze({
  /** Read-only observation with no external effect. Passes without review. */
  SAFE: "safe",
  /** Changes state in the workspace, or the effect is unknown. Reaches review. */
  CONSEQUENTIAL: "consequential",
  /** Sends data out of the workspace. Always reaches review, even for GET. */
  EGRESS: "egress",
});

/**
 * Tool names whose declared effect the host does not publish, with the effect this
 * gate assumes. The list is a statement about the host, not a pattern match: each
 * entry says "this tool only reads" or "this tool may write".
 */
const DECLARED_EFFECT = Object.freeze({
  read: "read_only",
  glob: "read_only",
  grep: "read_only",
  list: "read_only",
  webfetch: "egress",
  write: "state_changing",
  edit: "state_changing",
  patch: "state_changing",
  multiedit: "state_changing",
  shell: "state_changing",
  bash: "state_changing",
  task: "state_changing",
  subagent: "state_changing",
});

/** Tools that send data out of the workspace, whatever their method. */
const EGRESS_TOOLS = Object.freeze(new Set(["webfetch", "websearch", "fetch"]));

/**
 * A tool whose sub-actions include both reading and changing stores its sub-action in the
 * call input. Classifying such a tool by its name alone would either review every read or
 * pass every write, so the gate reads the sub-action and checks it against a safe list.
 *
 * The list names what is safe. Anything absent — including a sub-action this gate has
 * never seen, and a value the model made up — is consequential, because the safe set is
 * closed and small.
 *
 * Each entry is a statement about the tool, checked against the host's own action list:
 *
 * | Tool | Safe sub-actions | Why the rest are not |
 * | --- | --- | --- |
 * | `openchamber_knowledge` | `knowledge.list` | `save`, `delete`, `show` change or present state |
 * | `openchamber_memory` | `memory.read`, `memory.list` | `save`, `delete` change state |
 * | `openchamber_usage` | `usage.read` | The tool has no other action |
 * | `openchamber_workflow` | `workflow.check`, `workflow.status`, `workflow.result`, `workflow.list` | `run`, `stop`, `save` change state |
 * | `openchamber` | project, model, session, wait and schedule **list/status/search** | `create`, `send`, `fork`, `moveToWorktree`, `delete`, `toggle`, `run` change state |
 *
 * Three tools are deliberately absent, because each can move data out of the workspace:
 *
 * - `openchamber_render` draws a page in the chat. A page can name a remote image, and the
 *   user's own interface then fetches that URL, which is egress that the call did not look
 *   like it was making.
 * - `openchamber_web` drives a browser.
 * - `openchamber_notify` and `openchamber_secret` reach the user or take a credential.
 */
const SAFE_SUB_ACTIONS = Object.freeze({
  openchamber_knowledge: Object.freeze(new Set(["knowledge.list"])),
  openchamber_memory: Object.freeze(new Set(["memory.read", "memory.list"])),
  openchamber_usage: Object.freeze(new Set(["usage.read"])),
  openchamber_workflow: Object.freeze(new Set([
    "workflow.check", "workflow.status", "workflow.result", "workflow.list",
  ])),
  openchamber: Object.freeze(new Set([
    "projects.list", "models.list", "models.search",
    "session.list", "session.status", "session.messages",
    "wait.list", "schedule.status", "schedule.list",
  ])),
});

/**
 * Shell tools carry the command text and no declared effect, so the floor reads the text.
 * The grammar that decides whether it is a read lives in `read-grammar.js`, which can only
 * open a read: a command outside it stays consequential.
 */
const SHELL_TOOLS = Object.freeze(new Set(["shell", "bash", "pwsh"]));

/** The command text of a shell call, or an empty string. */
function readCommand(call) {
  const metadata = call && call.metadata;
  if (metadata && typeof metadata === "object" && typeof metadata.command === "string") {
    return metadata.command;
  }
  const resources = call && call.resources;
  if (Array.isArray(resources) && typeof resources[0] === "string") return resources[0];
  return "";
}

/**
 * Classify a call.
 *
 * @param {{
 *   action: string,
 *   resources?: readonly string[],
 *   metadata?: Record<string, unknown>,
 *   declaredEffect?: string,
 * }} call
 * @returns {{ class: string, reason: string, isEgress: boolean, reachesReview: boolean }}
 */
export function classifyCall(call) {
  const action = String(call.action || "").toLowerCase();

  // An explicit declared effect from the host wins over the table.
  const declared = normaliseEffect(call.declaredEffect, call.metadata);

  if (isEgressAction(action, declared)) {
    return result(CLASS.EGRESS, "egress_tool", true, true);
  }
  if (declared === "read_only") {
    return result(CLASS.SAFE, "declared_read_only", false, false);
  }
  // A shell command states no side effect, so the floor reads the command itself.
  if (declared === null && SHELL_TOOLS.has(action) && isReadOnlyCommand(readCommand(call))) {
    return result(CLASS.SAFE, "read_only_command", false, false);
  }
  if (declared === "state_changing") {
    return result(CLASS.CONSEQUENTIAL, "declared_state_changing", false, true);
  }
  // No declared effect, or an effect this gate does not recognise.
  const assumed = DECLARED_EFFECT[action];
  if (assumed === "read_only") {
    return result(CLASS.SAFE, "assumed_read_only", false, false);
  }
  if (assumed === "egress") {
    return result(CLASS.EGRESS, "assumed_egress", true, true);
  }
  // A tool with mixed sub-actions is safe only when the sub-action it names is on the
  // closed safe list. A sub-action the gate has not seen is consequential.
  const safeSubActions = SAFE_SUB_ACTIONS[action];
  if (safeSubActions) {
    const subAction = readSubAction(call.metadata);
    if (subAction && safeSubActions.has(subAction)) {
      return result(CLASS.SAFE, "safe_sub_action", false, false);
    }
    return result(CLASS.CONSEQUENTIAL, "unsafe_sub_action", false, true);
  }
  return result(CLASS.CONSEQUENTIAL, "unknown_effect", false, true);
}

/**
 * The sub-action that a tool call names, in lower case, or an empty string.
 *
 * The generated OpenChamber tools take `{ action, parameters }`, where `action` is a dotted
 * name such as `knowledge.list`. A model can also send a bare name or a stray case, so the
 * value is normalised before it is compared with the safe list.
 */
function readSubAction(metadata) {
  if (!metadata || typeof metadata !== "object") return "";
  const raw = typeof metadata.action === "string" ? metadata.action : "";
  return raw.trim().toLowerCase();
}

/**
 * Read a declared effect from the host, when the host publishes one.
 * The host may put it in `declaredEffect`, or in `metadata.sideEffect`.
 * @returns {"read_only" | "state_changing" | "egress" | null}
 */
function normaliseEffect(declaredEffect, metadata) {
  const raw = declaredEffect ?? (metadata && metadata.sideEffect);
  if (typeof raw !== "string") return null;
  const value = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (value === "read_only" || value === "readonly" || value === "read") return "read_only";
  if (value === "state_changing" || value === "write" || value === "mutating") return "state_changing";
  if (value === "egress" || value === "network") return "egress";
  return null;
}

/** An egress tool is egress whatever the method. A GET can still leak a query string. */
function isEgressAction(action, declared) {
  if (declared === "egress") return true;
  return EGRESS_TOOLS.has(action);
}

/** Build the classification result. */
function result(cls, reason, isEgress, reachesReview) {
  return { class: cls, reason, isEgress, reachesReview };
}

/**
 * Read the target paths that a call names. The gate uses these for the
 * read-before-write invariant (§3.1). Paths are returned as written; the caller
 * resolves them to canonical form.
 *
 * @param {{ resources?: readonly string[] }} call
 * @returns {readonly string[]}
 */
export function readTargetPaths(call) {
  const resources = call && call.resources;
  if (!Array.isArray(resources)) return [];
  return resources.filter((r) => typeof r === "string" && r.length > 0);
}

/**
 * Find the file paths that a shell command reads or runs (docs/how-it-works.md §5.1).
 *
 * A shell command carries its own text, so the reviewer sees the command. When that
 * command runs a script, or passes a file to an interpreter, the reviewer must also see
 * the file's content: the command text alone hides what the script does.
 *
 * This is a reader, not a parser. It finds the tokens that look like a path to a file
 * that a shell would open. A token is a candidate when it holds a path separator, a file
 * extension, or a leading `./`. Flags and quoted strings are kept, because a path may
 * contain a space.
 *
 * Two shapes that look like paths but never name one are skipped, because a compound
 * command fills the three-file cap with them before it reaches the real script:
 *
 * - A token starting with `$` is a variable reference or assignment (`$s\run.ps1`,
 *   `$s=C:\dir`); the file it names is known only at run time.
 * - A token with more than one colon is a remote spec (`jack:C:/Users/Public/x.ps1`); a
 *   Windows drive is one colon.
 *
 * @param {string} command
 * @returns {readonly string[]} candidate paths, in the order they appear
 */
export function readScriptPaths(command) {
  if (typeof command !== "string" || command.length === 0) return [];
  const paths = [];
  const consider = (token) => {
    if (token === "" || token.startsWith("-") || token.startsWith("$")) return;
    // A remote spec (`jack:C:/Users/Public/x.ps1`) is two colons; a Windows drive is one.
    if ((token.match(/:/g) || []).length > 1) return;
    if (looksLikePath(token) && !paths.includes(token)) paths.push(token);
  };
  for (const token of tokeniseCommand(command)) {
    consider(token);
    // A quoted compound command arrives as one token, and the script it names sits inside
    // it. The parts are candidates too; the whole token stays a candidate, so a path with
    // a space in it survives.
    if (token.includes(" ")) for (const part of token.split(/\s+/)) consider(part);
  }
  // A script usually appears before its arguments, and the cap keeps the request small.
  return paths.slice(0, 3);
}

/** Whether a path names a script, which the gate must read before the command runs it. */
export function isScriptPath(path) {
  return typeof path === "string" && SCRIPT_EXTENSION.test(path);
}

/**
 * The directory that a shell command runs in, when the command states one.
 *
 * A command such as `git -C /repo rm -q src/x.js` names `src/x.js` relative to `/repo`, not
 * relative to the directory that the gate happens to run in. Reading the wrong file leaves
 * the reviewer with the command text alone, which is how deleting a file that the request
 * did explain looked unexplained (docs/how-it-works.md §5.1).
 *
 * This reads the forms that name a directory explicitly:
 *
 * | Form | Example |
 * | --- | --- |
 * | `-C <dir>` | `git -C /repo rm -q src/x.js` |
 * | `cd <dir>` | `cd /repo && rm src/x.js` |
 * | `Set-Location <dir>` | `Set-Location /repo; Remove-Item src/x.js` |
 * | `--prefix=<dir>` | `git --prefix=/repo rm src/x.js` |
 *
 * It is a reader, not a shell parser: a directory built at run time is not found, and the
 * caller then reads the path as written.
 *
 * @param {string} command
 * @returns {string} the directory as written, or an empty string
 */
export function readCommandBase(command) {
  if (typeof command !== "string" || command.length === 0) return "";
  const tokens = tokeniseCommand(command);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const lower = token.toLowerCase();
    if ((lower === "-c" || lower === "--prefix") && i + 1 < tokens.length) {
      const value = tokens[i + 1];
      if (looksLikeDirectory(value)) return value;
    }
    if (lower.startsWith("--prefix=")) {
      const value = token.slice("--prefix=".length);
      if (looksLikeDirectory(value)) return value;
    }
    if (lower === "cd" || lower === "set-location" || lower === "push-location") {
      const value = tokens[i + 1];
      if (value && looksLikeDirectory(value)) return value;
    }
  }
  return "";
}

/**
 * Whether a token names a directory rather than a shell operator or a flag.
 *
 * `cd ..` and `cd ~` are directories. `cd &&` is not: the tokeniser keeps the operator as
 * its own token, and joining a path onto `&&` would produce a path that does not exist.
 */
function looksLikeDirectory(token) {
  if (typeof token !== "string" || token === "") return false;
  if (token.startsWith("-")) return false;
  if (token === "&&" || token === "||" || token === ";" || token === "|") return false;
  return token.includes("/") || token.includes("\\") || token === ".." || token === "." || token.startsWith("~") || /^[a-z]:$/i.test(token);
}

/**
 * Whether a token names a file that a shell would open.
 *
 * A separator is the strongest signal. A known script or data extension is the next. A
 * bare word such as `src` is not a path: it is an argument, and reading it as a path
 * would put a directory listing in front of the reviewer.
 */
function looksLikePath(token) {
  if (token.includes("/") || token.includes("\\")) return true;
  return SCRIPT_EXTENSION.test(token);
}

/** Extensions whose content a shell command can run, source, or read. */
const SCRIPT_EXTENSION = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|py|rb|pl|php|js|mjs|cjs|ts|json|ya?ml|toml|env|ini|cfg|conf|sql)$/i;

/**
 * A command that destroys a whole filesystem, a home directory, or a drive
 * (docs/how-it-works.md §4.4).
 *
 * This is the one deterministic deny for a shell call. It does not judge alignment: a
 * command that removes everything cannot be the user's intent in a reviewable way, and a
 * model that approves it has failed. The check runs before the reviewer, so the outcome
 * does not depend on a model.
 *
 * The check is deliberately narrow. It matches a catastrophic target, not a destructive
 * verb: `rm -rf ./build` is a normal build step, and `rm -rf /` is not.
 *
 * @param {string} command
 * @returns {{ reason: string, detail: string } | null} the match, or null
 */
export function detectCatastrophe(command) {
  if (typeof command !== "string" || command.length === 0) return null;
  const tokens = tokeniseCommand(command).map((token) => token.toLowerCase());
  if (tokens.length === 0) return null;

  const match = removeRootMatch(tokens) || formatMatch(tokens) || ddMatch(tokens) || forkBombMatch(command);
  return match;
}

/**
 * `rm` with a recursive and force flag, and a target that is a root, a whole home
 * directory, or a whole drive.
 *
 * The flag may be `-rf`, `-fr`, `-r -f`, or `--recursive --force`, in any order. The target
 * may be `/`, `/*`, `~`, `~/*`, `$HOME`, `/home`, `/Users`, `C:\`, or `C:/*`.
 */
function removeRootMatch(tokens) {
  const at = tokens.indexOf("rm");
  if (at === -1) return null;

  const rest = tokens.slice(at + 1);
  const flags = rest.filter((token) => token.startsWith("-"));
  if (!isRecursive(flags) || !isForced(flags)) return null;

  const targets = rest.filter((token) => !token.startsWith("-"));
  for (const target of targets) {
    if (isCatastrophicTarget(target)) {
      return { reason: "catastrophic_delete", detail: `rm ${target}` };
    }
  }
  return null;
}

/** Whether a flag list asks for recursion. */
function isRecursive(flags) {
  return flags.some((flag) => flag === "--recursive" || (/^-[a-z]+$/i.test(flag) && flag.includes("r")));
}

/** Whether a flag list asks for force. */
function isForced(flags) {
  return flags.some((flag) => flag === "--force" || (/^-[a-z]+$/i.test(flag) && flag.includes("f")));
}

/** Whether a path names a root, a whole home directory, or a whole drive. */
function isCatastrophicTarget(target) {
  const value = target.replace(/^["']|["']$/g, "").trim();
  if (value === "" || value === "." || value === "..") return false;

  // A root path: `/`, `/*`, `//`, or a drive root such as `c:\` or `c:/*`.
  if (/^\/+\*?$/.test(value)) return true;
  if (/^[a-z]:[\\/]*\*?$/.test(value)) return true;

  // A whole home directory, or the directory that holds every home directory.
  const bare = value.replace(/[\\/]+\*?$/, "");
  return HOME_TARGETS.has(bare);
}

/** Paths whose removal takes a whole user tree with it. */
const HOME_TARGETS = Object.freeze(new Set([
  "~", "$home", "${home}", "%userprofile%", "/home", "/users", "/root", "/var", "/etc", "/usr", "/bin", "/boot", "/lib", "/opt", "/srv", "/sys", "/proc",
]));

/**
 * A whole-partition format: `mkfs.*` on a device, or `format` on a drive.
 */
function formatMatch(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (/^mkfs(\.[a-z0-9]+)?$/.test(token)) return { reason: "catastrophic_format", detail: token };
    if (token === "diskpart") return { reason: "catastrophic_format", detail: "diskpart" };
    if (token === "format" && tokens.slice(i + 1).some((t) => /^[a-z]:$/.test(t))) {
      return { reason: "catastrophic_format", detail: "format" };
    }
  }
  return null;
}

/** A raw write that overwrites a device. */
function ddMatch(tokens) {
  const at = tokens.indexOf("dd");
  if (at === -1) return null;
  const target = tokens.slice(at + 1).find((token) => token.startsWith("of="));
  if (!target) return null;
  const device = target.slice(3);
  if (DEVICE_PATTERN.test(device)) return { reason: "catastrophic_write", detail: `dd of=${device}` };
  return null;
}

/** A path that names a block device or a physical drive. */
const DEVICE_PATTERN = /^\/(dev\/(sd|nvme|hd|vd|disk|mmcblk)|dev\/disk)|\/dev\/(sd|nvme|hd|vd|disk)[a-z0-9]*$|^\\\\\.\\physicaldrive/i;

/** The classic shell fork bomb. */
function forkBombMatch(command) {
  if (/:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;?\s*:/.test(command)) {
    return { reason: "catastrophic_fork_bomb", detail: "fork bomb" };
  }
  return null;
}
