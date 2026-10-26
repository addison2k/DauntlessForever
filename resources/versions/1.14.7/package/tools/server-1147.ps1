# Dauntless Forever - Dauntless 1.14.7 offline package
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
<#
server-1147.ps1 - the Dauntless 1.14.7 game server (a second copy of the game in server mode, hidden).
Normally started for you by "2 - PLAY.bat" (tools\start.ps1). By hand, from the package folder:

  -Run       start the server (Ramsgate, UDP port 8780). When the game asks for a place outside the city (training
             grounds, a hunt), a hidden server copy is started on that map (UDP 8781 and up, one per place) and the game travels there.
             Press Q in this window to stop it. Logs go to upload\server_logs.zip (PC name and user name blanked).
  -Stop      close every server copy of the game and clear the marker files in the data folder.
             The player's own game is left alone.

The server loader (dxgi.dll in the game folder) is put there by "1 - SETUP.bat" and does nothing unless this script
starts a server copy.
#>
param(
    [switch]$Run,
    [switch]$Stop,
    [switch]$NoReplication,          # testing: do not send the world to players
    [switch]$NoProgression,          # testing: do not ask the backend for the game-wide progression tables
    [int]$Port = 8780,
    [int]$HuntPort = 8781,           # the second server (places outside the city: training grounds, hunts)
    [switch]$NoSecondServer,         # testing: never start a second server
    [string]$Map = "/Game/Maps/ramsgate/ramsgate_01_persistent",
    [string]$GameMode = "/Game/Blueprints/GameMode/BPGM_City.BPGM_City_C",
    [int]$WaitSeconds = 240
)
. (Join-Path $PSScriptRoot "common.ps1")
function Stop-Here([string]$Message) { Write-Host ""; Write-Host "NOT DONE: $Message" -ForegroundColor Yellow; exit 1 }
$cfg = Get-Config
if (-not $cfg) { Stop-Here 'set-up has not been run yet. Double-click "1 - SETUP.bat" first.' }
$GameDir = $cfg.GameDir
$WorkDir = $Root
$ExpectedHash = $LoaderHash

$exeDir = Join-Path $GameDir "Archon\Binaries\Win64"
$exe = Join-Path $exeDir "Dauntless-Win64-Shipping.exe"
$loader = Join-Path $exeDir "dxgi.dll"
$dataDir = Join-Path $WorkDir "data"
$logDir = Join-Path $WorkDir "logs"
$uploadDir = Join-Path $WorkDir "upload"
$profileIni = Join-Path $WorkDir "profile\Game.ini"
foreach ($d in @($dataDir, $logDir, $uploadDir)) { New-Item -ItemType Directory -Force $d | Out-Null }

if (-not ($Run -or $Stop)) { Stop-Here "say -Run or -Stop" }

# ---------- stop ----------
# Server copies are the ones started with -server on the command line; the player's own game is never touched.
if ($Stop) {
    $copies = @(Get-CimInstance Win32_Process -Filter "Name='Dauntless-Win64-Shipping.exe'" | Where-Object { $_.CommandLine -match '(^|\s)-server(\s|$)' })
    foreach ($c in $copies) { Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "Stopped server copy (pid $($c.ProcessId))." }
    if ($copies.Count -eq 0) { Write-Host "No server copies were running." }
    foreach ($f in @("server.json", "server_hunt.json", "wanted.json")) {
        $fp = Join-Path $dataDir $f
        if (Test-Path -LiteralPath $fp) { Remove-Item -LiteralPath $fp -Force; Write-Host "Cleared data\$f" }
    }
    # DF-PORTS-1147: also anything of 1.14.7 left on its ports (a backend or join helper, from any copy of the package)
    if (-not $Run) { $n = Clear-Ports1147 -NoFail; if ($n) { Write-Host "Closed $n leftover 1.14.7 program(s) on its ports." } }
    $left = @(Get-Process Dauntless-Win64-Shipping -ErrorAction SilentlyContinue)
    Write-Host ("Dauntless processes still running: " + $left.Count + $(if ($left.Count) { " (your own game window)" } else { "" })) -ForegroundColor Green
    if (-not $Run) { exit 0 }
    Start-Sleep -Seconds 2
}
if (-not (Test-Path -LiteralPath $exe)) { Stop-Here "cannot find $exe" }

