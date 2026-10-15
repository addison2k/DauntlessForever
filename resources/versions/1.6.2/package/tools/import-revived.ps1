# Dauntless Forever - bring your Dauntless Revived (1.4.4) character into Dauntless Forever 1.6.2
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
#
# Double-click "IMPORT from Dauntless Revived (1.4.4).bat". This script:
#   1. finds your Dauntless Forever 1.6.2 folder (it must be set up, with a character made in game),
#   2. finds your Revived save (undaunted.db), or lets you pick it,
#   3. shows what will be imported, and asks before changing anything,
#   4. imports (your 1.6.2 save is backed up first). Your Revived save is only read, never changed.
param([string]$Source = '', [switch]$Force)
$ErrorActionPreference = 'Stop'
function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Fail($t) { Write-Host ''; Write-Host "STOPPED: $t" -ForegroundColor Yellow; Write-Host ''; exit 1 }

Say ''
Say '=== Bring your Dauntless Revived (1.4.4) character into Dauntless Forever 1.6.2 ===' 'Cyan'
Say ''

# 1. The Dauntless Forever 1.6.2 folder: this package, or the launcher's install
$here = Split-Path -Parent $PSScriptRoot
$cands = @($here, "$env:LOCALAPPDATA\DauntlessForever\versions\1.6.2", "$env:LOCALAPPDATA\DauntlessOffline\versions\1.6.2")
$pkg = $cands | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'data\undaunted.db')) -and (Test-Path -LiteralPath (Join-Path $_ 'backend\metagame')) } | Select-Object -First 1
if (-not $pkg) { Fail 'Dauntless Forever 1.6.2 is not set up on this PC yet. In the launcher: download 1.6.2, press Play once, make your character, close the game. Then run this again.' }
Say "Dauntless Forever 1.6.2: $pkg"

# Node.js: the one set-up recorded, else the one on this PC
$node = $null
try { $node = (Get-Content -LiteralPath (Join-Path $pkg 'config.json') -Raw | ConvertFrom-Json).Node } catch {}
if (-not $node -or -not (Test-Path -LiteralPath $node)) {
    $c = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($c) { $node = $c.Source }
    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) { if (-not $node -and (Test-Path -LiteralPath $p)) { $node = $p } }
}
if (-not $node) { Fail 'Node.js was not found. Open the Dauntless Forever launcher and run Set up for 1.6.2 once, then try again.' }

# 2. The Revived save
if (-not $Source) {
    $Source = @('C:\dr\data\undaunted.db', 'C:\DauntlessRevived\data\undaunted.db', 'D:\dr\data\undaunted.db') |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($Source) {
        Say "Found a Dauntless Revived save: $Source"
        $a = Read-Host 'Use this one? Press Enter for yes, or type N to pick another file'
        if ($a -match '^[Nn]') { $Source = '' }
    }
}
if (-not $Source) {
    Say 'Pick your Dauntless Revived save file (undaunted.db)...'
    Add-Type -AssemblyName System.Windows.Forms
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Title = 'Your Dauntless Revived save (undaunted.db)'
    $dlg.Filter = 'Dauntless save (undaunted.db)|undaunted.db|All files (*.*)|*.*'
    if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { Fail 'No file picked. Nothing was changed.' }
    $Source = $dlg.FileName
}
if ((Resolve-Path -LiteralPath $Source).Path -ieq (Resolve-Path -LiteralPath (Join-Path $pkg 'data\undaunted.db')).Path) { Fail 'That is your Dauntless Forever save, not the Revived one. Pick the Revived undaunted.db.' }

# 3. What would be imported
$js = Join-Path $PSScriptRoot 'import-revived.js'
Say ''
& $node $js check $Source --root $pkg
if ($LASTEXITCODE -ne 0) { exit 1 }
Say ''
Say 'Close Dauntless and the Dauntless Forever launcher before importing.' 'White'
$a = Read-Host 'Import now? Type Y and press Enter to import, or just press Enter to cancel'
if ($a -notmatch '^[Yy]') { Say 'Cancelled. Nothing was changed.'; exit 0 }

# 4. Import
Say ''
$extra = @(); if ($Force) { $extra += '--force' }
& $node $js import $Source --root $pkg @extra
if ($LASTEXITCODE -ne 0) { exit 1 }
Say ''
Say 'All done. Open the launcher and press Play: your gear is in your armoury. Equip it again (loadouts do not carry over yet).' 'Green'
