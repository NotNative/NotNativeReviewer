# Coding discipline

Status: **requirement**. These rules apply to every source file in this repository. They
come from NNA's quality gates, adapted for a product that local models must support.

The reason for hard limits: a local model with a small context window must be able to
read and change one file, and one function, without losing its place. A 2,000-line file
is beyond that window. The limits keep every unit small enough to hold in view.

---

## 1. Hard limits

| Measure | Limit | Check |
| --- | --- | --- |
| Lines in a source file | 500 | `tools/check-quality.mjs` |
| Lines in a function or method | 60 | `tools/check-quality.mjs` |
| Parameters in a function | 4 | Review |
| Nesting depth | 3 | Review |
| Cyclomatic branches in a function | 10 | Review |

A file over 500 lines must be split. A function over 60 lines must be split. The check
script fails the build when either limit is exceeded.

## 2. Names follow the writing standard

Function and process names follow the writing standard that this project uses, which adapts
ASD-STE100: short sentences, active voice, one term for one concept, no rhetoric in
normative text. The same rules apply to a name:

- A function name is a verb phrase for an action: `classifyToolEffect`, `buildReviewerPackage`,
  `validateDecision`. Not `handleStuff`, not `doIt`.
- A function name says what it returns when it returns a value: `readPackageName`, not
  `packageName`.
- A boolean function or value is a state: `isEgressCall`, `hasUserAuthority`. Not
  `checkEgress`.
- A name uses one term for one concept. Do not invent a synonym for a term that the
  documentation already defines.
- A name does not use an abbreviation that the documentation does not define. `sessionID` is
  an exception because the host API spells it that way.

## 3. No imports from the host package

A plugin module imports only:
- other modules in `plugin/`, by relative path;
- JavaScript built-ins.

No module imports `@opencode/plugin`. The plugin loads from a directory where no
`node_modules` exists ([install.md](install.md) §3). Types come from the host at run time,
not from an import.

## 4. Telemetry carries no content

Every log record holds steps, counts, enums, digests, and durations. It does not hold
prompt text, file bytes, tool arguments, or model output. A string longer than 48
characters becomes a digest and a length
([telemetry.js](../plugin/telemetry.js)).

## 5. A failure does not change a decision

Telemetry and ledger writing never throw into the permission hook. A logging failure
must not turn an `allow` into a `deny`, and must not turn a `deny` into an `allow`.

## 6. The check script

The scripts named in this section and in §7 live in the local `tools/` folder, which is not
tracked in the repository. A published clone does not include them.

`tools/check-quality.mjs` reads every `.js` file in `plugin/` and fails when:
- a file has more than 500 lines;
- a function or method body has more than 60 lines;
- a file imports a bare specifier that is not relative and not a built-in.

Run it before an install. The installer does not run it; the operator does.

## 7. Version for each commit

Every commit carries a product version. The version format is `yyyymmdd-<increment>`, where
`yyyymmdd` is the commit date and `<increment>` counts the commits already made on that date.
A date with no commit gets increment 1.

To set the version for a commit:

1. Run `node tools/bump-version.mjs`. It writes `plugin/version.js` and
   `plugin/package.json` together.
2. Commit those two files with the code.
3. End the commit subject with `(version <yyyymmdd>-<increment>)`.

To confirm that the files match git history, run `node tools/bump-version.mjs --check`. The
check passes when the working tree carries the version that the next commit must have. It
fails when either file is stale, or when the two files disagree.

The tool reads the version from `HEAD`, not from the working tree. Thus the check gives the
same answer before and after you commit.

`<increment>` is a count, not a build number. It does not reset at midnight; it starts at 1
for each new date.

Do not write a version into the files by hand. If you do, the two files can disagree.
