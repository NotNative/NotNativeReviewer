#!/bin/sh
# Install NotNativeReviewer into the OpenCode plugin discovery directory.
#
# Copies the adapter from hosts/opencode/plugin (with the core from src/nnr) into the OpenCode global
# config directory, under plugins/<name>/, where <name> is read from the adapter package.json.
#
# The install target is resolved in this order (docs/install.md Â§3):
#
#   1. OPENCODE_CONFIG_DIR, when set and not empty.
#   2. $XDG_CONFIG_HOME/opencode, when XDG_CONFIG_HOME is set and not empty.
#   3. ~/.config/opencode
#
# Each value is trimmed and resolved to an absolute path. A relative value resolves
# against the current working directory. An empty or whitespace-only value counts as unset.
#
# This script does not edit opencode.json, does not write into the OpenChamber instance
# run directory, does not start or stop OpenCode or OpenChamber, and does not run OpenCode.
#
# Usage: ./install.sh [--target <path>]
#   --target <path>  install to <path>/plugins/<name>/ instead of the resolved global
#                    config directory, where <name> is read from the adapter package.json.
#
# Exit status: 0 on success, 1 on failure.

set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

fail() {
    printf 'error: %s\n' "$1" >&2
    exit 1
}

# Print one string field from a JSON manifest, whether the manifest is pretty-printed or
# written on one line. Leading text on the line (such as an opening brace) is allowed.
manifest_field() {
    tr '{}' '\n\n' < "$1" | tr ',' '\n' \
        | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*\$/\1/p" | head -n 1
}

# Read the plugin name from the selected adapter's package.json; defined at Step 1,
# where the adapter is chosen. The repository is the single source of the name: install
# and uninstall read the same field, so the plugin directory is derived from the
# repository and not from a second hardcoded copy.

usage() {
    printf 'usage: %s [--target <path>] [--host <name>]\n' "$0" >&2
    exit 1
}

