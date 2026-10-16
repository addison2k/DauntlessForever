# Dauntless Forever - Dauntless 1.6.2 offline package
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# start.ps1 - "2 - PLAY.bat": starts the local backend, then the game servers, then the game, in that order.
# When the game is closed, everything this package started is shut down again.
# -NoGame (Host Mode, from online-host.ps1 -HostMode): no game window; the backend and game servers stay up until
# data\hostmode_stop appears or the launcher stops Host Mode. If the backend, the game-server starter or Ramsgate
# goes down, this stops with an error and the launcher starts Host Mode again.
param([switch]$NoGame)
. (Join-Path $PSScriptRoot 'common.ps1')

Say ''
Say '=== Dauntless 1.6.2 offline ===' 'Cyan'
$cfg = Get-Config
if (-not $cfg) { Fail 'set-up has not been run yet. Double-click "1 - SETUP.bat" first.' }
$bin = Join-Path $cfg.GameDir 'Archon\Binaries\Win64'
if ((Hash256 (Join-Path $bin 'dxgi.dll')) -ne $LoaderHash -or (Hash256 (Join-Path $bin 'UndauntedInternalServer.dll')) -ne $ServerHash) {
    Fail 'the game folder is missing files this package puts there (maybe the game was updated or verified). Run "1 - SETUP.bat" again.'
}
if ((Hash256 (Join-Path $cfg.GameDir $ExeRel)) -ne $ExeHash) { Fail 'the game in the saved folder is no longer Dauntless 1.6.2. Run "1 - SETUP.bat" again.' }
$node = $cfg.Node
if (-not $node -or -not (Test-Path -LiteralPath $node)) { $node = Find-Node }
if (-not $node) { Fail 'Node.js was not found. Run "1 - SETUP.bat" again.' }
foreach ($f in @((Join-Path $MetaDir '.env'), (Join-Path $DeployDir '.env'), (Join-Path $DataDir 'player.key'))) {
    if (-not (Test-Path -LiteralPath $f)) { Fail 'set-up did not finish last time. Run "1 - SETUP.bat" again.' }
}
# Windows parts the game needs (Visual C++ runtime, DirectX June 2010). Without them every copy of the game
# closes at once with no log, so say it plainly here instead.
$missing = @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'xinput1_3.dll', 'x3daudio1_7.dll', 'xapofx1_5.dll') |
    Where-Object { -not (Test-Path -LiteralPath (Join-Path $env:WINDIR "System32\$_")) }
if (@($missing).Count -gt 0) { Fail "Windows is missing parts the game needs ($(@($missing) -join ', ')). Run set-up again: it installs them." }
if (-not $NoGame -and @(Get-PlayerGame).Count -gt 0) { Fail 'the game is already running. Close it first (or end Dauntless-Win64-Shipping in Task Manager).' }

New-Item -ItemType Directory -Force $DataDir, $LogDir | Out-Null
# Your player name comes from the launcher (one name for every version): keep this account's name in step.
if ($env:DF_PLAYER_NAME -match '^[A-Za-z0-9_]{3,16}$' -and $env:DF_PLAYER_NAME -cne "$($cfg.PlayerName)") {
    & $node (Join-Path $PSScriptRoot 'travel.js') name $env:DF_PLAYER_NAME | Out-Null
    if ($LASTEXITCODE -eq 0) { $cfg | Add-Member -NotePropertyName PlayerName -NotePropertyValue $env:DF_PLAYER_NAME -Force; Save-Config $cfg; Say "Player name: $($env:DF_PLAYER_NAME)" 'Green' }
}

# --- leftovers from a run that did not close properly
Stop-Everything -Quiet
Clear-DauntlessPorts -TcpPorts @($MetaPort, $DeployPort) -UdpPorts (8770..8777)
foreach ($port in @($MetaPort, $DeployPort)) {
    $owner = Get-ListenerPid $port
    if ($owner) {
        $pn = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName
        Fail "another program ($pn, process $owner) is using port $port. If it is another Dauntless private server, close it first, then try again."
    }
}
foreach ($port in 8770..8777) {
    if (Test-UdpPort $port) { Fail "game port $port is already in use. If another Dauntless private server is running, close it (and its game servers) first, then try again." }
}
Get-ChildItem -LiteralPath $DeployDir -Filter 'UndauntedServer_*.log' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

