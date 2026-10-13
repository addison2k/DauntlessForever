# start.ps1 - "2 - PLAY.bat": starts the local backend, then the game servers, then the game, in that order.
# When the game is closed, everything this package started is shut down again.
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
if (@(Get-PlayerGame).Count -gt 0) { Fail 'the game is already running. Close it first (or end Dauntless-Win64-Shipping in Task Manager).' }

New-Item -ItemType Directory -Force $DataDir, $LogDir | Out-Null

# --- leftovers from a run that did not close properly
Stop-Everything -Quiet
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

# --- 3. the game (this window waits until it is closed)
Say '3/3 Starting the game...'
$playOk = $true
try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'play-162.ps1'); if ($LASTEXITCODE -ne 0) { $playOk = $false } }
catch { $playOk = $false; Say $_.Exception.Message 'Yellow' }

# --- shut down
Say ''
Say 'Shutting down the game servers and the local backend...'
Stop-Everything -Quiet
Start-Sleep -Seconds 2
Save-ServerLogs
Say ''
if ($playOk) { Say 'All closed. Your progress is saved (in the data folder). See you next time!' 'Green' }
else { Say 'All closed. Something went wrong above; the logs are in the upload folder if you need help.' 'Yellow' }
