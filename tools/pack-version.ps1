# Dauntless Forever - launcher tools
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# pack-version.ps1 - take a tested package folder and make it the launcher's copy of that version,
# plus a small update zip players get without a new launcher build.
#
#   tools\pack-version.ps1 -Id 1.6.2 -From "D:\d162\package\Dauntless-1.6.2-Offline" -Note "fixed hunt rewards"
#
# What it does, in order:
#   1. refuses to pack anything personal (config.json, data, home, logs, backup, upload, eos\eos_offline.ini, .env,
#      node_modules, captures are left out) and scans the text files for your PC name, user name and drive paths
#   2. replaces resources\versions\<id>\package with the folder
#   3. refreshes the DLL hashes in version.json (every installedFiles entry is hashed from bin\<name>)
#      and stamps a new packageVersion (today's date, .2 .3 ... if you pack twice in a day)
#   4. zips package + version.json to dist\packages\<id>-<packageVersion>.zip and records it in packages.json
# Then: commit + push, and upload the zip to the "packages" release (the command is printed at the end).
param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][string]$From,
    [string]$Note = '',
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$VerDir = Join-Path $Repo "resources\versions\$Id"
$VerJson = Join-Path $VerDir 'version.json'
$PkgDir = Join-Path $VerDir 'package'
$IndexFile = Join-Path $Repo 'packages.json'
$OutDir = Join-Path $Repo 'dist\packages'
$ReleaseBase = 'https://github.com/addison2k/DauntlessForever/releases/download/packages'
$LeaveOut = @('config.json', 'data', 'home', 'logs', 'backup', 'upload', 'node_modules', 'captures', '.env', '.package-version', 'eos\eos_offline.ini', 'eos\eos_offline.log')

function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Fail($t) { Write-Host ''; Write-Host "STOPPED: $t" -ForegroundColor Yellow; exit 1 }
function Hash($p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToUpper() }

if (-not (Test-Path -LiteralPath $VerJson)) { Fail "no version.json for $Id at $VerJson. Make one first (copy another version's and edit it)." }
$From = (Resolve-Path -LiteralPath $From).Path
$v = Get-Content -LiteralPath $VerJson -Raw | ConvertFrom-Json
if (-not $v.package) { Fail "version.json for $Id has `"package`": null. Fill in the package section first." }
if (-not (Test-Path -LiteralPath (Join-Path $From $v.package.play))) { Fail "$From does not contain $($v.package.play). Is that the package folder?" }

# ---------------------------------------------------------------- 1. nothing personal
Say ''
Say "=== Packing $Id from $From ===" 'Cyan'
$skipped = @()
foreach ($rel in $LeaveOut) { if (Test-Path -LiteralPath (Join-Path $From $rel)) { $skipped += $rel } }
if ($skipped.Count) { Say "Leaving out (player-made or personal): $($skipped -join ', ')" 'Yellow' }

$needles = @($env:COMPUTERNAME, $env:USERNAME) | Where-Object { $_ -and $_.Length -ge 3 }
$textExt = @('.ps1', '.js', '.ts', '.json', '.txt', '.ini', '.bat', '.md', '.cfg')
Get-ChildItem -LiteralPath $From -Recurse -File -Filter '*.previous' -ErrorAction SilentlyContinue | Remove-Item -Force   # update-dll.ps1 leftovers
$hits = @()
Get-ChildItem -LiteralPath $From -Recurse -File |
    Where-Object { $textExt -contains $_.Extension.ToLower() } |
    Where-Object { $rel = $_.FullName.Substring($From.Length + 1); -not ($LeaveOut | Where-Object { $rel -like "$_*" }) } |
    ForEach-Object {
        $t = Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue
        if (-not $t) { return }
        foreach ($n in $needles) { if ($t -match [regex]::Escape($n)) { $hits += "$($_.FullName): contains '$n'" } }
        # a drive letter on its own (D:\...), not the end of a registry hive name like HKLM:\
        foreach ($m in [regex]::Matches($t, '(?<![A-Za-z])[D-Z]:\\[^\s"''`]{1,60}')) { $hits += "$($_.FullName): path $($m.Value)" }
    }
if ($hits.Count) {
    Say 'Personal strings or fixed paths found:' 'Yellow'
    $hits | Select-Object -Unique | ForEach-Object { Say "  $_" 'Yellow' }
    if (-not $Force) { Fail 'fix them (or run again with -Force if they are harmless, e.g. an example path in the README).' }
}
# DLLs: a Visual Studio Release build embeds the path of its .pdb (your folder layout). Only a warning.
Get-ChildItem -LiteralPath (Join-Path $From 'bin') -Filter '*.dll' -ErrorAction SilentlyContinue | ForEach-Object {
    $bytes = [IO.File]::ReadAllBytes($_.FullName)
    $ascii = [Text.Encoding]::ASCII.GetString($bytes)
    $m = [regex]::Match($ascii, '[A-Z]:\\[^\x00]{3,120}\.pdb')
    if ($m.Success) { Say "  note: bin\$($_.Name) embeds its build path ($($m.Value)). Harmless; to remove it set Linker > Debugging > Generate Debug Info = No, or /PDBALTPATH:%_PDB%." 'DarkYellow' }
}

