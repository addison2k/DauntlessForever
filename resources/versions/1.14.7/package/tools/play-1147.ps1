# Dauntless Forever - Dauntless 1.14.7 offline package
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# play-1147.ps1 - start the Dauntless 1.14.7 game itself, with its own private settings folder and the offline sign-in.
# Normally started by "2 - PLAY.bat" (tools\start.ps1) after the backend and the server are up.
# Waits until you close the game, then puts the logs into upload\client_logs.zip (PC name and user name blanked).
# -JoinHost <address>: play on another PC's game (LAN - JOIN.bat); -EosDirOverride: the sign-in settings for that.
param([string]$JoinHost = '', [string]$EosDirOverride = '')
. (Join-Path $PSScriptRoot 'common.ps1')
function Set-EosName([string]$Ini, [string]$Name) {
    $lines = if (Test-Path -LiteralPath $Ini) { @(Get-Content -LiteralPath $Ini) } else { @('; eos_offline settings. Lines starting with ; are comments.') }
    $done = $false
    $lines = @(foreach ($l in $lines) { if ($l -match '^DisplayName=') { if (-not $done) { "DisplayName=$Name"; $done = $true } } else { $l } })
    if (-not $done) { $lines += "DisplayName=$Name" }
    [System.IO.File]::WriteAllText($Ini, (($lines -join "`r`n") + "`r`n"), [System.Text.Encoding]::ASCII)
}

$cfg = Get-Config
if (-not $cfg) { Fail 'set-up has not been run yet. Double-click "1 - SETUP.bat" first.' }
$Bin      = Join-Path $cfg.GameDir 'Archon\Binaries\Win64'
$Exe      = Join-Path $Bin 'Dauntless-Win64-Shipping.exe'
$GameEos  = Join-Path $Bin 'EOSSDK-Win64-Shipping.dll'
$HomeDir  = Join-Path $Root 'home'
$EosDir   = if ($EosDirOverride) { $EosDirOverride } else { Join-Path $Root 'eos' }
# Your player name comes from the launcher (one name for every version): the game reads it from eos_offline.ini.
if ($env:DF_PLAYER_NAME -match '^[A-Za-z0-9_]{3,16}$') {
    New-Item -ItemType Directory -Force $EosDir | Out-Null
    Set-EosName (Join-Path $EosDir 'eos_offline.ini') $env:DF_PLAYER_NAME
}
$Stamp    = Get-Date -Format 'yyyyMMdd_HHmmss'
$RunDir   = Join-Path $Root "logs\run_$Stamp"
$Upload   = Join-Path $Root 'upload'
$GameArgs = '-EpicPortal -AUTH_TYPE=accountportal -AUTH_LOGIN=unused -AUTH_PASSWORD=unused'

# --- checks before start
if (@(Get-PlayerGame).Count -gt 0) { Fail 'the game is already running. Close it first.' }
if ((Hash256 $GameEos) -ne $StandInHash) { Fail 'the offline sign-in is not in the game folder (maybe the game was updated or verified). Run "1 - SETUP.bat" again.' }
if ($JoinHost) {
    try { Invoke-RestMethod -Uri "http://${JoinHost}:63000/_recorder/ping" -TimeoutSec 8 | Out-Null } catch { Fail "the host at $JoinHost does not answer. Is their LAN - HOST window open?" }
} else {
    if (-not (Test-Recorder)) { Fail 'the local backend is not running. Start the game with "2 - PLAY.bat".' }
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'data\server.json'))) { Say 'Note: no game server is running, so the game will wait after the opening video.' 'Yellow' }
}

foreach ($d in @($HomeDir, "$HomeDir\AppData\Local", "$HomeDir\AppData\Roaming", "$HomeDir\Documents", $EosDir, $RunDir, $Upload)) { New-Item -ItemType Directory -Force $d | Out-Null }

