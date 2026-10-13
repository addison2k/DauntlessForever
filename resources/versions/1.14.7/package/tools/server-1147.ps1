<#
server-1147.ps1 - the Dauntless 1.14.7 game server (a second copy of the game in server mode, hidden).
Normally started for you by "2 - PLAY.bat" (tools\start.ps1). By hand, from the package folder:

  -Run       start the server (Ramsgate, UDP port 8780). When the game asks for a place outside the city (training
             grounds, a hunt), a second hidden server copy is started on that map (UDP port 8781) and the game travels there.
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
$p = Start-Process -FilePath $exe -ArgumentList $gameArgs -WorkingDirectory $exeDir -RedirectStandardOutput $engLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
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
$wantedFile = Join-Path $dataDir "wanted.json"
$huntMarker = Join-Path $dataDir "server_hunt.json"
foreach ($f in @($wantedFile, $huntMarker)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue } }
$script:hunt = $null; $script:huntCount = 0; $script:huntFailedId = ""
$huntHome = Join-Path $WorkDir "srvhome2"
$huntLog = Join-Path $logDir "server_$HuntPort.log"
$urlOk = "^/Game/[A-Za-z0-9_/.?=:,+\-]{1,900}$"
function Start-Hunt($w) {
    $script:huntCount++; $n = $script:huntCount
    $hLocal = Join-Path $huntHome "AppData\Local"; $hRoaming = Join-Path $huntHome "AppData\Roaming"
    $hCfg = Join-Path $hLocal "Archon\Saved\Config\WindowsClient"; $hEos = Join-Path $WorkDir "eos_srv2"
    foreach ($d in @($hLocal, $hRoaming, (Join-Path $huntHome "Documents"), $hCfg, $hEos)) { New-Item -ItemType Directory -Force $d | Out-Null }
    Copy-Item -LiteralPath $profileIni -Destination (Join-Path $hCfg "Game.ini") -Force
    # map and options go in through the settings file (a released game ignores a map on the command line);
    # no game mode is set, so the map brings its own
    $u = "$($w.url)"; $q = $u.IndexOf("?"); $hMap = $u; $hOpts = ""
    if ($q -ge 0) { $hMap = $u.Substring(0, $q); $hOpts = $u.Substring($q) }
    $hIni = "; Written by server-1147.ps1 for the second server.`r`n[/Script/EngineSettings.GameMapsSettings]`r`nGameDefaultMap=$hMap`r`nServerDefaultMap=$hMap`r`nLocalMapOptions=$hOpts`r`n`r`n" + $driverIni
    [System.IO.File]::WriteAllText((Join-Path $hCfg "Engine.ini"), $hIni, [System.Text.Encoding]::ASCII)
    if (Test-Path -LiteralPath $huntLog) { Remove-Item -LiteralPath $huntLog -Force -ErrorAction SilentlyContinue }
    $hEng = Join-Path $logDir ("place{0}_engine.log" -f $n); $hErr = Join-Path $logDir ("place{0}_engine_err.log" -f $n)
    $env:USERPROFILE = $huntHome; $env:LOCALAPPDATA = $hLocal; $env:APPDATA = $hRoaming; $env:EOS_OFFLINE_DIR = $hEos; $env:D1147_PORT = "$HuntPort"
    $hp = Start-Process -FilePath $exe -ArgumentList $gameArgs -WorkingDirectory $exeDir -RedirectStandardOutput $hEng -RedirectStandardError $hErr -WindowStyle Hidden -PassThru
    $script:hunt = @{ Proc = $hp; Id = "$($w.id)"; Url = $u; Label = "$($w.label)"; N = $n; Shown = 0; Started = (Get-Date); Listening = $false; UnwantedSince = $null; Reuse = [bool]$w.reuse }
    Write-Host ""
    Write-Host ("SECOND SERVER starting (pid {0}, port {1}) for: {2}" -f $hp.Id, $HuntPort, $w.label) -ForegroundColor Green
    Write-Host ("  map and options: {0}" -f $u)
    Write-Host "  The game shows its matchmaking screen until this server is ready (about a minute)."
}
function Write-HuntMarker {
    $h = $script:hunt
    [System.IO.File]::WriteAllText($huntMarker, ('{{"pid":{0},"port":{1},"host":"127.0.0.1","id":"{2}"}}' -f $h.Proc.Id, $HuntPort, $h.Id), [System.Text.Encoding]::ASCII)
}
function Stop-Hunt([string]$Why) {
    $h = $script:hunt; if (-not $h) { return }
    if (Test-Path -LiteralPath $huntMarker) { Remove-Item -LiteralPath $huntMarker -Force -ErrorAction SilentlyContinue }
    if (-not $h.Proc.HasExited) { try { Stop-Process -Id $h.Proc.Id -Force } catch { }; Start-Sleep -Seconds 1 }
    try { if (Test-Path -LiteralPath $huntLog) { Copy-Item -LiteralPath $huntLog -Destination (Join-Path $logDir ("place{0}_loader.log" -f $h.N)) -Force } } catch { }
    Write-Host ("SECOND SERVER stopped: {0}. Its logs: place{1}_engine.log, place{1}_loader.log" -f $Why, $h.N) -ForegroundColor Yellow
    $script:hunt = $null
}
function Step-Hunt {
    $w = $null
    if (Test-Path -LiteralPath $wantedFile) { try { $w = (Read-Shared $wantedFile) -join "`n" | ConvertFrom-Json } catch { $w = $null } }
    if ($w -and (-not $w.id -or "$($w.url)" -notmatch $urlOk)) { $w = $null }
    $h = $script:hunt
    if ($w) {
        if ($h -and $h.Id -ne "$($w.id)") {
            if ($h.Reuse -and $w.reuse -and $h.Url -eq "$($w.url)" -and -not $h.Proc.HasExited) {
                $h.Id = "$($w.id)"; if ($h.Listening) { Write-HuntMarker }
                Write-Host "  [2nd] the same place was asked for again: using the server that is already up" -ForegroundColor DarkCyan
            } else { Stop-Hunt "another place was asked for" }
        }
        if (-not $script:hunt -and $script:huntFailedId -ne "$($w.id)") { Start-Hunt $w }
        if ($script:hunt) { $script:hunt.UnwantedSince = $null }
    }
    elseif ($h) {
        if ($null -eq $h.UnwantedSince) { $h.UnwantedSince = Get-Date }
        elseif (((Get-Date) - $h.UnwantedSince).TotalSeconds -gt 90) { Stop-Hunt "the player left that place" }
    }
    $h = $script:hunt; if (-not $h) { return }
    $ll = @(Read-Shared $huntLog | Where-Object { $_ })
    for ($i = $h.Shown; $i -lt $ll.Count; $i++) { Write-Host ("  [2nd] " + $ll[$i]) -ForegroundColor DarkCyan }
    if ($ll.Count -gt $h.Shown) { $h.Shown = $ll.Count }
    if (-not $h.Listening) {
        $txt = $ll -join "`n"; $waited = [int]((Get-Date) - $h.Started).TotalSeconds
        if ($txt -match "LISTENING on UDP port") {
            $h.Listening = $true; Write-HuntMarker
            Write-Host ("SECOND SERVER READY on port {0} after {1} seconds. The game travels there by itself." -f $HuntPort, $waited) -ForegroundColor Green
        }
        elseif ($txt -match "stopping here|InitListen on port \d+ = 0") { $script:huntFailedId = $h.Id; Stop-Hunt "it could not open its port"; return }
        elseif ($waited -ge $WaitSeconds) { $script:huntFailedId = $h.Id; Stop-Hunt "it did not come up within $WaitSeconds seconds"; return }
    }
    if ($h.Proc.HasExited) { $script:huntFailedId = $h.Id; Stop-Hunt "its process ended by itself" }
}

$shown = 0; $listening = $false; $start = Get-Date; $stopReason = ""
while ($true) {
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
    if ($p.HasExited) { $stopReason = "the server process ended by itself (exit code $($p.ExitCode))"; break }
    if (-not $listening -and ((Get-Date) - $start).TotalSeconds -gt $WaitSeconds) { $stopReason = "it did not start listening within $WaitSeconds s"; break }
    if ([Console]::KeyAvailable) { $k = [Console]::ReadKey($true); if ($k.Key -eq 'Q') { $stopReason = "stopped with Q"; break } }
    Start-Sleep -Milliseconds 500
}
if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
try { Stop-Hunt "the city server is stopping" } catch { }
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
        Get-ChildItem -LiteralPath $c.FullName -File -Include *.log, *.xml, *.runtime-xml, *.txt -Recurse | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $runDir ("crash_" + $_.Name)) }
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