# Print the value with leading and trailing whitespace removed.
trim() {
    printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

# Print the absolute form of $1. Relative input resolves against the current directory.
resolve_dir() {
    value=$(trim "$1")
    origin=$2

    case "$value" in
        '~')
            [ -n "${HOME:-}" ] || fail "cannot resolve '~' in $origin: HOME is not set"
            value=$HOME
            ;;
        '~/'*)
            [ -n "${HOME:-}" ] || fail "cannot resolve '~' in $origin: HOME is not set"
            value=$HOME/${value#'~/'}
            ;;
    esac

    case "$value" in
        /*) ;;
        *) value="$(pwd)/$value" ;;
    esac

    printf '%s' "$value"
}

# Print the non-empty value of the named environment variable, or nothing.
non_empty_env() {
    raw=$(printenv "$1" 2>/dev/null || true)
    trimmed=$(trim "$raw")
    [ -n "$trimmed" ] && printf '%s' "$raw"
    return 0
}

TARGET=''
HARNESS=''
while [ $# -gt 0 ]; do
    case "$1" in
        --target)
            [ $# -ge 2 ] || usage
            TARGET=$2
            shift 2
            ;;
        --target=*)
            TARGET=${1#--target=}
            shift
            ;;
        --host)
            [ $# -ge 2 ] || usage
            HARNESS=$2
            shift 2
            ;;
        --host=*)
            HARNESS=${1#--host=}
            shift
            ;;
        *)
            usage
            ;;
    esac
done

# --- Step 1: find the target -------------------------------------------------

# The hosts this repository can attach to. NNR is a parasite: it latches onto the
# harness the user runs. A host is attachable when its adapter directory exists in the
# repository; it is detected when the harness appears installed on this machine.
# Detection is information, not a gate — a first install of a harness whose directories
# do not exist yet is still legitimate. Format: name<tab>adapter<tab>detected(0|1).
known_hosts() {
    for name in opencode dsh; do
        adapter="$REPO_ROOT/hosts/$name/plugin"
        # An adapter is attachable when it is complete: a directory with a
        # package.json. A pending adapter is registered but not offered.
        [ -f "$adapter/package.json" ] || continue
        case "$name" in
            opencode) detected=0
                [ -n "$(non_empty_env OPENCODE_CONFIG_DIR)" ] && detected=1
                [ -d "$HOME/.config/opencode" ] && detected=1
                command -v opencode >/dev/null 2>&1 && detected=1
                ;;
            dsh) detected=0
                [ -n "$(non_empty_env DSH_HOME)" ] && detected=1
                [ -d "$HOME/.dsh" ] && detected=1
                command -v dsh >/dev/null 2>&1 && detected=1
                ;;
        esac
        printf '%s\t%s\t%s\n' "$name" "$adapter" "$detected"
    done
}

select_host() {
    known=$(known_hosts)
    [ -n "$known" ] || fail "no host adapter exists under hosts/ (run this script from the repository root)"
    count=$(printf '%s\n' "$known" | wc -l | tr -d ' ')
    if [ -n "$HARNESS" ]; then
        chosen=$(printf '%s\n' "$known" | while IFS="$(printf '\t')" read -r name adapter detected; do
            [ "$name" = "$HARNESS" ] && printf '%s\t%s' "$name" "$adapter"
        done)
        [ -n "$chosen" ] || fail "unknown harness '$HARNESS'; this repository can attach to: $(printf '%s\n' "$known" | cut -f1 | tr '\n' ' ')"
        printf '%s' "$chosen"
        return 0
    fi
    if [ "$count" -eq 1 ]; then
        printf '%s' "$known"
        return 0
    fi
    printf 'Attachable harnesses:\n'
    printf '%s\n' "$known" | while IFS="$(printf '\t')" read -r name adapter detected; do
        if [ "$detected" = 1 ]; then state='detected on this machine'; else state='not detected on this machine'; fi
        printf '  %s  (%s)\n' "$name" "$state"
    done
    printf 'Select the harness to attach to [1-%s]: ' "$count"
    IFS= read -r answer
    case "$answer" in
        ''|*[!0-9]*) fail "selection '$answer' is not a number" ;;
    esac
    [ "$answer" -ge 1 ] && [ "$answer" -le "$count" ] || fail "selection '$answer' is not one of 1..$count"
    printf '%s' "$known" | sed -n "${answer}p"
}

selected=$(select_host)
SELECTED_NAME=$(printf '%s' "$selected" | cut -f1)
ADAPTER_SRC=$(printf '%s' "$selected" | cut -f2)

# Read the plugin name from the selected adapter's package.json. The repository is the
# single source of the name: install and uninstall read the same field, so the plugin
# directory is derived from the repository and not from a second hardcoded copy.
read_repo_plugin_name() {
    repo_manifest="$ADAPTER_SRC/package.json"
    [ -f "$repo_manifest" ] || fail "cannot read the plugin name: $repo_manifest is missing (run this script from the repository root)"
    name=$(manifest_field "$repo_manifest" name)
    [ -n "$name" ] || fail "cannot read the plugin name: $repo_manifest has no 'name' field"
    printf '%s' "$name"
}

PLUGIN_NAME=$(read_repo_plugin_name)

printf 'NotNativeReviewer installer\n\n'
printf 'attaching to     : %s   (adapter: hosts/%s/plugin)\n' "$SELECTED_NAME" "$SELECTED_NAME"
printf 'plugin name      : %s   (from the adapter package.json)\n\n' "$PLUGIN_NAME"

if [ -n "$TARGET" ]; then
    config_dir=$(resolve_dir "$TARGET" '--target')
    origin='--target'
else
    config_env=$(non_empty_env OPENCODE_CONFIG_DIR)
    if [ -n "$config_env" ]; then
        config_dir=$(resolve_dir "$config_env" 'OPENCODE_CONFIG_DIR')
        origin='OPENCODE_CONFIG_DIR'
    else
        xdg_env=$(non_empty_env XDG_CONFIG_HOME)
        if [ -n "$xdg_env" ]; then
            base=$(resolve_dir "$xdg_env" 'XDG_CONFIG_HOME')
            config_dir="$base/opencode"
            origin='XDG_CONFIG_HOME'
        else
            [ -n "${HOME:-}" ] || fail 'cannot resolve the default location: HOME is not set'
            config_dir="$HOME/.config/opencode"
            origin='default'
        fi
    fi
fi

plugin_dir="$config_dir/plugins/$PLUGIN_NAME"

printf 'config directory : %s   (from %s)\n' "$config_dir" "$origin"
printf 'plugin directory : %s\n\n' "$plugin_dir"
printf 'Stop this script now if the plugin directory is not the intended one.\n\n'

# --- Step 2: check the source ------------------------------------------------

adapter_src="$ADAPTER_SRC"
core_src="$REPO_ROOT/src/nnr"
[ -d "$adapter_src" ] || fail "source directory not found: $adapter_src (run this script from the repository root)"
[ -d "$core_src" ] || fail "core directory not found: $core_src"
for required in package.json index.js core.js; do
    [ -f "$adapter_src/$required" ] || fail "source file not found: $adapter_src/$required"
done
[ -f "$core_src/version.js" ] || fail "core file not found: $core_src/version.js"

# The manifest is the list of what ships: the adapter's package.json "files" entries
# name the adapter files at the root and the core files as nnr/<name>. Nothing beside
# them — a development state file, a local audit log — may ride into an install.
manifest_files() {
    tr -d '\n\r' < "$1" \
        | sed -n 's/.*"files"[[:space:]]*:[[:space:]]*\[\([^][]*\)\].*/\1/p' \
        | tr ',' '\n' \
        | sed -e 's/^[[:space:]]*//' -e 's/"//g' -e '/^$/d'
}

