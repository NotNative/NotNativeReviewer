<#
.SYNOPSIS
    Install NotNativeReviewer into the OpenCode plugin discovery directory.

.DESCRIPTION
    Copies the plugin from this repository's hosts/opencode/plugin directory (with the core from src/nnr) into the OpenCode global
    config directory, under plugins/<name>/, where <name> is read from the adapter package.json.
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

.PARAMETER Harness
    Attach to this harness by name (for example -Harness opencode). Without it, the
    installer proceeds directly when one adapter exists, and asks when several do.

.PARAMETER DshProfile
    The DSH profile(s) to attach to: one name, or a comma list. Default: every
    profile that already exists in the user's DSH home (the Desktop app's, the
    CLI's, headless, custom); a machine with no profiles yet falls back to web.

.EXAMPLE
    ./install.ps1

.EXAMPLE
    ./install.ps1 -Target C:\Users\me\.config\opencode

.EXAMPLE
    ./install.ps1 -Harness opencode

.EXAMPLE
    ./install.ps1 -Harness dsh -DshProfile web
#>
[CmdletBinding()]
param(
    [string]$Target,
    [string]$Harness,
    [string]$DshProfile = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Fail([string]$Message) {
    Write-Host "error: $Message" -ForegroundColor Red
    exit 1
}

# Read one string field from a JSON manifest without assuming a formatting.
function Read-ManifestField([string]$ManifestPath, [string]$Field) {    try {
        $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
    if ($manifest.PSObject.Properties.Name -contains $Field) {
        return [string]$manifest.$Field
    }
    return $null
}

# Read the plugin name from the selected adapter's package.json. The repository is the
# single source of the name: install and uninstall read the same field, so the plugin
# directory is derived from the repository and not from a second hardcoded copy.
function Get-RepoPluginName([string]$AdapterSrc) {
    $repoManifest = Join-Path $AdapterSrc 'package.json'
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

function Assert-Source([string]$AdapterSrc) {
    # Two source trees: the host adapter (hosts/<harness>/plugin) and the core it loads
    # (src/nnr). The adapter is what the host's loader reads; the core travels with it
    # as the nnr/ subdirectory of the installed plugin.
    $coreSrc = Join-Path $RepoRoot "src\nnr"
    if (-not (Test-Path -LiteralPath $AdapterSrc -PathType Container)) {
        Fail "source directory not found: $AdapterSrc (run this script from the repository root)"
    }
    if (-not (Test-Path -LiteralPath $coreSrc -PathType Container)) {
        Fail "core directory not found: $coreSrc"
    }
    foreach ($required in @('package.json', 'index.js', 'core.js')) {
        $path = Join-Path $AdapterSrc $required
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            Fail "source file not found: $path"
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $coreSrc 'version.js') -PathType Leaf)) {
        Fail "core file not found: $(Join-Path $coreSrc 'version.js')"
    }
    return @($AdapterSrc, $coreSrc)
}

# List the files to install: exactly the manifest's own list. The adapter's
# package.json "files" entries name what ships — adapter files at the root, core
# files as nnr/<name> — so nothing beside them (a development state file, a local
# audit log) can ride into an install. The manifest is the list; the directories
# are only where the named files are found.
function Get-PluginSourceFiles($Dirs) {
    $pluginSrc = $Dirs[0]
    $coreSrc = $Dirs[1]
    $manifest = Get-Content -LiteralPath (Join-Path $pluginSrc 'package.json') -Raw | ConvertFrom-Json
    $listed = @($manifest.files) + @('package.json')
    if ($listed.Count -eq 0) { Fail "the adapter manifest lists no files: $(Join-Path $pluginSrc 'package.json')" }
    $files = @()
    foreach ($relative in $listed) {
        $source = if ($relative -like 'nnr/*') {
            Join-Path $coreSrc ($relative -replace '^nnr/', '')
        } else {
            Join-Path $pluginSrc $relative
        }
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            Fail "a listed file is missing from the source: $relative ($source)"
        }
        $files += @{ File = (Get-Item -LiteralPath $source); Relative = $relative }
    }
    return $files
}