$metaLog = Join-Path $LogDir 'metagame.log';  $metaErr = Join-Path $LogDir 'metagame.err'
$depLog  = Join-Path $LogDir 'deploy.log';    $depErr  = Join-Path $LogDir 'deploy.err'

function Save-ServerLogs {
    $files = @($metaLog, $metaErr, $depLog, $depErr) + @(Get-ChildItem -LiteralPath $DeployDir -Filter 'UndauntedServer_*.log' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    try { Save-LogZip $files 'server_logs.zip' } catch { Say "Could not zip the server logs: $($_.Exception.Message)" 'Yellow' }
}
function Stop-AndFail([string]$Text) { Stop-Everything -Quiet; Save-ServerLogs; Fail "$Text`n         The logs are in upload\server_logs.zip if you need help." }

# --- 1. backend (accounts, inventory, progression)
Say '1/3 Starting the local backend...'
# Ramsgate events (decorations): data\city_events.txt, lines "on=flag1,flag2" and "off=flag3" (feature flag class names,
# e.g. on=city_event_Springtide_bpff_C). The deploy server adds them to the Ramsgate map URL.
$env:CITY_EVENTS_ON = ''; $env:CITY_EVENTS_OFF = ''
$eventsFile = Join-Path $DataDir 'city_events.txt'
if (Test-Path -LiteralPath $eventsFile) {
    foreach ($line in Get-Content -LiteralPath $eventsFile -ErrorAction SilentlyContinue) {
        if ($line -match '^\s*on\s*=\s*([A-Za-z0-9_,/.\s]+)$') { $env:CITY_EVENTS_ON = ($Matches[1] -replace '\s', '') }
        elseif ($line -match '^\s*off\s*=\s*([A-Za-z0-9_,/.\s]+)$') { $env:CITY_EVENTS_OFF = ($Matches[1] -replace '\s', '') }
    }
    if ($env:CITY_EVENTS_ON -or $env:CITY_EVENTS_OFF) { Say "    Ramsgate events: on [$($env:CITY_EVENTS_ON)] off [$($env:CITY_EVENTS_OFF)]" }
}
# Hunt Pass season: the launcher writes the chosen key to data\season.txt (Seasons page). Each season keeps its own save.
$seasonsDir = Join-Path $Root 'seasons'
if (Test-Path -LiteralPath (Join-Path $seasonsDir 'index.json')) {
    $seasonKey = 'mega'
    $seasonFile = Join-Path $DataDir 'season.txt'
    if (Test-Path -LiteralPath $seasonFile) {
        $k = ((Get-Content -LiteralPath $seasonFile -Raw -ErrorAction SilentlyContinue) + '').Trim()
        if ($k -match '^[A-Za-z0-9_.-]+$' -and (Test-Path -LiteralPath (Join-Path $seasonsDir "$k.json"))) { $seasonKey = $k }
        elseif ($k) { Say "    Season '$k' is not in this package; using the Mega Hunt Pass." 'Yellow' }
    }
    $env:HUNTPASS_SEASONS_DIR = $seasonsDir
    $env:HUNTPASS_SEASON = $seasonKey
    try { $st = (Get-Content -LiteralPath (Join-Path $seasonsDir 'index.json') -Raw -Encoding UTF8 | ConvertFrom-Json).seasons | Where-Object { $_.key -eq $seasonKey } | Select-Object -First 1; if ($st) { Say "    Hunt Pass season: $($st.title) ($($st.levels) levels)" } } catch {}
}
# Game Rules: defaults from rules.json, the player's picks from data\rules.txt (key=value lines, Game Rules page).
# Each rule becomes the env variable rules.json names (RULE_WEAPON_XP, ...); the metagame reads them (rules162.ts).
$rulesDef = Join-Path $Root 'rules.json'
if (Test-Path -LiteralPath $rulesDef) {
    try {
        $picked = @{}
        $rulesFile = Join-Path $DataDir 'rules.txt'
        if (Test-Path -LiteralPath $rulesFile) {
            foreach ($line in Get-Content -LiteralPath $rulesFile -ErrorAction SilentlyContinue) {
                if ($line -match '^\s*([a-z_]+)\s*=\s*([0-9.]+)\s*$') { $picked[$Matches[1]] = $Matches[2] }
            }
        }
        $shown = @()
        foreach ($r in (Get-Content -LiteralPath $rulesDef -Raw -Encoding UTF8 | ConvertFrom-Json).rules) {
            if ($r.env -notmatch '^RULE_[A-Z_]+$') { continue }
            $val = [string]$r.default
            $ok = @($r.choices | ForEach-Object { [string]$_[0] })
            if ($picked.ContainsKey($r.key) -and ($ok -contains $picked[$r.key])) { $val = $picked[$r.key] }
            Set-Item -Path "Env:$($r.env)" -Value $val
            $label = ($r.choices | Where-Object { [string]$_[0] -eq $val } | Select-Object -First 1)
            if ($val -ne '1' -or $r.key -eq 'free_crafting') { if ($val -ne '0') { $shown += "$($r.title) $(if ($label) { $label[1] } else { $val })" } }
        }
        if ($shown.Count) { Say "    Game Rules: $($shown -join ', ')" }
    } catch { Say "    Could not read the Game Rules; playing with normal rules. ($($_.Exception.Message))" 'Yellow' }
}
# Hosting (Host with friends, Play online, LAN host; set by online-host.ps1 / lan-host.ps1): other players' progress
# runs on this backend, so it uses the standard settings in online.env, whatever this PC's backend .env or Game Rules
# say. Values set here win over the same lines in .env (node --env-file never replaces a variable already set).
# Solo play is untouched: there the player's own .env and Game Rules apply.
if ($env:DF_HOSTING -eq '1') {
    $onlineEnv = Join-Path $Root 'online.env'
    if (Test-Path -LiteralPath $onlineEnv) {
        $n = 0
        foreach ($line in Get-Content -LiteralPath $onlineEnv -ErrorAction SilentlyContinue) {
            if ($line -match '^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$') { Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]; $n++ }
        }
        Say "    Hosting: standard online settings ($n from online.env); your own .env and Game Rules apply to solo play." 'Green'
    }
}
$meta = Start-Process -FilePath $node -ArgumentList @('--env-file=.env', 'dist/server.js') -WorkingDirectory $MetaDir -WindowStyle Hidden `
    -RedirectStandardOutput $metaLog -RedirectStandardError $metaErr -PassThru
[IO.File]::WriteAllText((Join-Path $DataDir 'metagame.pid'), "$($meta.Id)")
$t0 = Get-Date
while (-not (Test-Meta)) {
    if ($meta.HasExited) { Stop-AndFail 'the local backend stopped right away.' }
    if (((Get-Date) - $t0).TotalSeconds -gt 45) { Stop-AndFail 'the local backend did not start within 45 seconds.' }
    Start-Sleep -Milliseconds 500
}
Say '    Local backend: running.' 'Green'

# --- 2. game servers. The deploy server starts Ramsgate (8777) and the Training Dojo (8776) now,
#        and a new server copy for each hunt. They all use the package's private settings folder.
Say '2/3 Starting the game servers (hidden). This takes a minute or two, please wait...'
$saved = @{ USERPROFILE = $env:USERPROFILE; LOCALAPPDATA = $env:LOCALAPPDATA; APPDATA = $env:APPDATA }
try {
    $env:USERPROFILE  = $HomeDir
    $env:LOCALAPPDATA = Join-Path $HomeDir 'AppData\Local'
    $env:APPDATA      = Join-Path $HomeDir 'AppData\Roaming'
    $deploy = Start-Process -FilePath $node -ArgumentList @('--env-file=.env', 'dist/server.js') -WorkingDirectory $DeployDir -WindowStyle Hidden `
        -RedirectStandardOutput $depLog -RedirectStandardError $depErr -PassThru
} finally {
    $env:USERPROFILE = $saved.USERPROFILE; $env:LOCALAPPDATA = $saved.LOCALAPPDATA; $env:APPDATA = $saved.APPDATA
}
[IO.File]::WriteAllText((Join-Path $DataDir 'deploy.pid'), "$($deploy.Id)")
$t0 = Get-Date; $dots = 0
while (-not (Test-UdpPort $RamsgatePort)) {
    if ($deploy.HasExited) { Stop-AndFail 'the program that starts the game servers stopped.' }
    if ($meta.HasExited) { Stop-AndFail 'the local backend stopped.' }
    $fallen = 0
    try { $fs = [IO.File]::Open($depLog, 'Open', 'Read', 'ReadWrite'); $sr = New-Object IO.StreamReader($fs); $depText = $sr.ReadToEnd(); $sr.Close(); $fallen = ([regex]::Matches($depText, 'HAS FALLEN|Dojo Crashed')).Count } catch { $depText = '' }
    if ($depText -match 'Could not start the game server on port \d+: (\w+)') {
        Stop-AndFail ("Windows refused to start the game ($($Matches[1])). Was the game moved, or did an antivirus block it?`n" +
                      "         Run set-up again; if an antivirus is involved, allow the game folder in it.")
    }
    if ($fallen -ge 2 -or $depText -match 'GAME SERVER KEEPS FAILING') {
        Stop-AndFail ("the game server copies close right after they start (no log), usually because Windows is missing the game's prerequisites`n" +
                      "         (the Visual C++ runtime and the DirectX End-User Runtime). Run set-up again: it checks and installs them.")
    }
    if (((Get-Date) - $t0).TotalSeconds -gt 240) { Stop-AndFail 'the Ramsgate server was not ready after 4 minutes.' }
    Start-Sleep -Seconds 2; $dots++
    if ($dots % 5 -eq 0) { Write-Host ("    still starting... {0} s" -f [int]((Get-Date) - $t0).TotalSeconds) }
}
Say ("    Game servers: ready after {0} s." -f [int]((Get-Date) - $t0).TotalSeconds) 'Green'