source_files=$(manifest_files "$adapter_src/package.json"; printf '%s\n' 'package.json')
[ -n "$source_files" ] || fail "the adapter manifest lists no files: $adapter_src/package.json"
# Build the copy list as "absolute source<TAB>relative destination".
copy_list=$(printf '%s\n' "$source_files" | while IFS= read -r rel; do
    case "$rel" in
        nnr/*)
            src="$core_src/${rel#nnr/}"
            [ -f "$src" ] || fail "a listed file is missing from the source: $rel ($src)"
            printf '%s\t%s\n' "$src" "$rel"
            ;;
        *)
            src="$adapter_src/$rel"
            [ -f "$src" ] || fail "a listed file is missing from the source: $rel ($src)"
            printf '%s\t%s\n' "$src" "$rel"
            ;;
    esac
done)
source_count=$(printf '%s\n' "$copy_list" | wc -l | tr -d ' ')
printf 'step 2/5  source checked: %s, %s (%s file(s))\n\n' "$adapter_src" "$core_src" "$source_count"

# --- Step 3: stage -----------------------------------------------------------

staging_parent=$(dirname -- "$plugin_dir")
[ -d "$staging_parent" ] || mkdir -p "$staging_parent" || fail "cannot create parent directory $staging_parent"

staging_dir="$staging_parent/.$PLUGIN_NAME.staging.$$"
rm -rf "$staging_dir"
mkdir -p "$staging_dir/nnr" || fail "cannot create staging directory $staging_dir"
printf '%s\n' "$copy_list" | while IFS="$(printf '\t')" read -r src rel; do
    [ -f "$src" ] || continue
    cp "$src" "$staging_dir/$rel" || { rm -rf "$staging_dir"; fail "cannot stage $src"; }
done
printf 'step 3/5  staged %s file(s) into %s\n' "$source_count" "$staging_dir"

# The audit log and the reload state are the operator's record of what the gate did and
# what the user asked for. A reinstall replaces the directory, so both are carried into
# the new one instead of being deleted with it. The core owns both files, and the core
# lives in nnr/; an install older than the core split kept them at the plugin root, so
# that location is a candidate too.
for carry_name in "$PLUGIN_NAME-telemetry.jsonl" "$PLUGIN_NAME-state.json"; do
    for candidate in "$staging_parent/$carry_name" "$plugin_dir/$carry_name" "$plugin_dir/nnr/$carry_name"; do
        if [ -f "$candidate" ]; then
            cp "$candidate" "$staging_dir/nnr/$carry_name" || { rm -rf "$staging_dir"; fail "cannot carry $candidate"; }
            printf '          carried forward: nnr/%s\n' "$carry_name"
            break
        fi
    done
done

# --- Step 4: replace ---------------------------------------------------------

if [ -e "$plugin_dir" ]; then
    rm -rf "$plugin_dir" || { rm -rf "$staging_dir"; fail "cannot remove the existing plugin directory $plugin_dir"; }
fi

mv "$staging_dir" "$plugin_dir" || fail "cannot move the staged directory into $plugin_dir"
printf 'step 4/5  installed into %s\n\n' "$plugin_dir"

# --- Step 5: report ----------------------------------------------------------

version='unknown'
if [ -f "$plugin_dir/package.json" ]; then
    version=$(manifest_field "$plugin_dir/package.json" version)
    [ -n "$version" ] || version='unknown'
fi

# Verify that every staged file arrived, so a partial copy fails here.
missing=$(printf '%s\n' "$copy_list" | while IFS="$(printf '\t')" read -r src rel; do
    [ -f "$plugin_dir/$rel" ] || printf '%s ' "$rel"
done)
[ -z "$missing" ] || fail "install verification failed: $missing missing from $plugin_dir"

printf 'step 5/5  done (%s file(s) verified)\n\n' "$source_count"
printf 'installed version : %s\n' "$version"
printf 'installed path    : %s\n\n' "$plugin_dir"
printf 'Next step: restart OpenCode. OpenCode loads a plugin when it starts, so this\n'
printf 'install is active after the next start.\n\n'
printf 'To verify (docs/install.md Â§5):\n'
printf '  1. the plugin loads    - look for the setup line in the OpenCode log\n'
printf '  2. the gate is active  - check the gate status for a session\n'
printf '  3. a deny reaches the model - request a call the reviewer denies\n'
exit 0
