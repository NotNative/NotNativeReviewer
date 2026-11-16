# Install NotNativeReviewer

NotNativeReviewer installs as an OpenCode plugin, through OpenCode's plugin directory
discovery. The installer copies the plugin into a directory that OpenCode already reads.
**No configuration file is edited.**

---

## 1. Before you start

You need:

- OpenCode 2.x.
- The NotNativeReviewer repository on the machine.
- Permission to write into your own OpenCode config directory.

You do not need a second model. The reviewer uses the model that the conversation uses.

## 2. Install

Run the script for your platform from the repository root.

**Windows, PowerShell:**

```powershell
./install.ps1
```

**macOS and Linux:**

```sh
./install.sh
```

The script prints the resolved path before it writes anything. Read that line. Stop the
script if the path is not the one you expect.

### 2.1 What the script does

1. It resolves the target directory (§3).
2. It checks the source: `plugin/package.json` and `plugin/index.js` must exist.
3. It stages every file from `plugin/` into a temporary directory beside the target.
4. It removes an existing plugin directory and moves the staged directory into place.
5. It prints the installed version, the installed path, and the restart requirement.

The script never writes into the live directory in place. OpenCode never reads a
half-written plugin.

### 2.2 What the script does not do

- It does not edit `opencode.json` or any other config file.
- It does not write into OpenChamber's instance run directory.
- It does not start or stop OpenCode or OpenChamber.
- It does not run OpenCode, so install works with OpenCode closed.
- It does not run the local tests in `tools/`, which are not tracked. Run those yourself
  when your copy includes them (§5).

## 3. Where the plugin is installed

The script resolves the OpenCode global config directory in this order:

1. `OPENCODE_CONFIG_DIR`, when it is set and not empty.
2. `$XDG_CONFIG_HOME/opencode`, when `XDG_CONFIG_HOME` is set and not empty.
3. `~/.config/opencode`.

The plugin directory is `<global-config-dir>/plugins/<name>/`, where `<name>` is read from
`plugin/package.json` in this repository. That is `notnativereviewer`. The installer prints the
version it copied.

On a default Windows install the target is:

```
C:\Users\<you>\.config\opencode\plugins\notnativereviewer\
```

The installed directory holds these files:

| File | Role |
| --- | --- |
| `package.json` | Package manifest; names the entrypoint and the version |
| `index.js` | Plugin entrypoint: `{ id, setup }` |
| `hooks.js` | Registration for each host hook |
| `evaluate.js` | The enforcement sequence |
| `floor.js` | Deterministic classification |
| `package.js` | Reviewer package: the conversation text |
| `observation.js` | Read record for read-before-write |
| `questions.js` | Question and page answers, appended to the package |
| `grammar.js` | Decision grammar and failure posture |
| `reviewer.js` | Reviewer prompt and model call |
| `files.js` | The gate's own file access |
| `bytes.js` | Byte measurement |
| `telemetry.js` | The local step log |

### 3.1 Install to a chosen directory

Both scripts accept one option, so you can install somewhere else:

```powershell
./install.ps1 -Target D:\configs\opencode
```

```sh
./install.sh --target /opt/configs/opencode
```

The plugin is written to `<Target>/plugins/<name>/`.

### 3.2 Why the installer edits no config

Three other methods would each require an entry in a file that the user owns:

- an entry on the global `opencode.json` `plugins` array;
- an entry in OpenChamber's managed config, which is deleted when the server exits, so the
  installer cannot own it;
- an entry through the plugin management screen, which writes to the same `opencode.json`.

Directory discovery needs no entry, so there is nothing to add and nothing to forget.

**Accepted cost.** The plugin is always loaded, and it does not appear in OpenChamber's
plugin management screen. To stop the gate, remove the directory. See
[uninstall.md](uninstall.md).
A gate that can be switched off by accident is a gate that can disengage silently.

## 4. Restart OpenCode

OpenCode loads a plugin when it starts. The installed plugin is active after the next
OpenCode start. An install during a running session has no effect on that session.

## 5. Verify

Three checks, in this order. Do not skip the third.

Before the three checks, confirm that the host loads plugins at all. A host in skip-start
mode loads no plugin, and it hides that fact ([how-it-works.md](how-it-works.md) §11). When
`OPENCODE_SKIP_START` is `true` in the host environment, the gate cannot run. Check that
variable first, or run `nna opencode status` and look at `environment.skip_start`.

1. **The plugin loads.** OpenCode writes a line when a plugin's setup runs. The gate writes
   a `setup` record to `notnativereviewer-telemetry.jsonl` in the plugin directory
   ([telemetry.md](telemetry.md) §5). When that record is absent, the plugin did not load,
   and the gate is not governing.
2. **The gate registered its hooks.** The telemetry log shows a `hook.registered` record for
   each hook. A record with `registered: false` marks that hook point as ungoverned. The
   gate enforces at `tool.execute.before`; a missing record for that hook means no call is
   blocked.
3. **A deny reaches the model.** Ask the agent to fetch a page while you have asked only for
   a summary. A deny must appear in the conversation, with a message the model can act on.

