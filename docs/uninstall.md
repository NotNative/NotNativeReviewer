# Uninstall NotNativeReviewer

The uninstaller removes the plugin directory from the OpenCode config directory. After the
next OpenCode start, the gate is gone.

---

## 1. Uninstall

Run the script for your platform from the repository root.

**Windows, PowerShell:**

```powershell
./uninstall.ps1
```

**macOS and Linux:**

```sh
./uninstall.sh
```

### 1.1 What the script does

1. It reads the plugin name from `hosts/opencode/plugin/package.json` in this repository.
2. It resolves the config directory the same way the installer does (Â§2), and appends
   `plugins/<name>/`.
3. It checks that the directory holds a `package.json` with that same name.
4. It moves `notnativereviewer-telemetry.jsonl`, when the directory holds one, to
   `<config-dir>/plugins/notnativereviewer-telemetry.jsonl`, so the audit log is not
   destroyed with the plugin. The next install adopts it back.
5. It removes the directory and reports the path.

The ownership check is what makes the script safe. The script removes a directory only
when that directory says, in its own `package.json`, that it is NotNativeReviewer. A directory
with another name, or with no manifest, is left alone and the script stops.

### 1.2 What the script does not do

- It does not remove the config directory itself.
- It does not edit `opencode.json` or any other config file.
- It does not remove another plugin.
- It does not start or stop OpenCode or OpenChamber.

## 2. Which directory it removes

The script resolves the same path the installer used:

1. `OPENCODE_CONFIG_DIR`, when it is set and not empty.
2. `$XDG_CONFIG_HOME/opencode`, when `XDG_CONFIG_HOME` is set and not empty.
3. `~/.config/opencode`.

The directory removed is `<global-config-dir>/plugins/notnativereviewer/`.

### 2.1 Uninstall from a chosen directory

If you installed with `-Target` or `--target`, uninstall with the same option:

```powershell
./uninstall.ps1 -Target D:\configs\opencode
```

```sh
./uninstall.sh --target /opt/configs/opencode
```

## 3. Restart OpenCode

OpenCode loads a plugin when it starts. The plugin is gone after the next OpenCode start.

## 4. After uninstall: the ungoverned state

With the plugin removed, OpenCode starts without a gate. Every tool call runs with the
permission decision that the OpenCode configuration made, and nothing reviews it against
the user's request.

That absence is not a bug. It is the **ungoverned state**, and it is the honest description
of a host with no gate. The product states it plainly rather than pretending a missing
reviewer means a safe call.

## 5. What the script leaves behind

| Item | State |
| --- | --- |
| The config directory | Present, unchanged |
| Every config file in it | Present, unchanged |
| Other plugins under `plugins/` | Present, unchanged |
| The `plugins/notnativereviewer/` directory | Removed |
| Conversation history | Unchanged; the gate never wrote to it |
| Telemetry records already written | Kept; the log moves to `<config-dir>/plugins/notnativereviewer-telemetry.jsonl` |
| The reload state (`notnativereviewer-state.json`) | Deleted; it holds the user's own words, not an audit record |

The log is the operator's record, not the plugin's property, so neither script deletes it.
The uninstaller moves it out of the directory it is about to remove, and the installer
carries it back in, so a reinstall continues the same log. To reclaim the space, delete
that file yourself.

The reload state is the opposite case. An install carries it forward so a test cycle does
not lose the user's authority, but an uninstall deletes it: the file is a cache of what the
user said, and removing the gate should not leave that copy on disk. A reinstall after an
uninstall therefore starts cold, and the next call denies until the user speaks. The file is
kept until that next input, not for a fixed period, so an uninstall and reinstall inside
minutes is the cold start the user actually chose.

## 6. Reinstall

To restore the gate, run the installer again. See [install.md](install.md).

## 7. If the script stops

The script stops with an error rather than guess. Common causes:

| Message | Cause | Action |
| --- | --- | --- |
| `cannot read the plugin name` | `hosts/opencode/plugin/package.json` is missing or has no `name` | Run the script from the repository root |
| `has name '...', expected '...'` | The directory is not NotNativeReviewer | Check the path; the script did not touch the directory |
| `is missing; not removing` | The directory holds no `package.json` | Inspect the directory before you remove it by hand |
| `exists but is not a directory` | A file has the plugin's name | Inspect the path |
| `nothing to do` | The plugin is not installed | No action needed; the exit status is 0 |

In every case the script exits with status 1 for an error and 0 for success or
nothing-to-do. Check the status when you script around it.
