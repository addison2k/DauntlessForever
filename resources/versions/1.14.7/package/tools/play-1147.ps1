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
$GameArgs = Add-GameLanguage $GameArgs   # launcher Settings > Game language (the Windows language otherwise)

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
# DF-CHAT-1147: in-game text chat goes to the backend's port 63000 (this PC, or the host when joining on LAN; an online
# joiner's join proxy also listens on 127.0.0.1:63000)
Set-ChatConfig1147 $PrivCfg $(if ($JoinHost) { $JoinHost } else { '127.0.0.1' }) 63000
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
Add-GameMods $psi   # launcher Mods page: UE4SS (-dfmods) and the Boss Health Bar
# Troubleshooting: data\client_log.txt (any content) makes the game write its own log to logs\client_engine.log (the
# shipping game's log file stays empty otherwise). The file's text, if any, is passed as -LogCmds (log categories).
$clientLogSwitch = Join-Path $Root 'data\client_log.txt'
if (Test-Path -LiteralPath $clientLogSwitch) {
    $logCmds = ([IO.File]::ReadAllText($clientLogSwitch)).Trim() -replace '"', ''
    $clientLog = Join-Path $Root 'logs\client_engine.log'
    $extra = ' -stdout -FullStdOutLogOutput' + $(if ($logCmds) { " -LogCmds=`"$logCmds`"" } else { '' })
    $psi.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $psi.Arguments = '/c ""' + $Exe + '" ' + $GameArgs + $psi.Arguments.Substring($GameArgs.Length) + $extra + ' > "' + $clientLog + '" 2>&1"'
    Say "Troubleshooting: the game's log goes to logs\client_engine.log" 'Yellow'
}
$startTime = Get-Date
$p = [Diagnostics.Process]::Start($psi)
Say ''
Say "THE GAME IS STARTING (it can take a minute to show up). Have fun!" 'Green'
Say 'This window waits until you close the game, then shuts everything down for you.'
# DF-FIX4: while the game runs, pass on why a hunt server failed (tools\server-1147.ps1 writes data\server_hunt_failed.json),
# so the launcher can show it under the Play button instead of the game searching with no explanation
$huntFailedFile = Join-Path $Root 'data\server_hunt_failed.json'; $lastFailed = ''
# DF-PARTY-STAY-1147 (Oct 25): the game must not leave or kick party members it wrongly thinks are offline
# (tools\party-stay-1147.ps1). Tried every 6 s while the game starts, for up to 10 minutes; logs\party-stay.log
$partyStayDone = $false; $partyStayTries = 0; $partyStayLog = Join-Path $Root 'logs\party-stay.log'
$partyStayDone = $true   # Oct 26: bin\dxgi.dll makes this change itself now (antivirus programs blocked the script)
while (-not $p.WaitForExit(2000)) {
    if (-not $partyStayDone -and ($partyStayTries++ % 3) -eq 0) {
        try { $partyStayDone = DfPartyStay $startTime $partyStayLog } catch { }
        if ($partyStayTries -gt 300) { $partyStayDone = $true }
    }
    try {
        if (Test-Path -LiteralPath $huntFailedFile) {
            $t = [IO.File]::ReadAllText($huntFailedFile)
            if ($t -ne $lastFailed) { $lastFailed = $t; if ($t -match '"reason":"([^"]*)"') { Write-Host ("HUNT SERVER FAILED: {0}" -f $Matches[1]) -ForegroundColor Red } }
        }
    } catch { }
}
Say "Game closed at $(Get-Date -Format HH:mm:ss)."
Start-Sleep -Seconds 2

# --- collect logs (for asking for help)
try {
    if (Test-Path -LiteralPath $eosLog) {
        $fs = [IO.File]::Open($eosLog, 'Open', 'Read', 'ReadWrite'); $fs.Seek($eosLogStart, 'Begin') | Out-Null
        $sr = New-Object IO.StreamReader($fs); $sr.ReadToEnd() | Set-Content -LiteralPath (Join-Path $RunDir 'eos_offline_this_run.log'); $sr.Close()
    }
    # DF-LOGFILTER (Oct 21): Windows PowerShell ignores -Include next to -LiteralPath, so every new file went into the zip (NVIDIA shader caches, ini files); filtered by extension now
    Get-ChildItem -LiteralPath $HomeDir -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in @('.log', '.txt', '.xml', '.runtime-xml') -and $_.FullName -notmatch '\\(NVIDIA|AMD|D3DSCache|DXCache|GLCache)\\' } |
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
        # DF-LOGFILTER (Oct 21): Windows PowerShell ignores -Include next to -LiteralPath, so every new file went into the zip (NVIDIA shader caches, ini files); filtered by extension now
        Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in @('.log', '.txt', '.xml', '.runtime-xml') -and $_.FullName -notmatch '\\(NVIDIA|AMD|D3DSCache|DXCache|GLCache)\\' } |
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