# The hosts this repository can attach to. NNR is a parasite: it latches onto the
# harness the user runs. A host is attachable when its adapter directory exists in the
# repository; it is detected when the harness appears installed on this machine.
# Detection is information, not a gate — a first install of a harness whose directories
# do not exist yet is still legitimate.
function Get-KnownHosts {
    $userProfile = [Environment]::GetFolderPath('UserProfile')
    @(
        @{
            Name = 'opencode'
            Adapter = Join-Path $RepoRoot 'hosts\opencode\plugin'
            Detect = [bool]($env:OPENCODE_CONFIG_DIR) -or
                     (Test-Path (Join-Path $userProfile '.config\opencode')) -or
                     ((Get-Command opencode -ErrorAction SilentlyContinue) -ne $null)
        },
        @{
            Name = 'dsh'
            Adapter = Join-Path $RepoRoot 'hosts\dsh\plugin'
            Detect = [bool]($env:DSH_HOME) -or
                     (Test-Path (Join-Path $userProfile '.dsh')) -or
                     ((Get-Command dsh -ErrorAction SilentlyContinue) -ne $null)
        }
    )
}

# Choose the host to attach to. An explicit -Harness wins. With one attachable adapter
# the installer proceeds without asking, so the common first-install stays
# non-interactive. With several, the operator is shown what was detected and chooses.
function Select-Host {
    # An adapter is attachable when it is complete: a directory with a package.json.
    # A pending adapter (such as hosts/dsh before its first build) is registered but
    # not offered, so the selection never offers an attachment that cannot load.
    $known = @(Get-KnownHosts | Where-Object {
        (Test-Path -LiteralPath $_.Adapter -PathType Container) -and
        (Test-Path -LiteralPath (Join-Path $_.Adapter 'package.json') -PathType Leaf)
    })
    if ($known.Count -eq 0) {
        Fail "no host adapter exists under hosts/ (run this script from the repository root)"
    }
    if ($Harness) {
        $chosen = $known | Where-Object { $_.Name -eq $Harness }
        if (-not $chosen) {
            Fail "unknown harness '$Harness'; this repository can attach to: $($known.Name -join ', ')"
        }
        return $chosen
    }
    if ($known.Count -eq 1) { return $known[0] }

    Write-Host "Attachable harnesses:"
    for ($i = 0; $i -lt $known.Count; $i++) {
        $state = if ($known[$i].Detect) { 'detected on this machine' } else { 'not detected on this machine' }
        Write-Host ("  [{0}] {1}  ({2})" -f ($i + 1), $known[$i].Name, $state)
    }
    $answer = Read-Host "Select the harness to attach to [1-$($known.Count)]"
    $index = 0
    if (-not [int]::TryParse($answer, [ref]$index) -or $index -lt 1 -or $index -gt $known.Count) {
        Fail "selection '$answer' is not one of 1..$($known.Count)"
    }
    return $known[$index - 1]
}

# Stage the source files into a directory: adapter files at the root, core files
# under nnr/. Returns the count staged. The caller creates and clears the directory.
function Stage-SourceFiles([string]$StagingDir, $SourceFiles) {
    New-Item -ItemType Directory -Path $StagingDir -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $StagingDir 'nnr') -Force | Out-Null
    foreach ($file in $SourceFiles) {
        $destination = Join-Path $StagingDir ($file.Relative -replace '/', '\')
        Copy-Item -LiteralPath $file.File.FullName -Destination $destination -Force
    }
    return $SourceFiles.Count
}

# The central NNR home: one directory that holds the packages the hosts attach to,
# so an update of the core reaches every attached host at its next restart. Each
# host's audit log and reload state live under it, keyed by host, because no two
# live hosts may ever share one state file.
function Get-NNRHome {
    $base = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($base)) {
        Fail "cannot resolve the install home: LOCALAPPDATA is not set"
    }
    return (Join-Path $base 'notnativereviewer')
}