# ---------- run ----------
if ((Hash256 $loader) -ne $ExpectedHash) { Stop-Here "the server loader is not in the game folder (maybe the game was updated or verified). Run 1 - SETUP.bat again." }
if (-not (Test-Path -LiteralPath $profileIni)) { Stop-Here "cannot find $profileIni. Unzip the package again." }
try { Invoke-RestMethod -Uri "http://127.0.0.1:63000/_recorder/ping" -TimeoutSec 3 | Out-Null }
catch { Stop-Here "the local backend is not answering on port 63000. Use 2 - PLAY.bat, which starts everything in order." }
$marker = Join-Path $dataDir "server.json"
if (Test-Path -LiteralPath $marker) {
    $old = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($old.pid -and (Get-Process -Id $old.pid -ErrorAction SilentlyContinue)) { Stop-Here "a server is already running (pid $($old.pid))" }
    Remove-Item -LiteralPath $marker -Force
}

# the server's private home: its own settings folder, the backend redirects, the start map
$srvHome = Join-Path $WorkDir "srvhome"
$srvLocal = Join-Path $srvHome "AppData\Local"
$srvRoaming = Join-Path $srvHome "AppData\Roaming"
$srvCfg = Join-Path $srvLocal "Archon\Saved\Config\WindowsClient"
$eosDir = Join-Path $WorkDir "eos_srv"
foreach ($d in @($srvLocal, $srvRoaming, (Join-Path $srvHome "Documents"), $srvCfg, $eosDir)) { New-Item -ItemType Directory -Force $d | Out-Null }
Copy-Item -LiteralPath $profileIni -Destination (Join-Path $srvCfg "Game.ini") -Force
$driverIni = @"
[/Script/Engine.GameEngine]
!NetDriverDefinitions=ClearArray
+NetDriverDefinitions=(DefName="GameNetDriver",DriverClassName="/Script/OnlineSubsystemUtils.IpNetDriver",DriverClassNameFallback="/Script/OnlineSubsystemUtils.IpNetDriver")
+NetDriverDefinitions=(DefName="DemoNetDriver",DriverClassName="/Script/Engine.DemoNetDriver",DriverClassNameFallback="/Script/Engine.DemoNetDriver")
+NetDriverDefinitions=(DefName="BeaconNetDriver",DriverClassName="/Script/OnlineSubsystemUtils.IpNetDriver",DriverClassNameFallback="/Script/OnlineSubsystemUtils.IpNetDriver")

[Core.System]
HangsAreFatal=False
"@
$engineIni = "; Written by server-1147.ps1 on every start.`r`n[/Script/EngineSettings.GameMapsSettings]`r`nGameDefaultMap=$Map`r`nServerDefaultMap=$Map`r`nGlobalDefaultGameMode=$GameMode`r`n`r`n" + $driverIni
[System.IO.File]::WriteAllText((Join-Path $srvCfg "Engine.ini"), $engineIni, [System.Text.Encoding]::ASCII)

$srvLog = Join-Path $logDir "server_$Port.log"
$engLog = Join-Path $logDir "server_${Port}_engine.log"
$errLog = Join-Path $logDir "server_${Port}_engine_err.log"
foreach ($f in @($srvLog, $engLog, $errLog)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } }
$crashDir = Join-Path $srvLocal "Archon\Saved\Crashes"
$crashBefore = @(); if (Test-Path -LiteralPath $crashDir) { $crashBefore = @(Get-ChildItem -LiteralPath $crashDir -Directory | ForEach-Object { $_.Name }) }

