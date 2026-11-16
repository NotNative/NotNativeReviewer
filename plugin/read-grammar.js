/**
 * Read grammar — whether a shell command only reads (docs/how-it-works.md §4.1.3).
 *
 * A shell call carries no declared effect; the command text is the only statement of what
 * it will do. This module answers one question about that text: is it a plain read?
 *
 * The answer is a closed grammar, not a pattern that guesses. One command, no character
 * that chains, redirects, expands, or substitutes, and a verb from a list of readers. A
 * command outside the grammar is not read here at all, so the caller sends it to review,
 * which is where a write belongs. The asymmetry is the guarantee: this module can open a
 * read and can never open a write.
 *
 * No imports.
 */

/** A longer command is not a plain read. It reaches review. */
const MAX_READ_COMMAND = 400;

/**
 * Characters that can chain a second command, redirect output, expand a variable, or
 * substitute a result. A plain read needs none of them.
 */
const SHELL_OPERATOR = /[|;&<>`$()\n\r]/;

/**
 * Whether the text carries an operator outside a literal position.
 *
 * `|`, `;`, `&`, `<`, and `>` are literal inside any quotes, so a search for `"a|b"` is a
 * read. A `$` or a backtick still expands inside double quotes, so those are operators
 * wherever they appear outside single quotes. An unterminated quote is not a plain read.
 */
function hasShellOperator(text) {
  let quote = "";
  for (const character of text) {
    if (quote === "'") {
      if (character === "'") quote = "";
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = "";
      else if (character === "$" || character === "`") return true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (SHELL_OPERATOR.test(character)) return true;
  }
  return quote !== "";
}

/**
 * Verbs that only read. Pagers are absent on purpose: `less` and `more` can run a shell
 * command from their own prompt. Editors and interpreters are absent for the same reason.
 */
const READ_COMMANDS = Object.freeze(new Set([
  // Unix readers and inspectors
  "cat", "head", "tail", "ls", "dir", "tree", "wc", "nl", "stat", "file", "du", "df",
  "pwd", "which", "where", "whereis", "type", "find", "grep", "egrep", "fgrep", "rg",
  "printenv", "whoami", "hostname", "uname", "id", "date", "uptime", "nproc",
  // PowerShell readers
  "get-content", "gc", "select-string", "sls", "get-childitem", "gci", "get-item",
  "get-itemproperty", "get-command", "get-help", "get-location", "get-date",
  "get-filehash", "get-acl", "get-process", "get-service", "resolve-path", "test-path",
]));

/** A flag that writes a file, deletes a match, runs another command, or loads a diff driver. */
const WRITE_FLAG = /^-{1,2}(output|in-place|delete|exec|execdir|ok|okdir|fprint|fprintf|fprint0|fls|pre|pre-glob|ext-diff|textconv)(=|$)/i;

/** Git subcommands that only read. */
const GIT_READ = Object.freeze(new Set([
  "status", "log", "diff", "show", "blame", "rev-parse", "ls-files", "ls-tree",
  "cat-file", "describe", "shortlog", "reflog", "whatchanged", "grep", "show-ref",
  "merge-base", "name-rev", "rev-list", "diff-tree", "diff-files", "count-objects",
  "version", "help",
]));

/** Git flags that only ask for a listing. */
const GIT_BRANCH_LIST = Object.freeze(new Set([
  "-l", "--list", "-a", "--all", "-r", "--remotes", "-v", "--verbose", "--no-color",
  "--color", "--show-current",
]));

/**
 * Git subcommands that read only in their listing form. The listing form is the default
 * when the call names no operand, so `git branch` passes and `git branch -d x` does not.
 */
const GIT_LIST_ONLY = Object.freeze({
  branch: (args) => args.every((arg) => GIT_BRANCH_LIST.has(arg.toLowerCase())),
  remote: (args) => args.length === 0 || args.every((arg) => arg === "-v" || arg === "--verbose"),
  tag: (args) => !args.some((arg) => !arg.startsWith("-")) || /^(-l|--list|-n\d*)$/i.test(args[0] || ""),
  stash: (args) => (args[0] || "").toLowerCase() === "list",
  worktree: (args) => (args[0] || "").toLowerCase() === "list",
  submodule: (args) => (args[0] || "").toLowerCase() === "status",
  config: (args) => args.some((arg) => ["--get", "--get-all", "--list", "-l"].includes(arg.toLowerCase())),
});

/**
 * Whether a shell command only reads.
 *
 * @param {string} command the command text, as written
 * @returns {boolean}
 */
export function isReadOnlyCommand(command) {
  if (typeof command !== "string") return false;
  const text = command.trim();
  if (text === "" || text.length > MAX_READ_COMMAND) return false;
  if (hasShellOperator(text)) return false;

  const tokens = tokeniseCommand(text);
  if (tokens.length === 0) return false;
  const verb = commandName(tokens[0]);
  if (verb === "") return false;
  if (verb === "git") return isReadOnlyGit(tokens.slice(1));
  return READ_COMMANDS.has(verb) && !tokens.slice(1).some((token) => WRITE_FLAG.test(token));
}

/** The command's own name, without a directory, an extension, or case. */
function commandName(token) {
  const parts = String(token).split(/[\\/]/);
  const bare = parts[parts.length - 1] || "";
  return bare.toLowerCase().replace(/\.(exe|com)$/i, "");
}

/**
 * Whether a git invocation only reads. Global flags such as `-C <dir>` and `-c <name>` are
 * skipped to reach the subcommand that decides it.
 */
function isReadOnlyGit(args) {
  let index = 0;
  while (index < args.length) {
    const token = args[index].toLowerCase();
    if (token === "-c" || token === "-C" || token === "--git-dir" || token === "--work-tree") {
      index += 2;
      continue;
    }
    if (token === "--no-pager" || token === "-p" || token.startsWith("--git-dir=") || token.startsWith("--work-tree=")) {
      index += 1;
      continue;
    }
    break;
  }
  const subcommand = (args[index] || "").toLowerCase();
  const rest = args.slice(index + 1);
  if (rest.some((token) => WRITE_FLAG.test(token))) return false;
  if (GIT_READ.has(subcommand)) return true;
  const listing = GIT_LIST_ONLY[subcommand];
  return Boolean(listing && listing(rest));
}

/**
 * Split a command into tokens, and remove the quotes from each.
 *
 * A quoted string stays one token, so a path with a space survives. The quotes are shell
 * syntax, not part of the value, so they are removed: every caller wants the value.
 *
 * @param {string} command
 * @returns {readonly string[]}
 */
export function tokeniseCommand(command) {
  const tokens = [];
  let current = "";
  let quote = "";
  for (const character of command) {
    if (quote !== "") {
      if (character === quote) quote = "";
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current !== "") tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}
