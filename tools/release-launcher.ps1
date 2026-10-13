# release-launcher.ps1 - tell every player's launcher that a new launcher is out.
#
#   powershell -ExecutionPolicy Bypass -File tools\release-launcher.ps1 -Notes "Hunt Pass seasons"
#
# Run it AFTER "npm run dist". It:
#   1. checks dist\DauntlessForever-<version>-x64.zip exists (version comes from package.json)
#   2. writes the "launcher" block in packages.json: { version, url (the release page), notes }
#   3. prints the two commands that publish it (GitHub release first, then the push)
# Launchers read packages.json on start; an older launcher then shows "Dauntless Forever <version> is out" with a
# Download button that opens the release page. Nothing downloads by itself.
param(
    [string]$Notes = ''
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
if (-not (Test-Path -LiteralPath $zip)) { Fail "$zip is not there. Run npm run dist first (and bump the version in package.json for a new release)." }

$index = if (Test-Path -LiteralPath $IndexFile) { Get-Content -LiteralPath $IndexFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{ packages = @() } }
$url = "$GitHub/releases/tag/v$ver"
$launcher = [pscustomobject]@{ version = $ver; url = $url; notes = $Notes; date = (Get-Date -Format 'yyyy-MM-dd') }
if ($index.PSObject.Properties.Name -contains 'launcher') { $index.launcher = $launcher }
else { $index | Add-Member -NotePropertyName launcher -NotePropertyValue $launcher }
if (-not ($index.PSObject.Properties.Name -contains 'packages')) { $index | Add-Member -NotePropertyName packages -NotePropertyValue @() }
[IO.File]::WriteAllText($IndexFile, (($index | ConvertTo-Json -Depth 5) + "`n"), (New-Object Text.UTF8Encoding($false)))
Say ''
Say "packages.json: launcher $ver -> $url" 'Green'
Say ''
Say 'NEXT, in this order (players see the banner once both are done):' 'White'
Say "  1. gh release create v$ver `"$zip`" --title `"Dauntless Forever $ver`" --notes `"$Notes`""
Say "  2. git add -A && git commit -m `"Launcher $ver`" && git push"
Say ''