# Attach the staged package to a DSH profile.
#
# The desktop application manages its plugins in the profile's own patch layer,
# cordis.patch.yml (observed live, 2026-11-17): insert rows with id, name, and
# config, applied after every bundle layer. That is the attachment this installer
# writes — one row for the adapter, its config filled from the profile's own
# agent-default-model row when one exists, so the reviewer judges with the same
# model the conversation uses. The package directory is junctioned into the
# profile's node_modules so the row's module specifier resolves. No CLI and no
# bundle-list entry: a bundle would load the plugin twice, and the Electron-managed
# profile refuses the CLI anyway.
function Attach-Dsh([string]$PackageDir, [string]$ProfileName) {
    Write-Host "step 4/5  attaching into the profile patch layer (profile $ProfileName)"
    $dshHome = $env:DSH_HOME
    if ([string]::IsNullOrWhiteSpace($dshHome)) {
        $profile = [Environment]::GetFolderPath('UserProfile')
        $dshHome = Join-Path $profile '.dsh'
    }
    $profileDir = Join-Path (Join-Path $dshHome 'profiles') $ProfileName
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null

    # 1. The junction: the row's module name resolves through the profile's
    #    node_modules, which is where the loader looks.
    $linkDir = Join-Path (Join-Path $profileDir 'node_modules') $PluginName
    try {
        if (Test-Path -LiteralPath $linkDir) { Remove-Item -LiteralPath $linkDir -Force -Recurse }
        New-Item -ItemType Junction -Path $linkDir -Target $PackageDir | Out-Null
    } catch {
        Fail "cannot link $PackageDir into $linkDir : $($_.Exception.Message)"
    }

    # 2. Migrate an older attachment out of the bundle list, so the plugin loads
    #    exactly once. The harness's own bundles are never touched.
    $manifestPath = Join-Path $profileDir 'package.json'
    if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
        try {
            $raw = Get-Content -LiteralPath $manifestPath -Raw
            if ($raw -match '"bundles"') {
                $manifest = $raw | ConvertFrom-Json
                if ($manifest.dsh -and $manifest.dsh.profile) {
                    # An empty array as an if-branch value collapses to $null under
                    # StrictMode; build with += so an empty bundle list stays a list.
                    $current = @()
                    if ($manifest.dsh.profile.bundles -is [array]) {
                        foreach ($bundle in $manifest.dsh.profile.bundles) { $current += [string]$bundle }
                    } elseif ($null -ne $manifest.dsh.profile.bundles) {
                        $current += [string]$manifest.dsh.profile.bundles
                    }
                    $kept = @()
                    foreach ($bundle in $current) { if ($bundle -ne $PluginName) { $kept += $bundle } }
                    if ($kept.Count -ne $current.Count) {
                        $manifest.dsh.profile.bundles = $kept
                        $json = $manifest | ConvertTo-Json -Depth 10
                        $keptLiteral = '[' + (($kept | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ', ') + ']'
                        $json = $json -replace '("bundles"\s*:\s*)"[^"]*"', ('$1' + $keptLiteral)
                        [System.IO.File]::WriteAllText($manifestPath, $json)
                        Write-Host "          migrated out of the bundle list"
                    }
                }
            }
        } catch {
            Fail "cannot clean the bundle list in $manifestPath : $($_.Exception.Message)"
        }
    }

    # 3. The patch row. The patch layer's rows are id-targeted overrides of entries
    #    the base bundle already defines; a NEW plugin is an `insert` row (observed
    #    live, 2026-11-17: a plain row is silently treated as an override of an
    #    entry that does not exist and is dropped). The module name is relative to
    #    the profile directory, where the junction sits — the loader anchors its
    #    import base there, and a relative name needs no resolution machinery.
    #    An existing insert row is left alone (the operator may have tuned the
    #    config); older shapes are migrated; a fresh row takes the profile's own
    #    default model, so the reviewer judges with the model the conversation uses.
    $patchPath = Join-Path $profileDir 'cordis.patch.yml'
    $moduleName = "./node_modules/$PluginName/index.js"
    try {
        $patch = if (Test-Path -LiteralPath $patchPath -PathType Leaf) { Get-Content -LiteralPath $patchPath -Raw } else { "" }
        $insertRow = @"
- insert:
    - id: $PluginName
      name: $moduleName
      config:
        provider: `"{0}`"
        model: `"{1}`"
"@
        if ($patch -match '(?m)^-\s*insert:\s*$' -and $patch -match "(?m)^\s+-\s*id:\s*$PluginName\s*$") {
            Write-Host "          the patch row already exists; config left as the operator set it"
            return
        }
        if ($patch -match "(?m)^-\s*id:\s*$PluginName\s*$") {
            # An older shape: a plain row, which the loader reads as an override and
            # drops. Its config values are carried into the insert row.
            $oldProvider = ""
            $oldModel = ""
            if ($patch -match '(?s)- id: notnativereviewer\b.*?provider:\s*"?([^\r\n"]*)"?\s*\r?\n\s*model:\s*"?([^\r\n"]*)"?\s*\r?\n') {
                $oldProvider = $Matches[1]
                $oldModel = $Matches[2]
            }
            $row = $insertRow -f $oldProvider, $oldModel
            $pattern = "(?ms)^- id: " + $PluginName + "\b.*?(?=^- |\z)"
            $migrated = [System.Text.RegularExpressions.Regex]::Replace($patch, $pattern, ($row + "`r`n"))
            [System.IO.File]::WriteAllText($patchPath, $migrated)
            Write-Host "          migrated the plain row into an insert row"
            return
        }
        $provider = ""
        $model = ""
        if ($patch -match '(?s)-\s*id:\s*agent-default-model\b.*?provider:\s*"?([^\r\n"]+?)"?\s*\r?\n\s*model:\s*"?([^\r\n"]+?)"?\s*\r?\n') {
            $provider = $Matches[1].Trim()
            $model = $Matches[2].Trim()
        }
        $row = $insertRow -f $provider, $model
        # An untouched profile's patch layer is the template `[]` — a scalar, not an
        # array to append to. Appending after it makes the file two YAML documents,
        # which the loader refuses. An empty or empty-template layer is therefore
        # REPLACED by the row; a layer with real rows is appended to.
        $trimmed = $patch.Trim()
        if ($trimmed -eq "" -or $trimmed -eq "[]") {
            $patch = "# NotNativeReviewer (added by the NotNativeReviewer installer). The reviewer model" + "`r`n" +
                "# follows the profile's own default; edit it here to judge with a different model." + "`r`n" + $row
        } else {
            $patch = $patch.TrimEnd() + "`r`n`r`n# NotNativeReviewer (added by the NotNativeReviewer installer). The reviewer model" + `
                "`r`n# follows the profile's own default; edit it here to judge with a different model." + "`r`n" + $row
        }
        [System.IO.File]::WriteAllText($patchPath, $patch)
        if ($model -ne "") {
            Write-Host "          reviewer model follows the profile default: $provider / $model"
        } else {
            Write-Host "          no profile default model found; the reviewer stays unconfigured (the operator decides consequential calls)"
        }
    } catch {
        Fail "cannot edit the patch layer $patchPath : $($_.Exception.Message)"
    }
    Write-Host "          attached into $profileDir"
}

# Install into a DSH profile: stage the package into the central home, carry the
# state and telemetry forward, replace the package directory, and attach.
function Install-DshHost {
    $pluginSrcDirs = Assert-Source $AdapterSrc
    $sourceFiles = Get-PluginSourceFiles $pluginSrcDirs
    Write-Host "step 2/5  source checked: $($pluginSrcDirs -join ', ') ($($sourceFiles.Count) file(s))"

    $homeRoot = Get-NNRHome
    $packageDir = Join-Path (Join-Path $homeRoot 'dsh') $PluginName
    $stamp = Get-Date -Format 'yyyyMMddHHmmss'
    $stagingDir = Join-Path $homeRoot ".staging.$stamp"

    $telemetryName = "$PluginName-telemetry.jsonl"
    $stateName = "$PluginName-state.json"
    try {
        Stage-SourceFiles $stagingDir $sourceFiles | Out-Null
        foreach ($carryName in @($telemetryName, $stateName)) {
            $candidate = Join-Path (Join-Path $packageDir 'nnr') $carryName
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                Copy-Item -LiteralPath $candidate -Destination (Join-Path (Join-Path $stagingDir 'nnr') $carryName) -Force
                Write-Host "          carried forward: nnr/$carryName"
            }
        }
        if (Test-Path -LiteralPath $packageDir) { Remove-Item -LiteralPath $packageDir -Recurse -Force }
        New-Item -ItemType Directory -Path (Split-Path -Parent $packageDir) -Force | Out-Null
        Move-Item -LiteralPath $stagingDir -Destination $packageDir
    } catch {
        try { Remove-Item -LiteralPath $stagingDir -Recurse -Force } catch { }
        Fail "cannot stage into $packageDir : $($_.Exception.Message)"
    }
    Write-Host "step 3/5  staged $($sourceFiles.Count) file(s) into $packageDir"

    # The profiles to attach: every profile that exists in the user's DSH home, so
    # a Desktop-only machine gets the desktop profile, a CLI machine gets web, and
    # a machine with both gets both. -DshProfile pins one or a comma list, and a
    # machine with no profiles yet falls back to web, which the harness creates.
    $profiles = @()
    if ($DshProfile) {
        foreach ($name in ($DshProfile -split ',')) {
            $trimmedName = $name.Trim()
            if ($trimmedName -ne "") { $profiles += $trimmedName }
        }
    } else {
        $dshHome = $env:DSH_HOME
        if ([string]::IsNullOrWhiteSpace($dshHome)) {
            $dshHome = Join-Path [Environment]::GetFolderPath('UserProfile') '.dsh'
        }
        $profilesDir = Join-Path $dshHome 'profiles'
        if (Test-Path -LiteralPath $profilesDir -PathType Container) {
            foreach ($dir in (Get-ChildItem -LiteralPath $profilesDir -Directory)) {
                if (Test-Path -LiteralPath (Join-Path $dir.FullName 'package.json') -PathType Leaf) {
                    $profiles += $dir.Name
                }
            }
        }
        if ($profiles.Count -eq 0) { $profiles = @('web') }
    }
    Write-Host "step 4/5  attaching to profile(s): $($profiles -join ', ')"
    foreach ($profileName in $profiles) {
        Attach-Dsh $packageDir $profileName
    }

    $version = Read-ManifestField (Join-Path $packageDir 'package.json') 'version'
    Write-Host "step 5/5  done ($($sourceFiles.Count) file(s) staged)"
    Write-Host ""
    Write-Host "installed version : $version"
    Write-Host "package directory : $packageDir"
    Write-Host "dsh profiles      : $($profiles -join ', ')"
    Write-Host ""
    Write-Host "Next step: restart the harness. Each profile loads the attachment at"
    Write-Host "start, so this attach is active after the next start."
    exit 0
}

# --- Step 1: find the target -------------------------------------------------

$SelectedHost = Select-Host
$AdapterSrc = $SelectedHost.Adapter
$PluginName = Get-RepoPluginName $AdapterSrc

Write-Host "NotNativeReviewer installer"
Write-Host ""
Write-Host "attaching to     : $($SelectedHost.Name)   (adapter: hosts/$($SelectedHost.Name)/plugin)"
Write-Host "plugin name      : $PluginName   (from the adapter package.json)"
Write-Host ""

# Each host has its own attachment. The DSH host attaches through the harness's own
# profile machinery and exits; the OpenCode path continues below.
if ($SelectedHost.Name -eq 'dsh') { Install-DshHost }

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

$pluginSrcDirs = Assert-Source $AdapterSrc
$sourceFiles = Get-PluginSourceFiles $pluginSrcDirs
Write-Host "step 2/5  source checked: $($pluginSrcDirs -join ', ') ($($sourceFiles.Count) file(s))"
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
    $stagedCount = Stage-SourceFiles $stagingDir $sourceFiles
} catch {
    try { Remove-Item -LiteralPath $stagingDir -Recurse -Force } catch { }
    Fail "cannot stage the plugin files into $stagingDir : $($_.Exception.Message)"
}
Write-Host "step 3/5  staged $stagedCount file(s) into $stagingDir"

# The audit log and the reload state are the operator's record of what the gate did and
# what the user asked for. A reinstall replaces the directory, so both are carried into
# the new one instead of being deleted with it.
$telemetryName = "$PluginName-telemetry.jsonl"
$stateName = "$PluginName-state.json"
# The core owns both files, and the core lives in nnr/ of the installed plugin. An
# install older than the core split kept them at the plugin root; that location is a
# candidate too, so an upgrade carries the record forward instead of dropping it.
foreach ($carryName in @($telemetryName, $stateName)) {
    $carried = $false
    foreach ($candidate in @(
        (Join-Path $stagingParent $carryName),
        (Join-Path $pluginDir $carryName),
        (Join-Path (Join-Path $pluginDir 'nnr') $carryName)
    )) {
        if (-not $carried -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            try {
                Copy-Item -LiteralPath $candidate -Destination (Join-Path (Join-Path $stagingDir 'nnr') $carryName) -Force
                Write-Host "          carried forward: nnr/$carryName"
                $carried = $true
            } catch {
                try { Remove-Item -LiteralPath $stagingDir -Recurse -Force } catch { }
                Fail "cannot carry $candidate into $stagingDir : $($_.Exception.Message)"
            }
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
    $installed = Join-Path $pluginDir ($file.Relative -replace '/', '\')
    if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) { $missing += $file.Relative }
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
