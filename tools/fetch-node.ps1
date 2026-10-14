# Dauntless Forever - launcher tools
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# fetch-node.ps1 - put the official portable Node.js (LTS, Windows x64) into resources\runtime\node, so the launcher
# ships it and players never have to install Node.js. "npm run dist" runs this first (predist); it does nothing when
# the folder is already there. Use -Force to fetch the newest LTS of the same major version again.
#
#   powershell -ExecutionPolicy Bypass -File tools\fetch-node.ps1 [-Major 24] [-Force]
#
# Checks: the zip's SHA-256 against nodejs.org's SHASUMS256.txt, and node.exe's Authenticode signature (OpenJS Foundation).
# Keep the same major version between releases: the backend's SQLite module is built for one major version.
param(
    [string]$Major = '24',
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$Repo = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $Repo 'resources\runtime\node'
function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Fail($t) { Write-Host ''; Write-Host "STOPPED: $t" -ForegroundColor Yellow; exit 1 }

if ((Test-Path -LiteralPath (Join-Path $Dest 'node.exe')) -and -not $Force) {
    $have = ''; try { $have = (Get-Content -LiteralPath (Join-Path $Dest 'VERSION') -Raw).Trim() } catch {}
    Say "Bundled Node.js $have is already in resources\runtime\node (use -Force to refresh)." 'Green'
    exit 0
}

Say "Looking up the newest Node.js $Major LTS..." 'Cyan'
$index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
$rel = $index | Where-Object { $_.version -like "v$Major.*" -and $_.lts -and ($_.files -contains 'win-x64-zip') } | Select-Object -First 1
if (-not $rel) { Fail "no Node.js $Major LTS with a Windows x64 zip found on nodejs.org." }
$ver = $rel.version
$name = "node-$ver-win-x64"
$base = "https://nodejs.org/dist/$ver"
$tmp = Join-Path $env:TEMP "df-node-$ver"
if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
New-Item -ItemType Directory -Path $tmp | Out-Null
$zip = Join-Path $tmp "$name.zip"

Say "Downloading $name.zip (about 30 MB)..."
Invoke-WebRequest -Uri "$base/$name.zip" -OutFile $zip -UseBasicParsing
$sums = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing).Content
$line = ($sums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape("$name.zip"))\s*$" } | Select-Object -First 1
if (-not $line) { Fail "SHASUMS256.txt has no entry for $name.zip." }
$want = ($line -split '\s+')[0].Trim().ToUpper()
$got = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToUpper()
if ($want -ne $got) { Fail "the download does not match nodejs.org's checksum (expected $want, got $got)." }
Say "Checksum OK." 'Green'

Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
$src = Join-Path $tmp $name
$sig = Get-AuthenticodeSignature -LiteralPath (Join-Path $src 'node.exe')
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'OpenJS Foundation') {
    Fail "node.exe is not signed by the OpenJS Foundation (status $($sig.Status), signer $($sig.SignerCertificate.Subject))."
}
Say "Signature OK: $($sig.SignerCertificate.Subject -replace ',.*$','')" 'Green'

if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Recurse -Force }
New-Item -ItemType Directory -Path (Split-Path -Parent $Dest) -Force | Out-Null
Move-Item -LiteralPath $src -Destination $Dest
[IO.File]::WriteAllText((Join-Path $Dest 'VERSION'), $ver)
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
Say "Bundled Node.js $ver is in resources\runtime\node. The next npm run dist includes it." 'Green'
