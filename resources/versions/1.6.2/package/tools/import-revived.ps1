# Dauntless Forever - bring your Dauntless Revived (1.4.4) character into Dauntless Forever 1.6.2
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
#
# Double-click "IMPORT from Dauntless Revived (1.4.4).bat". This script:
#   1. finds your Dauntless Forever 1.6.2 folder (it must be set up, with a character made in game),
#   2. gets your Revived character: from a Dauntless Revived server (it reads your own account through the Revived
#      launcher while the game runs, with your own account key), or from a Revived save on this PC (undaunted.db),
#   3. shows what will be imported, and asks before changing anything,
#   4. imports (your 1.6.2 save is backed up first). Your Revived save is only read, never changed.
param([string]$Source = '', [switch]$Force, [switch]$TutorialOnly, [switch]$Online, [switch]$Local, [int]$RevivedPort = 61000)
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

$js = Join-Path $PSScriptRoot 'import-revived.js'
function PortOpen([int]$p) {
    $c = New-Object Net.Sockets.TcpClient
    try { $r = $c.BeginConnect('127.0.0.1', $p, $null, $null); $ok = $r.AsyncWaitHandle.WaitOne(700) -and $c.Connected; return $ok } catch { return $false } finally { $c.Close() }
}

# 2. The Revived character
# The fix after an import uses the same character file or save the import used.
if ($TutorialOnly -and -not $Source) {
    try {
        $m = @(Get-Content -LiteralPath (Join-Path $pkg 'data\import-revived.json') -Raw | ConvertFrom-Json)
        $last = $m | Where-Object { $_.file -and (Test-Path -LiteralPath $_.file) } | Select-Object -Last 1
        if ($last) { $Source = $last.file; Say "Using what you imported from: $Source" }
    } catch {}
}
if (-not $Source -and -not $Online -and -not $Local) {
    Say 'Where is your Dauntless Revived character?' 'White'
    Say '  1  On a Dauntless Revived server (you play online with the Revived launcher)'
    Say '  2  On this PC (a Revived save file, undaunted.db)'
    $a = Read-Host 'Type 1 or 2 and press Enter'
    if ($a -match '^\s*1') { $Online = $true } elseif ($a -match '^\s*2') { $Local = $true } else { Fail 'Nothing picked. Nothing was changed.' }
}

if ($Online -and -not $Source) {
    Say ''
    Say 'Reading your character from the Dauntless Revived server' 'Cyan'
    Say 'This reads only your own account, with your own account key, the same way your game does.'
    Say 'Nothing on the Revived server is changed, and your key is not saved anywhere by this.'
    Say ''
    while (-not (PortOpen $RevivedPort)) {
        Say 'Start Dauntless with the Dauntless Revived launcher and wait until you are in game.' 'White'
        $a = Read-Host 'Then press Enter (or type Q to stop)'
        if ($a -match '^[Qq]') { Fail 'Stopped. Nothing was changed.' }
    }
    # The Revived launcher keeps a copy of your key in Documents\Dauntless Revived\Account Keys
    $docs = @([Environment]::GetFolderPath('MyDocuments'))
    if ($env:USERPROFILE) { $docs += @((Join-Path $env:USERPROFILE 'Documents'), (Join-Path $env:USERPROFILE 'OneDrive\Documents')) }
    $docs = $docs | Where-Object { $_ } | Select-Object -Unique
    $keyFiles = @(foreach ($d in $docs) { $k = Join-Path $d 'Dauntless Revived\Account Keys'; if (Test-Path -LiteralPath $k) { Get-ChildItem -LiteralPath $k -Filter *.txt -File -ErrorAction SilentlyContinue } }) |
        Sort-Object LastWriteTime -Descending | Select-Object -First 5
    $keyText = ''
    if ($keyFiles.Count) {
        Say "Found the account key the Revived launcher saved for you ($($keyFiles.Count) file(s) in Documents\Dauntless Revived\Account Keys)."
        $a = Read-Host 'Use it to log in? Press Enter for yes, or type N to paste a key yourself'
        if ($a -notmatch '^[Nn]') { $keyText = ($keyFiles | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue }) -join "`n" }
    }
    if (-not $keyText) {
        $sec = Read-Host 'Paste your Revived account key (UUK_...) and press Enter (it stays hidden)' -AsSecureString
        $keyText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    }
    $dir = Join-Path $pkg 'data\import-revived'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $Source = Join-Path $dir ("revived-server-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Say 'Logging in and reading your characters...'
    $keyText | & $node $js fetch --out $Source --port $RevivedPort
    $keyText = $null
    if ($LASTEXITCODE -ne 0) { exit 1 }
    Say ''
    Say 'Got it. Now close Dauntless and the Dauntless Revived launcher (the import needs them closed).' 'White'
    $i = 0
    while (PortOpen $RevivedPort) {
        if ($i % 10 -eq 0) { Say '  waiting for Dauntless Revived to close...' }
        Start-Sleep -Seconds 2; $i++
    }
    Say '  closed.'
}

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
    Say 'Pick your Dauntless Revived save file (undaunted.db), or a Revived character file (.json)...'
    Add-Type -AssemblyName System.Windows.Forms
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Title = 'Your Dauntless Revived save (undaunted.db) or character file (.json)'
    $dlg.Filter = 'Dauntless Revived save or character file|undaunted.db;*.json|All files (*.*)|*.*'
    if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { Fail 'No file picked. Nothing was changed.' }
    $Source = $dlg.FileName
}
if ((Resolve-Path -LiteralPath $Source).Path -ieq (Resolve-Path -LiteralPath (Join-Path $pkg 'data\undaunted.db')).Path) { Fail 'That is your Dauntless Forever save, not the Revived one. Pick the Revived undaunted.db.' }

# Already imported, but the game still plays the tutorial: mark it done (nothing else is changed)
if ($TutorialOnly) {
    Say ''
    Say 'Close Dauntless and the Dauntless Forever launcher first.' 'White'
    & $node $js tutorial $Source --root $pkg
    if ($LASTEXITCODE -ne 0) { exit 1 }
    Say ''
    Say 'Done. Press Play in the launcher, then look in Hunt > Missions and your weapon levels.' 'Green'
    exit 0
}

# 3. What would be imported
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
