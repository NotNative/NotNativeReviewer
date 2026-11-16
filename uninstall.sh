#!/bin/sh
# Remove NotNativeReviewer from the OpenCode plugin discovery directory.
#
# Removes <global-config-dir>/plugins/<name>/, where <name> is read from this repository's
# plugin/package.json. The repository is the single source of the name, so install and
# uninstall cannot disagree about the directory.
#
# The global config directory is resolved in this order
# (docs/install.md, section 2):
#
#   1. OPENCODE_CONFIG_DIR, when set and not empty.
#   2. $XDG_CONFIG_HOME/opencode, when XDG_CONFIG_HOME is set and not empty.
#   3. ~/.config/opencode
#
# The script removes the directory only when its package.json has the same name, so it
# never removes an unrelated directory.
#
# After uninstall, OpenCode starts without the plugin. The gate is then absent: the
# ungoverned state (docs/uninstall.md, section 4).
#
# Usage: ./uninstall.sh [--target <path>]
#   --target <path>  remove <path>/plugins/<name>/ instead of the plugin directory under
#                    the resolved global config directory.
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

printf 'NotNativeReviewer uninstaller\n\n'
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

# --- Step 2: check ownership -------------------------------------------------

if [ ! -e "$plugin_dir" ]; then
    printf 'nothing to do: %s does not exist\n' "$plugin_dir"
    exit 0
fi

[ -d "$plugin_dir" ] || fail "$plugin_dir exists but is not a directory; not removing it"

manifest="$plugin_dir/package.json"
[ -f "$manifest" ] || fail "$manifest is missing; not removing $plugin_dir"

# Read the package name from the manifest with the same reader the repository name came
# from, so the ownership check and the directory name agree.
owner_name=$(manifest_field "$manifest" name)
[ "$owner_name" = "$PLUGIN_NAME" ] || fail "$manifest has name '$owner_name', expected '$PLUGIN_NAME'; not removing $plugin_dir"
printf 'step 2/3  ownership checked: name is %s\n' "$PLUGIN_NAME"

# --- Step 3: remove ----------------------------------------------------------

rm -rf "$plugin_dir" || fail "cannot remove $plugin_dir"
[ -e "$plugin_dir" ] && fail "removal failed: $plugin_dir still exists"

printf 'step 3/3  removed %s\n\n' "$plugin_dir"
printf 'Next step: restart OpenCode. The plugin is gone after the next start, and the\n'
printf 'gate is absent (the ungoverned state).\n'
exit 0
