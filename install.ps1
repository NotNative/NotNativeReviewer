<#
.SYNOPSIS
    Install NotNativeReviewer into the OpenCode plugin discovery directory.

.DESCRIPTION
    Copies the plugin from this repository's plugin/ directory into the OpenCode global
    config directory, under plugins/<name>/, where <name> is read from plugin/package.json.
    The repository is the single source of the name, so install and uninstall cannot
    disagree about the directory.

    The install target is resolved in this order (docs/install.md,
    section 2):

      1. OPENCODE_CONFIG_DIR, when set and not empty.
      2. XDG_CONFIG_HOME/opencode, when XDG_CONFIG_HOME is set and not empty.
      3. ~/.config/opencode

    Each value is trimmed and resolved to an absolute path. A relative value resolves
    against the current working directory. An empty or whitespace-only value counts as
    unset.

    This script does not edit opencode.json, does not write into the OpenChamber instance
    run directory, does not start or stop OpenCode or OpenChamber, and does not run
    OpenCode.

.PARAMETER Target
    Install to this directory instead of the resolved global config directory. The plugin
    is written to <Target>/plugins/<name>/.

.EXAMPLE
    ./install.ps1

.EXAMPLE
    ./install.ps1 -Target C:\Users\me\.config\opencode
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

# Read the plugin name from the repository's plugin/package.json. The repository is the
# single source of the name: install and uninstall read the same field, so the plugin
# directory is derived from the repository and not from a second hardcoded copy.
function Get-RepoPluginName {
    $repoManifest = Join-Path (Join-Path $RepoRoot 'plugin') 'package.json'
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

function Assert-Source {
    $pluginSrc = Join-Path $RepoRoot "plugin"
    if (-not (Test-Path -LiteralPath $pluginSrc -PathType Container)) {
        Fail "source directory not found: $pluginSrc (run this script from the repository root)"
    }
    foreach ($required in @('package.json', 'index.js')) {
        $path = Join-Path $pluginSrc $required
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            Fail "source file not found: $path"
        }
    }
    return $pluginSrc
}

# List the files to install: every regular file directly in plugin/. The plugin is
# built from modules, so the installer copies what the repository holds and does not
# keep its own list of names.
function Get-PluginSourceFiles([string]$PluginSrc) {
    $files = @()
    try {
        $entries = Get-ChildItem -LiteralPath $PluginSrc -File
    } catch {
        Fail "cannot list $PluginSrc : $($_.Exception.Message)"
    }
    foreach ($entry in $entries) { $files += $entry }
    if ($files.Count -eq 0) { Fail "the source directory $PluginSrc holds no files" }
    return $files
}

# --- Step 1: find the target -------------------------------------------------

$PluginName = Get-RepoPluginName

Write-Host "NotNativeReviewer installer"
Write-Host ""
Write-Host "plugin name      : $PluginName   (from plugin/package.json)"
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
Write-Host "Stop this script now if the plugin directory is not the intended one."
Write-Host ""

# --- Step 2: check the source ------------------------------------------------

$pluginSrc = Assert-Source
$sourceFiles = Get-PluginSourceFiles $pluginSrc
Write-Host "step 2/5  source checked: $pluginSrc ($($sourceFiles.Count) file(s))"
Write-Host ""

# --- Step 3: stage -----------------------------------------------------------

$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$stagingParent = Split-Path -Parent $pluginDir

if (-not (Test-Path -LiteralPath $stagingParent -PathType Container)) {
    try {
        New-Item -ItemType Directory -Path $stagingParent -Force | Out-Null
    } catch {
        Fail "cannot create parent directory $stagingParent : $($_.Exception.Message)"
    }
}

$stagingDir = Join-Path $stagingParent ".$PluginName.staging.$stamp"
if (Test-Path -LiteralPath $stagingDir) {
    try { Remove-Item -LiteralPath $stagingDir -Recurse -Force } catch { Fail "cannot clear stale staging directory $stagingDir" }
}

try {
    New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
    foreach ($file in $sourceFiles) {
        Copy-Item -LiteralPath $file.FullName -Destination $stagingDir -Force
    }
} catch {
    try { Remove-Item -LiteralPath $stagingDir -Recurse -Force } catch { }
    Fail "cannot stage the plugin files into $stagingDir : $($_.Exception.Message)"
}
Write-Host "step 3/5  staged $($sourceFiles.Count) file(s) into $stagingDir"

# The audit log and the reload state are the operator's record of what the gate did and
# what the user asked for. A reinstall replaces the directory, so both are carried into
# the new one instead of being deleted with it.
$telemetryName = "$PluginName-telemetry.jsonl"
$stateName = "$PluginName-state.json"
foreach ($carryName in @($telemetryName, $stateName)) {
    foreach ($candidate in @((Join-Path $stagingParent $carryName), (Join-Path $pluginDir $carryName))) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            try {
                Copy-Item -LiteralPath $candidate -Destination (Join-Path $stagingDir $carryName) -Force
                Write-Host "          carried forward: $carryName"
            } catch {
                try { Remove-Item -LiteralPath $stagingDir -Recurse -Force } catch { }
                Fail "cannot carry $candidate into $stagingDir : $($_.Exception.Message)"
            }
            break
        }
    }
}

# --- Step 4: replace ---------------------------------------------------------

if (Test-Path -LiteralPath $pluginDir) {
    try {
        Remove-Item -LiteralPath $pluginDir -Recurse -Force
    } catch {
        try { Remove-Item -LiteralPath $stagingDir -Recurse -Force } catch { }
        Fail "cannot remove the existing plugin directory $pluginDir : $($_.Exception.Message)"
    }
}

try {
    Move-Item -LiteralPath $stagingDir -Destination $pluginDir
} catch {
    Fail "cannot move the staged directory into $pluginDir : $($_.Exception.Message)"
}
Write-Host "step 4/5  installed into $pluginDir"
Write-Host ""

# --- Step 5: report ----------------------------------------------------------

$version = 'unknown'
$manifestPath = Join-Path $pluginDir 'package.json'
if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    $manifestVersion = Read-ManifestField $manifestPath 'version'
    if (-not [string]::IsNullOrWhiteSpace($manifestVersion)) { $version = $manifestVersion }
} else {
    Write-Host "warning: the installed package.json is missing" -ForegroundColor Yellow
}

# Verify that every staged file arrived. The install is complete only when the count
# matches the source, so a partial copy fails here.
$missing = @()
foreach ($file in $sourceFiles) {
    $installed = Join-Path $pluginDir $file.Name
    if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) { $missing += $file.Name }
}
if ($missing.Count -gt 0) {
    Fail "install verification failed: $($missing -join ', ') missing from $pluginDir"
}

Write-Host "step 5/5  done ($($sourceFiles.Count) file(s) verified)"
Write-Host ""
Write-Host "installed version : $version"
Write-Host "installed path    : $pluginDir"
Write-Host ""
Write-Host "Next step: restart OpenCode. OpenCode loads a plugin when it starts, so this"
Write-Host "install is active after the next start."
Write-Host ""
Write-Host "To verify (docs/install.md, section 5):"
Write-Host "  1. the plugin loads    - look for the setup line in the OpenCode log"
Write-Host "  2. the gate is active  - check the gate status for a session"
Write-Host "  3. a deny reaches the model - request a call the reviewer denies"
exit 0