# ---------------------------------------------------------------- 2. copy in (skipped when -From IS the package folder)
$inPlace = ((Resolve-Path -LiteralPath $From).Path.TrimEnd('\') -ieq (Resolve-Path -LiteralPath $PkgDir -ErrorAction SilentlyContinue).Path.TrimEnd('\'))
if ($inPlace) {
    Say 'Packing the package folder in place (no copy).'
    # the .previous DLL copies update-dll.ps1 keeps must not ship
    Get-ChildItem -LiteralPath (Join-Path $PkgDir 'bin') -Filter '*.previous' -ErrorAction SilentlyContinue | Remove-Item -Force
} else {
if (Test-Path -LiteralPath $PkgDir) { Remove-Item -LiteralPath $PkgDir -Recurse -Force }
New-Item -ItemType Directory -Force $PkgDir | Out-Null
Get-ChildItem -LiteralPath $From -Recurse -Force | ForEach-Object {
    $rel = $_.FullName.Substring($From.Length + 1)
    if ($LeaveOut | Where-Object { $rel -eq $_ -or $rel -like "$_\*" }) { return }
    $dst = Join-Path $PkgDir $rel
    if ($_.PSIsContainer) { New-Item -ItemType Directory -Force $dst | Out-Null }
    else { New-Item -ItemType Directory -Force (Split-Path -Parent $dst) | Out-Null; Copy-Item -LiteralPath $_.FullName -Destination $dst -Force }
}
$n = (Get-ChildItem -LiteralPath $PkgDir -Recurse -File).Count
Say "Copied $n files into resources\versions\$Id\package" 'Green'
}

# ---------------------------------------------------------------- 3. hashes + packageVersion
foreach ($f in $v.package.installedFiles) {
    $leaf = Split-Path -Leaf $f.rel
    $src = Join-Path $PkgDir "bin\$leaf"
    if (-not (Test-Path -LiteralPath $src)) { Fail "version.json says set-up installs $($f.rel) but the package has no bin\$leaf" }
    $h = Hash $src
    if ($h -ne $f.sha256.ToUpper()) { Say "  $leaf changed: $($f.sha256.Substring(0,8))... -> $($h.Substring(0,8))..." 'Yellow' } else { Say "  $leaf unchanged" }
    $f.sha256 = $h
}
# the package's own common.ps1 must agree with us (it is what set-up and play check against)
$common = Join-Path $PkgDir 'tools\common.ps1'
if (Test-Path -LiteralPath $common) {
    $ct = Get-Content -LiteralPath $common -Raw
    foreach ($f in $v.package.installedFiles) { if ($ct -notmatch $f.sha256) { Say "  WARNING: tools\common.ps1 does not contain the hash of $(Split-Path -Leaf $f.rel). Set-up will refuse its own file. Fix common.ps1." 'Red'; if (-not $Force) { Fail 'hash mismatch between version.json and common.ps1' } } }
    if ($ct -match "\`$ExeHash\s*=\s*'([0-9A-Fa-f]{64})'" -and $Matches[1].ToUpper() -ne $v.exeSha256.ToUpper()) { Fail "exe hash in common.ps1 ($($Matches[1].Substring(0,8))...) differs from version.json ($($v.exeSha256.Substring(0,8))...)" }
}
$today = Get-Date -Format 'yyyy-MM-dd'
$old = "$($v.package.packageVersion)"
$pv = $today
if ($old -like "$today*") { $k = 2; if ($old -match "\.(\d+)$") { $k = [int]$Matches[1] + 1 }; $pv = "$today.$k" }
$v.package.packageVersion = $pv
$json = $v | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText($VerJson, ($json + "`n"), (New-Object Text.UTF8Encoding($false)))
Say "version.json: packageVersion $old -> $pv" 'Green'

# ---------------------------------------------------------------- 4. zip + index
New-Item -ItemType Directory -Force $OutDir | Out-Null
$zip = Join-Path $OutDir "$Id-$pv.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $PkgDir '*'), $VerJson -DestinationPath $zip -CompressionLevel Optimal
$zh = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
$index = if (Test-Path -LiteralPath $IndexFile) { Get-Content -LiteralPath $IndexFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{ packages = @() } }
$entry = [pscustomobject]@{ id = $Id; packageVersion = $pv; url = "$ReleaseBase/$Id-$pv.zip"; sha256 = $zh; date = $today; note = $Note }
$list = @($index.packages | Where-Object { $_.id -ne $Id }) + @($entry)
$index.packages = @($list | Sort-Object { [version]($_.id) })
[IO.File]::WriteAllText($IndexFile, (($index | ConvertTo-Json -Depth 5) + "`n"), (New-Object Text.UTF8Encoding($false)))
Say "Zip: $zip ($([math]::Round((Get-Item $zip).Length / 1KB)) KB, sha256 $($zh.Substring(0,12))...)" 'Green'
Say "packages.json updated." 'Green'

Say ''
Say 'NEXT, in this order (players only see the update once all three are done):' 'White'
Say "  1. gh release upload packages `"$zip`" --clobber        (first time: gh release create packages --title `"Server file updates`" --notes `"Downloaded by the launcher. Do not delete.`")"
Say "  2. git add -A && git commit -m `"$Id server files $pv`" && git push"
Say "  3. (optional) npm run dist when you also want a fresh launcher download to carry it"
Say ''