# environment for the server copy only (this script runs in its own PowerShell process)
$env:USERPROFILE = $srvHome; $env:LOCALAPPDATA = $srvLocal; $env:APPDATA = $srvRoaming
$env:EOS_OFFLINE_DIR = $eosDir
$env:D1147_SERVER = "1"; $env:D1147_PORT = "$Port"; $env:D1147_DIR = $WorkDir
if ($NoReplication) { $env:D1147_REPLICATE = "0" }
if ($NoProgression) { $env:D1147_PROGRESSION = "0" }
$gameArgs = "-EpicPortal -server -unattended -nullrhi -nosound -log -stdout -FullStdOutLogOutput -RepDriverDisable -nosplash -NoLoadingScreen -nomoviestartup -NoVerifyGC"
# DF-SERVERSPEED (Oct 21): every server copy runs at High priority with Windows power throttling (efficiency mode)
# off. On some PCs Windows slowed the hidden server copies down while the game had the focus, so a hunt ran at a few
# frames per second and hitched. Never stops a server: if Windows refuses, it runs at normal priority.
# data\server_priority.txt with the word normal turns it off.
function Set-ServerSpeed($proc) {
    try {
        if (-not $proc) { return }
        $pf = Join-Path $dataDir 'server_priority.txt'
        if ((Test-Path -LiteralPath $pf) -and ((Get-Content -LiteralPath $pf -Raw).Trim().ToLower() -eq 'normal')) { return }
        try { $proc.PriorityClass = 'High' } catch { Write-Host "  (High priority refused: $($_.Exception.Message))" -ForegroundColor Yellow }
        if (-not ('DFS.P' -as [type])) { Add-Type -Namespace DFS -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool SetProcessInformation(IntPtr h, int c, byte[] i, int s);' }
        # ProcessPowerThrottling (4): Version 1, ControlMask EXECUTION_SPEED, StateMask 0 = never throttle
        [void][DFS.P]::SetProcessInformation($proc.Handle, 4, [byte[]](1,0,0,0,1,0,0,0,0,0,0,0), 12)
    } catch { Write-Host "  (server speed: $($_.Exception.Message))" -ForegroundColor Yellow }
}
$p = Start-Process -FilePath $exe -ArgumentList $gameArgs -WorkingDirectory $exeDir -RedirectStandardOutput $engLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
Set-ServerSpeed $p
Write-Host "Server copy started (pid $($p.Id)), map $Map, UDP port $Port."
Write-Host "Waiting for it to listen (up to $WaitSeconds s). Press Q in this window to stop the server at any time."

function Read-Shared([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    try { $fs = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite'); $sr = New-Object IO.StreamReader($fs); $t = $sr.ReadToEnd(); $sr.Close(); return ($t -split "`r?`n") } catch { return @() }
}

# ---------- the second server: places outside the city ----------
# The recorder writes data\wanted.json when the player asks to go somewhere else. A second server copy is then
# started on that map with its own port and private home; the city server keeps running. While it listens,
# data\server_hunt.json tells the recorder where it is.
# DF-WARM-1147 (Oct 19): Trials players retry a lot, and every retry used to boot a fresh server (about a minute).
# While a trial server is in use, a SPARE copy of the same map warms up on the next port; a retry switches to the
# spare at once and a new spare starts. On from the Mods page ("Trials Quick Retry"); data\warm.txt "all" warms every place.
# A spare is only started with 4 GB of RAM free.
$wantedFile = Join-Path $dataDir "wanted.json"
$huntMarker = Join-Path $dataDir "server_hunt.json"
$warmFile = Join-Path $dataDir "warm.txt"
# DF-FIX4: why the last hunt server failed, for the backend (the game stops searching and says so) and the launcher
$huntFailedFile = Join-Path $dataDir "server_hunt_failed.json"
if (Test-Path -LiteralPath $huntFailedFile) { Remove-Item -LiteralPath $huntFailedFile -Force -ErrorAction SilentlyContinue }
function Write-HuntFailed([string]$Id, [string]$Reason) {
    $r = $Reason -replace '[\\"]', ' ' -replace '[\r\n]+', ' '
    try { [System.IO.File]::WriteAllText($huntFailedFile, ('{{"id":"{0}","reason":"{1}","at":"{2}"}}' -f $Id, $r, (Get-Date).ToString('o')), [System.Text.Encoding]::ASCII) } catch { }
    Write-Host ("HUNT SERVER FAILED: {0}" -f $Reason) -ForegroundColor Red
}
# A server copy that ends within 20 seconds with (almost) no engine output was not closed by the game: an antivirus
# most likely did it (the hidden -server -nullrhi copy looks suspicious to some). Say so instead of "ended by itself".
function Describe-Exit($proc, [datetime]$started, [string]$engineLog) {
    $secs = [int]((Get-Date) - $started).TotalSeconds
    $size = 0; try { if (Test-Path -LiteralPath $engineLog) { $size = (Get-Item -LiteralPath $engineLog).Length } } catch { }
    if ($secs -le 20 -and $size -lt 4096) { return ("it was closed after {0} s before the game produced any output (exit code {1}): most likely your antivirus closed the hidden server copy. Add the game folder and this launcher folder to its exclusions, then try again" -f $secs, $proc.ExitCode) }
    return ("its process ended by itself after {0} s (exit code {1})" -f $secs, $proc.ExitCode)
}
$modsFile = Join-Path $dataDir "mods.txt"
foreach ($f in @($wantedFile, $huntMarker)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue } }
$script:hunts = [ordered]@{}; $script:spare = $null; $script:huntCount = 0; $script:failedIds = @{}
# DF-MULTIHUNT-1147 (Oct 21): one hunt server per place. Players who are not in a party each get their own hunt server
# (a party shares one), on UDP 8781-8787: the ports the firewall rules, the relay and the join proxy already carry.
# Another one is only started with enough free memory; otherwise that player is told why and stays in Ramsgate.
$MaxHuntPort = $Port + 7
$MinFreeGB = 3
$urlOk = "^/Game/[A-Za-z0-9_/.?=:,+\-]{1,900}$"
# off unless the Mods page turned "Trials Quick Retry" on (data\mods.txt trialsretry=on); data\warm.txt (all|off|trials) overrides
function Warm-Mode {
    $m = "off"
    try { if (Test-Path -LiteralPath $modsFile) { foreach ($l in [IO.File]::ReadAllLines($modsFile)) { if ($l.Trim().ToLower() -eq "trialsretry=on") { $m = "trials" } } } } catch { }
    try { if (Test-Path -LiteralPath $warmFile) { $t = ([IO.File]::ReadAllText($warmFile)).Trim().ToLower(); if ($t -in @("all", "off", "trials")) { $m = $t } } } catch { }
    return $m
}
function Warm-Wanted($h) { $m = Warm-Mode; return ($m -eq "all") -or ($m -eq "trials" -and "$($h.Label)" -match "TRIAL") }
function Free-RamGB { try { return [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 1) } catch { return 99 } }
function Strip-Players([string]$u) { return ($u -replace '\?PlayerHuntIds=[^?]*', '') }
function Free-HuntPort {
    $used = @{}
    foreach ($h in @($script:hunts.Values)) { $used[[int]$h.Port] = $true }
    if ($script:spare) { $used[[int]$script:spare.Port] = $true }
    for ($fp = $HuntPort; $fp -le $MaxHuntPort; $fp++) { if (-not $used.ContainsKey($fp)) { return $fp } }
    return 0
}
function Start-Hunt($w, [int]$port, [bool]$isSpare) {
    $script:huntCount++; $n = $script:huntCount
    $slot = "$($port - $Port + 1)"    # 8781 -> srvhome2, 8782 -> srvhome3, ... (each copy keeps its own private home)
    $hHome = Join-Path $WorkDir "srvhome$slot"
    $hLocal = Join-Path $hHome "AppData\Local"; $hRoaming = Join-Path $hHome "AppData\Roaming"
    $hCfg = Join-Path $hLocal "Archon\Saved\Config\WindowsClient"; $hEos = Join-Path $WorkDir "eos_srv$slot"
    foreach ($d in @($hLocal, $hRoaming, (Join-Path $hHome "Documents"), $hCfg, $hEos)) { New-Item -ItemType Directory -Force $d | Out-Null }
    Copy-Item -LiteralPath $profileIni -Destination (Join-Path $hCfg "Game.ini") -Force
    # map and options go in through the settings file (a released game ignores a map on the command line);
    # no game mode is set, so the map brings its own
    $u = "$($w.url)"; $q = $u.IndexOf("?"); $hMap = $u; $hOpts = ""
    if ($q -ge 0) { $hMap = $u.Substring(0, $q); $hOpts = $u.Substring($q) }
    $hIni = "; Written by server-1147.ps1 for a hunt server.`r`n[/Script/EngineSettings.GameMapsSettings]`r`nGameDefaultMap=$hMap`r`nServerDefaultMap=$hMap`r`nLocalMapOptions=$hOpts`r`n`r`n" + $driverIni
    [System.IO.File]::WriteAllText((Join-Path $hCfg "Engine.ini"), $hIni, [System.Text.Encoding]::ASCII)
    $log = Join-Path $logDir "server_$port.log"
    if (Test-Path -LiteralPath $log) { Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue }
    $hEng = Join-Path $logDir ("place{0}_engine.log" -f $n); $hErr = Join-Path $logDir ("place{0}_engine_err.log" -f $n)
    $env:USERPROFILE = $hHome; $env:LOCALAPPDATA = $hLocal; $env:APPDATA = $hRoaming; $env:EOS_OFFLINE_DIR = $hEos; $env:D1147_PORT = "$port"
    $hp = Start-Process -FilePath $exe -ArgumentList $gameArgs -WorkingDirectory $exeDir -RedirectStandardOutput $hEng -RedirectStandardError $hErr -WindowStyle Hidden -PassThru
    Set-ServerSpeed $hp
    $rec = @{ Proc = $hp; Id = "$($w.id)"; Url = $u; Label = "$($w.label)"; N = $n; Shown = 0; Started = (Get-Date); Listening = $false; UnwantedSince = $null; Reuse = [bool]$w.reuse; Port = $port; Log = $log; Spare = $isSpare; Eng = $hEng; ForId = "" }
    if (-not $isSpare -and (Test-Path -LiteralPath $huntFailedFile)) { Remove-Item -LiteralPath $huntFailedFile -Force -ErrorAction SilentlyContinue }
    Write-Host ""
    if ($isSpare) {
        $script:spare = $rec
        Write-Host ("SPARE SERVER warming up (pid {0}, port {1}) for: {2}. A retry switches to it at once." -f $hp.Id, $port, $w.label) -ForegroundColor Cyan
    } else {
        $script:hunts[$rec.Id] = $rec
        Write-Host ("HUNT SERVER starting (pid {0}, port {1}) for: {2}" -f $hp.Id, $port, $w.label) -ForegroundColor Green
        Write-Host ("  map and options: {0}" -f $u)
        if ($script:hunts.Count -gt 1) { Write-Host ("  {0} hunt servers are running now (one per place)." -f $script:hunts.Count) }
        Write-Host "  The game shows its matchmaking screen until this server is ready (about a minute)."
    }
    return $rec
}
# data\server_hunt.json: every listening hunt server in "list"; the newest also at the top (older readers)
function Write-HuntMarker {
    $up = @($script:hunts.Values | Where-Object { $_.Listening })
    if (-not $up.Count) { if (Test-Path -LiteralPath $huntMarker) { Remove-Item -LiteralPath $huntMarker -Force -ErrorAction SilentlyContinue }; return }
    $items = @($up | ForEach-Object { '{{"pid":{0},"port":{1},"host":"127.0.0.1","id":"{2}"}}' -f $_.Proc.Id, $_.Port, $_.Id })
    $last = $up[$up.Count - 1]
    $json = '{{"pid":{0},"port":{1},"host":"127.0.0.1","id":"{2}","list":[{3}]}}' -f $last.Proc.Id, $last.Port, $last.Id, ($items -join ',')
    $tmp = "$huntMarker.tmp"
    [System.IO.File]::WriteAllText($tmp, $json, [System.Text.Encoding]::ASCII)
    Move-Item -LiteralPath $tmp -Destination $huntMarker -Force
}
function Stop-Rec($h, [string]$Why, [string]$What) {
    if (-not $h) { return }
    if (-not $h.Proc.HasExited) { try { Stop-Process -Id $h.Proc.Id -Force } catch { }; Start-Sleep -Seconds 1 }
    try { if (Test-Path -LiteralPath $h.Log) { Copy-Item -LiteralPath $h.Log -Destination (Join-Path $logDir ("place{0}_loader.log" -f $h.N)) -Force } } catch { }
    Write-Host ("{0} stopped: {1}. Its logs: place{2}_engine.log, place{2}_loader.log" -f $What, $Why, $h.N) -ForegroundColor Yellow
}
function Stop-Hunt($h, [string]$Why) {
    if (-not $h) { return }
    if ($script:hunts.Contains($h.Id) -and $script:hunts[$h.Id] -eq $h) { $script:hunts.Remove($h.Id) }
    Write-HuntMarker
    Stop-Rec $h $Why ("HUNT SERVER (port {0})" -f $h.Port)
    if ($script:spare -and $script:spare.ForId -eq $h.Id -and $Why -notmatch "spare server takes over") { Stop-Spare $Why }
}
function Stop-Spare([string]$Why) {
    $s = $script:spare; if (-not $s) { return }
    $script:spare = $null
    Stop-Rec $s $Why "SPARE SERVER"
}
function Fail-Hunt($h, [string]$why) {
    if ($h.Spare) { Stop-Spare $why; return }
    $script:failedIds[$h.Id] = $true; Write-HuntFailed $h.Id $why; Stop-Hunt $h $why
}
# tail a copy's loader log; returns $false when the copy is gone
function Watch-Rec($h) {
    $tag = if ($h.Spare) { "[spare]" } else { "[$($h.Port)]" }
    $ll = @(Read-Shared $h.Log | Where-Object { $_ })
    for ($i = $h.Shown; $i -lt $ll.Count; $i++) { Write-Host ("  $tag " + $ll[$i]) -ForegroundColor DarkCyan }
    if ($ll.Count -gt $h.Shown) { $h.Shown = $ll.Count }
    if (-not $h.Listening) {
        $txt = $ll -join "`n"; $waited = [int]((Get-Date) - $h.Started).TotalSeconds
        if ($txt -match "LISTENING on UDP port") {
            $h.Listening = $true
            if ($h.Spare) { Write-Host ("SPARE SERVER READY on port {0} after {1} seconds." -f $h.Port, $waited) -ForegroundColor Cyan }
            else { Write-HuntMarker; Write-Host ("HUNT SERVER READY on port {0} after {1} seconds. The game travels there by itself." -f $h.Port, $waited) -ForegroundColor Green }
        }
        elseif ($txt -match "stopping here|InitListen on port \d+ = 0") { Fail-Hunt $h "it could not open UDP port $($h.Port) (another program or a Windows port reservation holds it; STOP bat, or net stop winnat / net start winnat as admin)"; return $false }
        elseif ($waited -ge $WaitSeconds) { Fail-Hunt $h "it did not come up within $WaitSeconds seconds (see logs\place$($h.N)_engine.log)"; return $false }
    }
    if ($h.Proc.HasExited) { Fail-Hunt $h (Describe-Exit $h.Proc $h.Started $h.Eng); return $false }
    return $true
}
# data\wanted.json: every place a player asked for in "list" (one entry at the top for an older backend)
function Read-Wanted {
    $w = $null
    if (Test-Path -LiteralPath $wantedFile) { try { $w = (Read-Shared $wantedFile) -join "`n" | ConvertFrom-Json } catch { $w = $null } }
    if (-not $w) { return @() }
    $all = if ($null -ne $w.list) { @($w.list) } else { @($w) }
    return @($all | Where-Object { $_ -and $_.id -and "$($_.url)" -match $urlOk })
}
function Step-Hunt {
    $wl = @(Read-Wanted)
    $ids = @{}; foreach ($w in $wl) { $ids["$($w.id)"] = $true }
    foreach ($w in $wl) {
        $id = "$($w.id)"
        if ($script:hunts.Contains($id)) { $script:hunts[$id].UnwantedSince = $null; continue }
        if ($script:failedIds.ContainsKey($id)) { continue }
        # the same place (Training Grounds) asked for again under a new id: the server that is already up is used
        $old = @($script:hunts.Values | Where-Object { -not $ids.ContainsKey($_.Id) -and $_.Reuse -and $w.reuse -and $_.Url -eq "$($w.url)" -and -not $_.Proc.HasExited }) | Select-Object -First 1
        if ($old) {
            $script:hunts.Remove($old.Id); $old.Id = $id; $old.UnwantedSince = $null; $script:hunts[$id] = $old
            if ($old.Listening) { Write-HuntMarker }
            Write-Host ("  [{0}] the same place was asked for again: using the server that is already up" -f $old.Port) -ForegroundColor DarkCyan
            continue
        }
        # DF-WARM-1147: a retry of the same place: the spare takes over, no new boot
        $s = $script:spare
        if ($s -and -not $s.Proc.HasExited -and (Strip-Players $s.Url) -eq (Strip-Players "$($w.url)")) {
            $prev = $null; if ($s.ForId -and $script:hunts.Contains($s.ForId)) { $prev = $script:hunts[$s.ForId] }
            if ($prev -and -not $ids.ContainsKey($prev.Id)) { Stop-Hunt $prev "a retry: the spare server takes over" }
            $script:spare = $null
            $s.Id = $id; $s.Label = "$($w.label)"; $s.Reuse = [bool]$w.reuse; $s.Spare = $false; $s.UnwantedSince = $null; $s.ForId = ""
            $script:hunts[$id] = $s
            if ($s.Listening) { Write-HuntMarker; Write-Host ("SPARE SERVER TAKES OVER on port {0}: ready at once." -f $s.Port) -ForegroundColor Green }
            else { Write-Host ("SPARE SERVER TAKES OVER on port {0}: still starting." -f $s.Port) -ForegroundColor Green }
            continue
        }
        # a new place: places nobody wants any more are closed first, so their memory goes to the new one
        foreach ($h in @($script:hunts.Values | Where-Object { -not $ids.ContainsKey($_.Id) })) { Stop-Hunt $h "another place was asked for" }
        if ($script:spare -and -not $ids.ContainsKey("$($script:spare.ForId)")) { Stop-Spare "another place was asked for" }
        $port = Free-HuntPort
        if (-not $port -and $script:spare) { Stop-Spare "a hunt server for another place needs its port"; $port = Free-HuntPort }
        if (-not $port) { $script:failedIds[$id] = $true; Write-HuntFailed $id ("all {0} hunt server slots are in use (UDP {1}-{2}). Join another player's hunt (party up) or wait until one comes back" -f ($MaxHuntPort - $HuntPort + 1), $HuntPort, $MaxHuntPort); continue }
        if ($script:hunts.Count -ge 1) {
            $free = Free-RamGB
            if ($free -lt $MinFreeGB -and $script:spare) { Stop-Spare "a hunt server for another place needs the memory"; Start-Sleep -Seconds 2; $free = Free-RamGB }
            if ($free -lt $MinFreeGB) { $script:failedIds[$id] = $true; Write-HuntFailed $id ("not enough free memory for another hunt server on the host PC ({0} GB free, {1} GB needed; {2} hunt server(s) already running). Join the other player's hunt (party up) or wait until they are back" -f $free, $MinFreeGB, $script:hunts.Count); continue }
        }
        [void](Start-Hunt $w $port $false)
    }
    # places nobody wants any more (everyone left): closed after 90 s
    foreach ($h in @($script:hunts.Values)) {
        if ($ids.ContainsKey($h.Id)) { continue }
        if ($null -eq $h.UnwantedSince) { $h.UnwantedSince = Get-Date }
        elseif (((Get-Date) - $h.UnwantedSince).TotalSeconds -gt 90) { Stop-Hunt $h "the players left that place" }
    }
    foreach ($h in @($script:hunts.Values)) { [void](Watch-Rec $h) }
    if ($script:spare) { [void](Watch-Rec $script:spare) }
    # DF-WARM-1147: warm a spare for the newest place in use that wants one
    if (-not $script:spare) {
        $h = @($script:hunts.Values | Where-Object { $_.Listening -and $ids.ContainsKey($_.Id) -and (Warm-Wanted $_) }) | Select-Object -Last 1
        if ($h) {
            $free = Free-RamGB; $wp = Free-HuntPort
            if ($free -ge 4 -and $wp) { $sp = Start-Hunt @{ id = ""; url = $h.Url; label = $h.Label; reuse = $h.Reuse } $wp $true; $sp.ForId = $h.Id }
            elseif (-not $h.WarmSkipped) { $h.WarmSkipped = $true; Write-Host ("  (no spare server: {0} GB of RAM free, 4 needed{1})" -f $free, $(if ($wp) { '' } else { '; no free port' })) -ForegroundColor DarkYellow }
        }
    }
}

$shown = 0; $listening = $false; $start = Get-Date; $stopReason = ""
# DF-AMMO-LOG-1147 (Oct 25): skip the game's broken "ServerAdjustAmmo" warning in every Dauntless process (it crashed
# hunt servers, Repeaters); tools\ammo-fix-1147.ps1, log in logs\ammo-fix.log. Checks for new processes every 3 s.
$ammoNext = Get-Date; $ammoLog = Join-Path $logDir 'ammo-fix.log'
$ammoNext = $null   # Oct 26: bin\dxgi.dll makes this change itself now (antivirus programs blocked the script)
while ($true) {
    if ($ammoNext -and (Get-Date) -ge $ammoNext) { $ammoNext = (Get-Date).AddSeconds(3); try { DfAmmoFix $ammoLog } catch { } }
    $lines = @(Read-Shared $srvLog)
    for ($i = $shown; $i -lt $lines.Count; $i++) { if ($lines[$i]) { Write-Host "  $($lines[$i])" } }
    if ($lines.Count -gt $shown) { $shown = $lines.Count }
    if (-not $listening -and ($lines -match "LISTENING on UDP port")) {
        $listening = $true
        $json = '{"pid": ' + $p.Id + ', "port": ' + $Port + ', "host": "127.0.0.1"}'
        [System.IO.File]::WriteAllText($marker, $json, [System.Text.Encoding]::ASCII)
        Write-Host ""
        Write-Host "SERVER IS UP." -ForegroundColor Green
        Write-Host "Leave this window open while you play (PLAY closes it for you when the game closes; Q stops it by hand)." -ForegroundColor Green
        Write-Host ""
    }
    if ($listening -and -not $NoSecondServer) { try { Step-Hunt } catch { Write-Host "  [2nd] error: $($_.Exception.Message)" -ForegroundColor Yellow } }
    if ($p.HasExited) { $stopReason = "the server process ended: " + (Describe-Exit $p $start $engLog); break }
    if (-not $listening -and ((Get-Date) - $start).TotalSeconds -gt $WaitSeconds) { $stopReason = "it did not start listening within $WaitSeconds s"; break }
    # Q stops the server by hand. On some PCs this window has no usable console (input redirected, Windows Terminal
    # as the default console, Host Mode's hidden window): asking for a key then throws, and with 'Stop' as the error
    # setting that ended the whole server. Now a missing console just means no Q. (Oct 18)
    $q = $false
    try { if (-not [Console]::IsInputRedirected -and [Console]::KeyAvailable) { $k = [Console]::ReadKey($true); if ($k.Key -eq 'Q') { $q = $true } } } catch { }
    if ($q) { $stopReason = "stopped with Q"; break }
    Start-Sleep -Milliseconds 500
}
if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
try { foreach ($h in @($script:hunts.Values)) { Stop-Hunt $h "the city server is stopping" }; Stop-Spare "the city server is stopping" } catch { }
foreach ($f in @($wantedFile, $huntMarker)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue } }
if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force; Start-Sleep -Seconds 2 }
Write-Host ""
Write-Host "Server stopped: $stopReason" -ForegroundColor Yellow