Until step 3 passes, the gate is unverified. The gate is not "probably working"; it is
either proven by a deny or unproven.

### 5.1 Run the tests yourself

The tests and the quality gate live in `tools/`, a local development folder that is not
tracked in this repository (see [.gitignore](../.gitignore)). If your copy does not include
it, skip this section.

```sh
node tools/check-quality.mjs
node tools/test-gate.mjs
node tools/check-catastrophe.mjs
```

The first command checks the source against the size and naming rules. The second runs the
gate against a mock host. The third checks the one deny that needs no model: a command that
destroys a system root ([how-it-works.md](how-it-works.md) §4.4). All three must pass before
you trust an install.

### 5.2 Prove a deny with a test posture

Step 3 needs the reviewer to disagree with the agent, which is hard to arrange on purpose. Use
a test posture instead ([how-it-works.md](how-it-works.md) §12).

The shipped `nnr.env` sets both postures to `0`, so a fresh install lets the reviewer
decide each call. To prove a deny, turn the forced close on:

1. Change `NNR_FORCE_DENY=0` to `NNR_FORCE_DENY=1` in
   `<config-dir>/plugins/notnativereviewer/nnr.env`.
2. Restart OpenCode. Every tool call is denied, including reads.
3. Change the value back to `0` and restart to return to the normal gate.

To prove the pair of directions:

1. Ask the agent to tour the codebase. Every call is denied, including the reads.
2. Set `NNR_FORCE_DENY=0` and `NNR_FORCE_ALLOW=1`, then restart.
3. Ask the same question. Every call passes.

The message reaches the agent in the conversation. Set both to `0` and restart to return to
the normal gate.

A shell variable does not reach OpenCode when another program starts it, so use the file.

### 5.3 Check the installed copy without OpenCode

This check uses a local development tool, which is not tracked in the repository. If your
copy does not include `tools/`, skip this section.

`tools/probe-installed.mjs` loads the plugin from the installed directory and drives one
permission event through its hook. It reports the posture and its source, the model named in
the setup record, the effect on an egress call, and the effect on a safe read.

```sh
node tools/probe-installed.mjs
$env:NNR_FORCE_DENY='1'; node tools/probe-installed.mjs
```

The script reads `NNR_INSTALLED` when it is set, then `~/.config/opencode/plugins/notnativereviewer`.

This check proves that the installed files hold the expected code. It does not prove that
OpenCode loaded them. Only §5 step 1 proves that.


## 6. Update

An update is an install over an existing install. Run the installer again.

The installer does not keep a copy of the previous version. To return to an older version,
check out that version in the repository and run the installer.

## 7. Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| No `setup` record in `notnativereviewer-telemetry.jsonl` | The plugin did not load | Confirm the directory is `<config-dir>/plugins/notnativereviewer/` and restart OpenCode. Also confirm that `OPENCODE_SKIP_START` is not set (§5) |
| The telemetry file does not exist | The plugin never ran | The sink writes the file at the first record. Check step 1 of §5 |
| `hook.registered` with `registered: false` | The host does not provide that hook | The gate is partly ungoverned at that point; a call reaches no review there |
| Every call denies | The reviewer cannot answer | Check that the conversation's model is reachable; look for `reviewer_unavailable` in the telemetry file |
| A deny says "no record of the user's request" | The prompt hook did not run for that session | The gate denies rather than guess; report it as a defect |
| The installer stops before writing | The resolved path is not the one you expected | Run the installer with an explicit `-Target` or `--target` |

## 8. Unverified behaviours

The install works against OpenCode's documented behaviour. These points are not yet
confirmed against a live OpenCode 2.3.0 instance:

- Whether OpenCode discovers plugins under `OPENCODE_CONFIG_DIR` when it is set.
- Where OpenCode writes its log on Windows.
- Whether the plugin's `setup` writes a record that the operator can see.
- Whether OpenCode reloads a changed plugin directory, or needs a restart. The installer
  assumes a restart either way, so an update always needs one.

Each one is a check in §5. When a check fails, the gate is ungoverned, and the operator
must see that rather than assume it.

### 8.1 The plugin export shape is verified

The plugin's export is `{ id, setup }`. That shape comes from the host package, not from a
guess. The installed package `@opencode-ai/plugin` holds this code in
`dist/v2/promise/plugin.js`:

```js
export function define(plugin) {
    return plugin;
}
```

`Plugin.define` returns its argument unchanged. The interface that the same package type
checks is:

```ts
interface Plugin {
  readonly id: string;
  readonly setup: (context: PluginContext) => Promise<void> | void;
}
```

The plugin therefore does not import `@opencode/plugin`, and it does not call
`Plugin.define`. Its default export is the object that `Plugin.define` would return.

A `server` field is not necessary. That field belongs to the V1 compatibility form, which
lets one package serve V1 and V2. OpenCode 2 reads `id` and `setup` and ignores `server`.

The installed `index.js` was loaded with a bare `import()` to confirm this. It exports
`{ id: "notnativereviewer", setup }`, and `id` and `setup` have the documented names and types.

