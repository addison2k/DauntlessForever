# Dauntless Forever - launcher tools
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# release-launcher.ps1 - tell every player's launcher that a new launcher is out.
#
# FULL release (new installer + zip; needed when Electron, the bundled Node.js, the download tool or the bundled
# server files change, and for the first release with small updates in it):
#   1. bump "version" in package.json      2. npm run dist
#   3. powershell -ExecutionPolicy Bypass -File tools\release-launcher.ps1 -Notes "What changed"
#
# SMALL release (only the launcher's own code and texts changed: src\, credits, patch notes):
#   1. bump "version" in package.json      2. npm run dist:dir   (faster: no installer, no zip)
#   3. powershell -ExecutionPolicy Bypass -File tools\release-launcher.ps1 -Small -Notes "What changed"
#   app-<version>.asar goes into the "packages" release, so the Releases page only lists full releases.
#   Launchers from the last full release on download app-<version>.asar (a few MB) by themselves and use it from
#   their next start ("Restart now" in their banner). Older launchers see the usual Download banner, which opens
#   the last FULL release page.
#
# Both write the "launcher" block in packages.json and print the commands that publish it (release first, push second).
param(
    [string]$Notes = '',
    [switch]$Small
)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$IndexFile = Join-Path $Repo 'packages.json'
$GitHub = 'https://github.com/addison2k/DauntlessForever'

function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Fail($t) { Write-Host ''; Write-Host "STOPPED: $t" -ForegroundColor Yellow; exit 1 }

$ver = (Get-Content -LiteralPath (Join-Path $Repo 'package.json') -Raw | ConvertFrom-Json).version
if (-not $ver) { Fail 'no "version" in package.json' }
$zip = Join-Path $Repo "dist\DauntlessForever-$ver-x64.zip"
$exe = Join-Path $Repo "dist\DauntlessForever-$ver-x64.exe"
$built = Join-Path $Repo 'dist\win-unpacked\resources\app.asar'
if (-not (Test-Path -LiteralPath $built)) { Fail "$built is not there. Run npm run dist (or npm run dist:dir for -Small) first." }
if (Test-Path -LiteralPath "$built.unpacked") { Fail 'the build has an app.asar.unpacked folder: small updates cannot carry it. Make a full release.' }
if (((Get-Date) - (Get-Item -LiteralPath $built).LastWriteTime).TotalHours -gt 6) {
    Say "Note: $built is more than 6 hours old. Did you run the build after changing the version to $ver?" 'Yellow'
}
if (-not $Small -and -not (Test-Path -LiteralPath $zip)) { Fail "$zip is not there. Run npm run dist first (and bump the version in package.json for a new release)." }

$asarName = "app-$ver.asar"
$asar = Join-Path $Repo "dist\$asarName"
Copy-Item -LiteralPath $built -Destination $asar -Force
# DF-PRIVATE (Oct 31): the exact file players download, and the notes they read, must carry no private word
& node (Join-Path $Repo 'tools\check-private.js') --asar $asar
if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $asar -Force; Fail 'the update file contains a private word (see above). packages.json was not changed.' }
if ($Notes) { & node (Join-Path $Repo 'tools\check-private.js') --text $Notes; if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $asar -Force; Fail 'the release notes contain a private word (see above). packages.json was not changed.' } }
$hash = (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash.ToLower()
$size = (Get-Item -LiteralPath $asar).Length

$index = if (Test-Path -LiteralPath $IndexFile) { Get-Content -LiteralPath $IndexFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{ packages = @() } }
$prev = if ($index.PSObject.Properties.Name -contains 'launcher') { $index.launcher } else { $null }

if ($Small) {
    if (-not $prev -or -not ($prev.PSObject.Properties.Name -contains 'app') -or -not $prev.app.minShell) {
        Fail 'there is no earlier release with small updates yet. Make this one a FULL release (without -Small).'
    }
    $minShell = [string]$prev.app.minShell
    $url = [string]$prev.url            # older launchers' Download button: the last full release page
} else {
    $minShell = $ver
    $url = "$GitHub/releases/tag/v$ver"
}
# Small updates go into the existing "packages" release (no new release on the Releases page); full releases carry their own copy
$asarUrl = if ($Small) { "$GitHub/releases/download/packages/$asarName" } else { "$GitHub/releases/download/v$ver/$asarName" }
$app = [pscustomobject]@{ url = $asarUrl; sha256 = $hash; size = $size; minShell = $minShell }
$launcher = [pscustomobject]@{ version = $ver; url = $url; notes = $Notes; date = (Get-Date -Format 'yyyy-MM-dd'); app = $app }
if ($prev) { $index.launcher = $launcher } else { $index | Add-Member -NotePropertyName launcher -NotePropertyValue $launcher }
if (-not ($index.PSObject.Properties.Name -contains 'packages')) { $index | Add-Member -NotePropertyName packages -NotePropertyValue @() }
[IO.File]::WriteAllText($IndexFile, (($index | ConvertTo-Json -Depth 6) + "`n"), (New-Object Text.UTF8Encoding($false)))

Say ''
Say ("packages.json: launcher $ver (" + $(if ($Small) { 'SMALL update' } else { 'FULL release' }) + "), small update file $asarName = $([math]::Round($size / 1MB, 1)) MB, works on launchers $minShell and newer") 'Green'
Say ''
Say 'NEXT, in this order (players see it once both are done):' 'White'
if ($Small) {
    # no new release: the Releases page keeps the last FULL release (installer + zip) on top
    Say "  1. gh release upload packages `"$asar`" --clobber"
} else {
    $files = "`"$zip`" `"$asar`"" + $(if (Test-Path -LiteralPath $exe) { " `"$exe`"" } else { '' })
    Say "  1. gh release create v$ver $files --latest --target main --title `"Dauntless Forever $ver`" --notes `"$Notes`""
}
Say '  2. git add -A'
Say "  3. git commit -m `"Launcher $ver`""
Say '  4. git push'
Say ''