# ---------- logs (for asking for help) ----------
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$runDir = Join-Path $logDir "server_run_$stamp"
New-Item -ItemType Directory -Force $runDir | Out-Null
foreach ($f in @($srvLog, $engLog, $errLog)) { if (Test-Path -LiteralPath $f) { Copy-Item -LiteralPath $f -Destination $runDir } }
Get-ChildItem -LiteralPath $logDir -Filter "place*_*.log" -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $start } | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination $runDir -Force }
$eosLog = Join-Path $eosDir "eos_offline.log"; if (Test-Path -LiteralPath $eosLog) { Copy-Item -LiteralPath $eosLog -Destination (Join-Path $runDir "eos_srv.log") }
$gameLog = Join-Path $srvLocal "Archon\Saved\Logs\Archon.log"; if (Test-Path -LiteralPath $gameLog) { Copy-Item -LiteralPath $gameLog -Destination (Join-Path $runDir "Archon_server.log") }
if (Test-Path -LiteralPath $crashDir) {
    foreach ($c in Get-ChildItem -LiteralPath $crashDir -Directory) {
        if ($crashBefore -contains $c.Name) { continue }
        # DF-LOGFILTER (Oct 21): Windows PowerShell ignores -Include next to -LiteralPath, so every new file went into the zip (NVIDIA shader caches, ini files); filtered by extension now
        Get-ChildItem -LiteralPath $c.FullName -File -Recurse | Where-Object { $_.Extension -in @('.log', '.txt', '.xml', '.runtime-xml') -and $_.FullName -notmatch '\\(NVIDIA|AMD|D3DSCache|DXCache|GLCache)\\' } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $runDir ("crash_" + $_.Name)) }
    }
}
foreach ($f in Get-ChildItem -LiteralPath $runDir -File) {
    $t = Get-Content -LiteralPath $f.FullName -Raw
    if ($null -eq $t) { continue }
    foreach ($s in @($env:COMPUTERNAME, $env:USERNAME) | Where-Object { $_ }) { $t = $t -replace [regex]::Escape($s), "XXXX" }
    $t = $t -replace 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*', "JWT_XXXX"
    Set-Content -LiteralPath $f.FullName -Value $t -NoNewline
}
$zip = Join-Path $uploadDir "server_logs.zip"
if (Test-Path -LiteralPath $zip) { Move-Item -LiteralPath $zip -Destination (Join-Path $uploadDir "server_logs_prev_$stamp.zip") }
Compress-Archive -Path (Join-Path $runDir "*") -DestinationPath $zip
Write-Host "Logs: $runDir"
Write-Host "Zip:  $zip"
