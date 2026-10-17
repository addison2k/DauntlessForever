# Dauntless Forever - fix gear levels on a character imported from Dauntless Revived (1.4.4) before Oct 16
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# The repair itself is KombatKing's (tools\import-gear-repair162.cjs, Revived Gear Conversion 162 R1). Licence: AGPL-3.0-only.
#
# Double-click "FIX imported gear levels.bat". Older imports copied 1.4.4 upgrade levels (+1 to +14) that 1.6.2 does not
# have. This turns that gear into normal crafted gear (+15 becomes power surged) and pays Aethersparks for the lost levels,
# once per item. It needs the Revived export file you imported from and the save backup from BEFORE that import
# (backup\import-revived). It shows what it would do first and asks before changing anything. Gear you changed since the
# import is left alone. Only your own character is changed.
$ErrorActionPreference = 'Stop'
function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Fail($t) { Write-Host ''; Write-Host "STOPPED: $t" -ForegroundColor Yellow; Write-Host ''; exit 1 }

Say ''
Say '=== Fix gear levels on an imported Revived character (Dauntless Forever 1.6.2) ===' 'Cyan'
Say ''
Add-Type -AssemblyName System.Windows.Forms
$here = Split-Path -Parent $PSScriptRoot
$cands = @($here, "$env:LOCALAPPDATA\DauntlessForever\versions\1.6.2", "$env:LOCALAPPDATA\DauntlessOffline\versions\1.6.2")
$pkg = $cands | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'data\undaunted.db')) -and (Test-Path -LiteralPath (Join-Path $_ 'tools\import-gear-repair162.cjs')) } | Select-Object -First 1
if (-not $pkg) { Fail 'No Dauntless Forever 1.6.2 save was found on this PC.' }
if (@(Get-Process -Name 'Dauntless-Win64-Shipping' -ErrorAction SilentlyContinue).Count) { Fail 'Close the game first (and press Stop in the launcher), then run this again.' }
$node = $null
try { $node = (Get-Content -LiteralPath (Join-Path $pkg 'config.json') -Raw | ConvertFrom-Json).Node } catch {}
if (-not $node -or -not (Test-Path -LiteralPath $node)) {
    $c = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($c) { $node = $c.Source }
}
if (-not $node) { Fail 'Node.js was not found. Open the Dauntless Forever launcher and run Set up for 1.6.2 once, then try again.' }
$js = Join-Path $pkg 'tools\import-gear-repair162.cjs'

function Pick([string]$title, [string]$filter, [string]$folder) {
    $d = New-Object System.Windows.Forms.OpenFileDialog
    $d.Title = $title; $d.Filter = $filter
    if ($folder -and (Test-Path -LiteralPath $folder)) { $d.InitialDirectory = $folder }
    try { if ($d.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { Fail 'Cancelled. Nothing was changed.' }; return $d.FileName } finally { $d.Dispose() }
}
Say '1. Pick the Revived character file you imported from (a .json file, usually in data\import-revived).'
$source = Pick 'Your Revived character export (.json)' 'Revived export (*.json)|*.json' (Join-Path $pkg 'data\import-revived')
Say '2. Pick the save backup from BEFORE that import (backup\import-revived\undaunted.db.<date>).'
$before = Pick 'Save backup from before the import' 'Save backup|undaunted.db.*;*.db|All files|*.*' (Join-Path $pkg 'backup\import-revived')

Say ''
Say 'Checking (nothing is changed yet)...'
& $node $js check --root $pkg --source $source --before $before
if ($LASTEXITCODE) { Fail 'The check did not pass. Read the reason above. Nothing was changed.' }
Say ''
$a = Read-Host 'Back up your save and fix the gear listed above? Type Y and press Enter'
if ($a -notmatch '^[Yy]$') { Say 'Cancelled. Nothing was changed.'; exit 0 }
& $node $js repair --root $pkg --source $source --before $before
if ($LASTEXITCODE) { Fail 'The fix stopped. Read the reason above. Your save was not changed.' }
Say ''
Say 'Done. Start 1.6.2 from the launcher to see your gear. (A backup is in backup\import-gear-repair162.)' 'Green'