$playOk = $true
if ($NoGame) {
    # --- 3. Host Mode: no game here. Keep watch until asked to stop; anything going down ends this run with an error,
    #        and the launcher starts Host Mode again (when "Restart by itself" is on).
    Say '3/3 Host Mode: the server is up. No game window; press Play in the launcher to join it from this PC.' 'Green'
    $stopFile = Join-Path $DataDir 'hostmode_stop'
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
    $ramsDown = $null
    while ($true) {
        if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue; Say 'Host Mode: asked to stop.'; break }
        if ($meta.HasExited) { Stop-AndFail 'the local backend stopped while hosting.' }
        if ($deploy.HasExited) { Stop-AndFail 'the program that starts the game servers stopped while hosting.' }
        # Ramsgate restarts by itself after a crash; if it stays down for 3 minutes, start everything again
        if (Test-UdpPort $RamsgatePort) { $ramsDown = $null }
        elseif (-not $ramsDown) { $ramsDown = Get-Date }
        elseif (((Get-Date) - $ramsDown).TotalSeconds -gt 180) { Stop-AndFail 'Ramsgate has been down for 3 minutes.' }
        Start-Sleep -Seconds 3
    }
} else {
    # --- 3. the game (this window waits until it is closed)
    Say '3/3 Starting the game...'
    try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'play-162.ps1'); if ($LASTEXITCODE -ne 0) { $playOk = $false } }
    catch { $playOk = $false; Say $_.Exception.Message 'Yellow' }
}

# --- shut down
Say ''
Say 'Shutting down the game servers and the local backend...'
Stop-Everything -Quiet
Start-Sleep -Seconds 2
Save-ServerLogs
Say ''
if ($playOk) { Say 'All closed. Your progress is saved (in the data folder). See you next time!' 'Green' }
else { Say 'All closed. Something went wrong above; the logs are in the upload folder if you need help.' 'Yellow' }
