# Dauntless Forever - launcher tools
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# update-dll.ps1 - put a freshly built DLL into a version's package and record its hash.
#
#   tools\update-dll.ps1 -Id 1.6.2 -Dll "D:\Undaunted-main\Undaunted-main\UndauntedInternalServer\x64\Release\UndauntedInternalServer.dll"
#
# What it does:
#   1. checks the DLL exists and was built recently (warns if it is older than an hour: did the build actually run?)
#   2. copies it to resources\versions\<id>\package\bin\<name>  (the old one is kept as <name>.previous)
#   3. finds the hash of the OLD file in the package's tools\common.ps1 and replaces it with the new one,
#      so set-up and play accept the new DLL
#   4. prints the next command (pack-version.ps1), or runs it for you with -Pack
param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][string]$Dll,
    [string]$Note = '',
    [switch]$Pack
)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$PkgDir = Join-Path $Repo "resources\versions\$Id\package"
$Common = Join-Path $PkgDir 'tools\common.ps1'

function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Fail($t) { Write-Host ''; Write-Host "STOPPED: $t" -ForegroundColor Yellow; exit 1 }
function Hash($p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToUpper() }

if (-not (Test-Path -LiteralPath $PkgDir)) { Fail "no package for $Id at $PkgDir" }
if (-not (Test-Path -LiteralPath $Common)) { Fail "no tools\common.ps1 in the $Id package" }
$Dll = (Resolve-Path -LiteralPath $Dll).Path
if (-not (Test-Path -LiteralPath $Dll)) { Fail "DLL not found: $Dll" }
$name = Split-Path -Leaf $Dll
$dst = Join-Path $PkgDir "bin\$name"

Say ''
Say "=== $Id : new $name ===" 'Cyan'
$built = (Get-Item -LiteralPath $Dll).LastWriteTime
$age = (Get-Date) - $built
if ($age.TotalMinutes -lt 90) { $ageText = "$([int]$age.TotalMinutes) min" } else { $ageText = "$([math]::Round($age.TotalHours, 1)) h" }
Say ("Built $ageText ago (" + $built.ToString('yyyy-MM-dd HH:mm') + ")")
if ($age.TotalHours -gt 1) { Say '  That is not very fresh. Did the build run, and in Release x64? (continuing anyway)' 'Yellow' }

$new = Hash $Dll
$old = if (Test-Path -LiteralPath $dst) { Hash $dst } else { '' }
if ($old -eq $new) { Say "bin\${name} is already this exact file ($($new.Substring(0,8))...). Nothing to do." 'Green'; exit 0 }

# ---------------------------------------------------------------- hash in common.ps1
$text = Get-Content -LiteralPath $Common -Raw
if ($old -and $text -notmatch $old) { Fail "tools\common.ps1 does not contain the hash of the current bin\${name} ($($old.Substring(0,8))...). Fix that by hand first; I do not know which line to change." }
if (-not $old) {
    Say "There was no bin\${name} before; add its hash to tools\common.ps1 by hand: $new" 'Yellow'
} else {
    $text = $text -replace $old, $new
    [IO.File]::WriteAllText($Common, $text, [Text.Encoding]::ASCII)
    Say "tools\common.ps1: $($old.Substring(0,8))... -> $($new.Substring(0,8))..." 'Green'
}

# ---------------------------------------------------------------- the file
if (Test-Path -LiteralPath $dst) { Copy-Item -LiteralPath $dst -Destination "$dst.previous" -Force }
Copy-Item -LiteralPath $Dll -Destination $dst -Force
if ((Hash $dst) -ne $new) { Fail 'copy failed (hash differs).' }
Say "bin\${name}: replaced (old one kept as ${name}.previous)" 'Green'
Say "New SHA256: $new"

# ---------------------------------------------------------------- next
$packCmd = "tools\pack-version.ps1 -Id $Id -From `"$PkgDir`""
if ($Note) { $packCmd = $packCmd + " -Note `"$Note`"" }
if ($Pack) {
    Say ''
    & (Join-Path $PSScriptRoot 'pack-version.ps1') -Id $Id -From $PkgDir -Note $Note
} else {
    Say ''
    Say 'NEXT:' 'White'
    Say "  $packCmd"
    Say '  (or run update-dll.ps1 again with -Pack to do it in one go)'
}