# --- the backend addresses go into the PRIVATE settings folder only (your normal Dauntless settings are not touched)
$PrivCfg = Join-Path $HomeDir 'AppData\Local\Archon\Saved\Config\WindowsClient'
New-Item -ItemType Directory -Force $PrivCfg | Out-Null
if ($JoinHost) {
    # every backend address points at the host instead of this PC
    $gi = [IO.File]::ReadAllText((Join-Path $Root 'profile\Game.ini')) -replace '127\.0\.0\.1', $JoinHost
    [IO.File]::WriteAllText((Join-Path $PrivCfg 'Game.ini'), $gi, [Text.Encoding]::ASCII)
} else {
    Copy-Item -LiteralPath (Join-Path $Root 'profile\Game.ini') -Destination (Join-Path $PrivCfg 'Game.ini') -Force
}
$eosLog = Join-Path $EosDir 'eos_offline.log'
$eosLogStart = if (Test-Path -LiteralPath $eosLog) { (Get-Item -LiteralPath $eosLog).Length } else { 0 }

# --- start the game with a private home
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Exe
$psi.Arguments = $GameArgs
$psi.WorkingDirectory = $Bin
$psi.UseShellExecute = $false
$psi.EnvironmentVariables['USERPROFILE']     = $HomeDir
$psi.EnvironmentVariables['LOCALAPPDATA']    = "$HomeDir\AppData\Local"
$psi.EnvironmentVariables['APPDATA']         = "$HomeDir\AppData\Roaming"
$psi.EnvironmentVariables['EOS_OFFLINE_DIR'] = $EosDir
$startTime = Get-Date
$p = [Diagnostics.Process]::Start($psi)
Say ''
Say "THE GAME IS STARTING (it can take a minute to show up). Have fun!" 'Green'
Say 'This window waits until you close the game, then shuts everything down for you.'
$p.WaitForExit()
Say "Game closed at $(Get-Date -Format HH:mm:ss)."
Start-Sleep -Seconds 2

# --- collect logs (for asking for help)
try {
    if (Test-Path -LiteralPath $eosLog) {
        $fs = [IO.File]::Open($eosLog, 'Open', 'Read', 'ReadWrite'); $fs.Seek($eosLogStart, 'Begin') | Out-Null
        $sr = New-Object IO.StreamReader($fs); $sr.ReadToEnd() | Set-Content -LiteralPath (Join-Path $RunDir 'eos_offline_this_run.log'); $sr.Close()
    }
    Get-ChildItem -LiteralPath $HomeDir -Recurse -File -Include *.log, *.txt, *.xml, *.runtime-xml -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $startTime.AddMinutes(-1) } |
        ForEach-Object {
            $rel = $_.FullName.Substring($HomeDir.Length).TrimStart('\') -replace '[\\/:]', '_'
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $RunDir $rel)
        }
    # the game itself writes to the real %LOCALAPPDATA%\Archon\Saved (it ignores the private home)
    $realSaved = Join-Path $env:LOCALAPPDATA 'Archon\Saved'
    foreach ($sub in @('Logs', 'Crashes')) {
        $dir = Join-Path $realSaved $sub
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        Get-ChildItem -LiteralPath $dir -Recurse -File -Include *.log, *.txt, *.xml, *.runtime-xml -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -ge $startTime.AddMinutes(-1) } |
            ForEach-Object {
                $rel = 'game_' + ($_.FullName.Substring($realSaved.Length).TrimStart('\') -replace '[\\/:]', '_')
                Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $RunDir $rel)
            }
    }
    foreach ($f in Get-ChildItem -LiteralPath $RunDir -File) {
        $t = Get-Content -LiteralPath $f.FullName -Raw
        if ($null -eq $t) { continue }
        foreach ($s in @($env:COMPUTERNAME, $env:USERNAME) | Where-Object { $_ }) { $t = $t -replace [regex]::Escape($s), 'XXXX' }
        $t = $t -replace 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*', 'JWT_XXXX'
        Set-Content -LiteralPath $f.FullName -Value $t -NoNewline
    }
    $zip = Join-Path $Upload 'client_logs.zip'
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    if (Get-ChildItem -LiteralPath $RunDir -File) { Compress-Archive -Path (Join-Path $RunDir '*') -DestinationPath $zip }
} catch { Say "Could not collect the logs: $($_.Exception.Message)" 'Yellow' }
