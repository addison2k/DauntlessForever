# Dauntless Forever - remove duplicate one-copy items (lanterns, weapon mods, cosmetics) from your 1.6.2 save
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# The cleanup itself is KombatKing's (tools\inventory-deduplicate162.cjs, All-in-One R10). Licence: AGPL-3.0-only.
#
# Double-click "FIX duplicate items.bat". Mostly needed after a Revived (1.4.4) import from before Oct 16, which could
# add a second copy of things you already had. It looks first and shows what it found, asks before changing anything,
# backs up the whole save, keeps the best copy of each item and keeps your equipped loadouts pointing at it.
# Only your own account is changed. Normal weapons and armour, cells, materials and currencies are never touched.
$ErrorActionPreference = 'Stop'
function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Fail($t) { Write-Host ''; Write-Host "STOPPED: $t" -ForegroundColor Yellow; Write-Host ''; exit 1 }

Say ''
Say '=== Remove duplicate items from your Dauntless Forever 1.6.2 save ===' 'Cyan'
Say ''
$here = Split-Path -Parent $PSScriptRoot
$cands = @($here, "$env:LOCALAPPDATA\DauntlessForever\versions\1.6.2", "$env:LOCALAPPDATA\DauntlessOffline\versions\1.6.2")
$pkg = $cands | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'data\undaunted.db')) -and (Test-Path -LiteralPath (Join-Path $_ 'tools\inventory-deduplicate162.cjs')) } | Select-Object -First 1
if (-not $pkg) { Fail 'No Dauntless Forever 1.6.2 save was found on this PC.' }
$node = $null
try { $node = (Get-Content -LiteralPath (Join-Path $pkg 'config.json') -Raw | ConvertFrom-Json).Node } catch {}
if (-not $node -or -not (Test-Path -LiteralPath $node)) {
    $c = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($c) { $node = $c.Source }
}
if (-not $node) { Fail 'Node.js was not found. Open the Dauntless Forever launcher and run Set up for 1.6.2 once, then try again.' }
$js = Join-Path $pkg 'tools\inventory-deduplicate162.cjs'

function Run([string]$mode) {
    $out = & $node $js $mode 2>&1 | Out-String
    if ($LASTEXITCODE) { Fail ($out.Trim()) }
    try { return ($out | ConvertFrom-Json) } catch { Fail ("Unexpected answer: " + $out.Trim()) }
}

Say 'Looking for duplicates (nothing is changed yet)...'
$r = Run 'check'
$total = [int]$r.extra_instances + [int]$r.extra_unlock_rows + [int]$r.unlock_quantities_above_one
if ($total -eq 0) {
    Say ''
    Say "No duplicates found ($($r.characters_scanned) character(s) checked). Nothing to do." 'Green'
    Say ''
    exit 0
}
Say ''
Say "Found in $($r.characters_affected) of your $($r.characters_scanned) character(s):" 'White'
Say "  Extra copies of one-copy items (lanterns, mods, cosmetics): $($r.extra_instances)"
Say "  Unlocks listed twice:                                        $($r.extra_unlock_rows)"
Say "  Unlocks with a count above 1:                                $($r.unlock_quantities_above_one)"
Say ''
Say 'The best copy of each item stays (the highest level), and your loadouts keep pointing at it.'
Say 'Weapons, armour, cells, materials and currencies are not touched. Your whole save is backed up first.'
Say 'Close the game and its servers before you go on.' 'Yellow'
$a = Read-Host 'Remove the duplicates? Type Y and press Enter'
if ($a -notmatch '^\s*[yY]') { Say 'Nothing was changed.'; exit 0 }
$r = Run 'clean'
Say ''
Say "Done. Removed $($r.extra_instances) extra copies and fixed $([int]$r.extra_unlock_rows + [int]$r.unlock_quantities_above_one) unlocks." 'Green'
if ($r.backup) { Say "Backup of your save before the change: $($r.backup)" }
Say 'Start the game as usual.'
Say ''
