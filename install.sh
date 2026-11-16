#!/bin/sh
# Install NotNativeReviewer into the OpenCode plugin discovery directory.
#
# Copies the plugin from this repository's plugin/ directory into the OpenCode global
# config directory, under plugins/<name>/, where <name> is read from plugin/package.json.
#
# The install target is resolved in this order (docs/install.md §3):
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
#                    config directory, where <name> is read from plugin/package.json.
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

# Read the plugin name from the repository's plugin/package.json. The repository is the
# single source of the name: install and uninstall read the same field, so the plugin
# directory is derived from the repository and not from a second hardcoded copy.
read_repo_plugin_name() {
    repo_manifest="$REPO_ROOT/plugin/package.json"
    [ -f "$repo_manifest" ] || fail "cannot read the plugin name: $repo_manifest is missing (run this script from the repository root)"
    name=$(manifest_field "$repo_manifest" name)
    [ -n "$name" ] || fail "cannot read the plugin name: $repo_manifest has no 'name' field"
    printf '%s' "$name"
}

usage() {
    printf 'usage: %s [--target <path>]\n' "$0" >&2
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
        *)
            usage
            ;;
    esac
done

# --- Step 1: find the target -------------------------------------------------

PLUGIN_NAME=$(read_repo_plugin_name)

printf 'NotNativeReviewer installer\n\n'
printf 'plugin name      : %s   (from plugin/package.json)\n\n' "$PLUGIN_NAME"

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

plugin_src="$REPO_ROOT/plugin"
[ -d "$plugin_src" ] || fail "source directory not found: $plugin_src (run this script from the repository root)"
for required in package.json index.js; do
    [ -f "$plugin_src/$required" ] || fail "source file not found: $plugin_src/$required"
done

# The plugin is built from modules. Collect every regular file in plugin/ so the
# installer copies what the repository holds and does not keep its own list of names.
source_files=$(find "$plugin_src" -maxdepth 1 -type f -print | sort)
[ -n "$source_files" ] || fail "the source directory $plugin_src holds no files"
source_count=$(printf '%s\n' "$source_files" | wc -l | tr -d ' ')
printf 'step 2/5  source checked: %s (%s file(s))\n\n' "$plugin_src" "$source_count"

# --- Step 3: stage -----------------------------------------------------------

staging_parent=$(dirname -- "$plugin_dir")
[ -d "$staging_parent" ] || mkdir -p "$staging_parent" || fail "cannot create parent directory $staging_parent"

staging_dir="$staging_parent/.$PLUGIN_NAME.staging.$$"
rm -rf "$staging_dir"
mkdir -p "$staging_dir" || fail "cannot create staging directory $staging_dir"
printf '%s\n' "$source_files" | while IFS= read -r file; do
    [ -f "$file" ] || continue
    cp "$file" "$staging_dir/" || { rm -rf "$staging_dir"; fail "cannot stage $file"; }
done
printf 'step 3/5  staged %s file(s) into %s\n' "$source_count" "$staging_dir"

# The audit log and the reload state are the operator's record of what the gate did and
# what the user asked for. A reinstall replaces the directory, so both are carried into
# the new one instead of being deleted with it.
for carry_name in "$PLUGIN_NAME-telemetry.jsonl" "$PLUGIN_NAME-state.json"; do
    for candidate in "$staging_parent/$carry_name" "$plugin_dir/$carry_name"; do
        if [ -f "$candidate" ]; then
            cp "$candidate" "$staging_dir/$carry_name" || { rm -rf "$staging_dir"; fail "cannot carry $candidate"; }
            printf '          carried forward: %s\n' "$carry_name"
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
staged_count=$(find "$plugin_dir" -maxdepth 1 -type f -print | wc -l | tr -d ' ')
[ "$staged_count" -eq "$source_count" ] \
    || fail "install verification failed: $staged_count of $source_count file(s) in $plugin_dir"

printf 'step 5/5  done (%s file(s) verified)\n\n' "$source_count"
printf 'installed version : %s\n' "$version"
printf 'installed path    : %s\n\n' "$plugin_dir"
printf 'Next step: restart OpenCode. OpenCode loads a plugin when it starts, so this\n'
printf 'install is active after the next start.\n\n'
printf 'To verify (docs/install.md §5):\n'
printf '  1. the plugin loads    - look for the setup line in the OpenCode log\n'
printf '  2. the gate is active  - check the gate status for a session\n'
printf '  3. a deny reaches the model - request a call the reviewer denies\n'
exit 0
