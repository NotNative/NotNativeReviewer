<#
.SYNOPSIS
    Remove NotNativeReviewer from the OpenCode plugin discovery directory.

.DESCRIPTION
    Removes <global-config-dir>/plugins/<name>/, where <name> is read from this
    repository's hosts/opencode/plugin/package.json. The repository is the single source of the name, so
    install and uninstall cannot disagree about the directory.

    The global config directory is resolved in this order
    (docs/install.md, section 2):

      1. OPENCODE_CONFIG_DIR, when set and not empty.
      2. XDG_CONFIG_HOME/opencode, when XDG_CONFIG_HOME is set and not empty.
      3. ~/.config/opencode

    The script removes the directory only when its package.json has the same name, so it
    never removes an unrelated directory.

    After uninstall, OpenCode starts without the plugin. The gate is then absent: the
    ungoverned state (docs/uninstall.md, section 4).

.PARAMETER Target
    Remove from this directory instead of the resolved global config directory. The
    directory removed is <Target>/plugins/<name>/.

.EXAMPLE
    ./uninstall.ps1
#>
[CmdletBinding()]
param(
    [string]$Target
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Fail([string]$Message) {
    Write-Host "error: $Message" -ForegroundColor Red
    exit 1
}

# Read one string field from a JSON manifest without assuming a formatting.
function Read-ManifestField([string]$ManifestPath, [string]$Field) {
    try {
        $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
    if ($manifest.PSObject.Properties.Name -contains $Field) {
        return [string]$manifest.$Field
    }
    return $null
}

# Read the plugin name from the repository's hosts/opencode/plugin/package.json. The repository is the
# single source of the name: install and uninstall read the same field, so the plugin
# directory is derived from the repository and not from a second hardcoded copy.
function Get-RepoPluginName {
    $repoManifest = Join-Path (Join-Path (Join-Path $RepoRoot 'hosts') 'opencode\plugin') 'package.json'
    if (-not (Test-Path -LiteralPath $repoManifest -PathType Leaf)) {
        Fail "cannot read the plugin name: $repoManifest is missing (run this script from the repository root)"
    }
    $name = Read-ManifestField $repoManifest 'name'
    if ([string]::IsNullOrWhiteSpace($name)) {
        Fail "cannot read the plugin name: $repoManifest has no 'name' field"
    }
    return $name
}

function Resolve-Dir([string]$Value, [string]$Origin) {
    $trimmed = $Value.Trim()
    if ($trimmed.StartsWith('~')) {
        $rest = $trimmed.Substring(1).TrimStart('\', '/')
        $profile = [Environment]::GetFolderPath('UserProfile')
        if ([string]::IsNullOrEmpty($profile)) { Fail "cannot resolve '~' in ${Origin}: no user profile" }
        $trimmed = if ([string]::IsNullOrEmpty($rest)) { $profile } else { Join-Path $profile $rest }
    }
    # Resolve relative input against the current directory. .NET Framework (Windows
    # PowerShell 5.1) has no two-argument Path.GetFullPath overload, and Path APIs that
    # take a single path treat a relative path as relative to the process directory,
    # which may differ from the current location. So a relative path joins the current
    # location explicitly.
    if (-not [System.IO.Path]::IsPathRooted($trimmed)) {
        try {
            $cwd = (Get-Location).ProviderPath
        } catch {
            Fail "cannot resolve ${Origin} value '$Value': the current location is not a filesystem path"
        }
        if ([string]::IsNullOrEmpty($cwd)) { Fail "cannot resolve ${Origin} value '$Value': no current directory" }
        $trimmed = Join-Path $cwd $trimmed
    }
    try {
        return [System.IO.Path]::GetFullPath($trimmed)
    } catch {
        Fail "cannot resolve ${Origin} value '$Value' to an absolute path"
    }
}

function Get-NonEmptyEnv([string]$Name) {
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) { return $null }
    return $value
}

function Resolve-ConfigDir {
    $configDirEnv = Get-NonEmptyEnv 'OPENCODE_CONFIG_DIR'
    if ($configDirEnv) { return @{ Path = (Resolve-Dir $configDirEnv 'OPENCODE_CONFIG_DIR'); Origin = 'OPENCODE_CONFIG_DIR' } }

    $xdgEnv = Get-NonEmptyEnv 'XDG_CONFIG_HOME'
    if ($xdgEnv) {
        $base = Resolve-Dir $xdgEnv 'XDG_CONFIG_HOME'
        return @{ Path = (Join-Path $base 'opencode'); Origin = 'XDG_CONFIG_HOME' }
    }

    $profilePath = [Environment]::GetFolderPath('UserProfile')
    if ([string]::IsNullOrEmpty($profilePath)) { Fail "cannot resolve the default location: no user profile" }
    return @{ Path = (Join-Path $profilePath '.config\opencode'); Origin = 'default' }
}

# --- Step 1: find the target -------------------------------------------------

$PluginName = Get-RepoPluginName

Write-Host "NotNativeReviewer uninstaller"
Write-Host ""
Write-Host "plugin name      : $PluginName   (from hosts/opencode/plugin/package.json)"
Write-Host ""

if ($Target) {
    $configDir = Resolve-Dir $Target '-Target'
    $origin = '-Target'
} else {
    $resolved = Resolve-ConfigDir
    $configDir = $resolved.Path
    $origin = $resolved.Origin
}

$pluginDir = Join-Path (Join-Path $configDir 'plugins') $PluginName

Write-Host "config directory : $configDir   (from $origin)"
Write-Host "plugin directory : $pluginDir"
Write-Host ""

# --- Step 2: check ownership -------------------------------------------------

if (-not (Test-Path -LiteralPath $pluginDir)) {
    Write-Host "nothing to do: $pluginDir does not exist"
    exit 0
}

if (-not (Test-Path -LiteralPath $pluginDir -PathType Container)) {
    Fail "$pluginDir exists but is not a directory; not removing it"
}

$manifestPath = Join-Path $pluginDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    Fail "$manifestPath is missing; not removing $pluginDir"
}

$ownerName = Read-ManifestField $manifestPath 'name'
if ($ownerName -ne $PluginName) {
    Fail "$manifestPath has name '$ownerName', expected '$PluginName'; not removing $pluginDir"
}
Write-Host "step 2/4  ownership checked: name is $PluginName"

# --- Step 3: keep the audit log ----------------------------------------------
# The log is the operator's only record of what the gate did. Removing the plugin must not
# destroy it, so it moves beside the plugin directory, and the next install adopts it back.

$telemetryName = "$PluginName-telemetry.jsonl"
$telemetryPath = Join-Path $pluginDir $telemetryName
$keptPath = Join-Path (Split-Path -Parent $pluginDir) $telemetryName
if (Test-Path -LiteralPath $telemetryPath -PathType Leaf) {
    try {
        Move-Item -LiteralPath $telemetryPath -Destination $keptPath -Force
    } catch {
        Fail "cannot keep the audit log: move $telemetryPath to $keptPath : $($_.Exception.Message)"
    }
    Write-Host "step 3/4  kept the audit log at $keptPath"
} else {
    Write-Host "step 3/4  no audit log to keep"
}

# The reload state is a cache of the user's own words, not an audit record. Removing the
# gate must not leave that copy behind, so it is deleted here. An install carries it
# forward; only an uninstall drops it.
$statePath = Join-Path $pluginDir "$PluginName-state.json"
if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    try {
        Remove-Item -LiteralPath $statePath -Force
    } catch {
        Fail "cannot remove the reload state $statePath : $($_.Exception.Message)"
    }
    Write-Host "          removed the reload state: $(Split-Path -Leaf $statePath)"
}

# --- Step 4: remove ----------------------------------------------------------

try {
    Remove-Item -LiteralPath $pluginDir -Recurse -Force
} catch {
    Fail "cannot remove $pluginDir : $($_.Exception.Message)"
}

if (Test-Path -LiteralPath $pluginDir) {
    Fail "removal failed: $pluginDir still exists"
}

Write-Host "step 4/4  removed $pluginDir"
Write-Host ""
Write-Host "Next step: restart OpenCode. The plugin is gone after the next start, and the"
Write-Host "gate is absent (the ungoverned state)."
exit 0
