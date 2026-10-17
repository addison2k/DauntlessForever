# Dauntless Forever - Dauntless 1.6.2 offline package
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# lan-join.ps1 - "LAN - JOIN.bat": play 1.6.2 on a friend's PC: on the same home network (LAN - HOST) or from
# anywhere through the Dauntless Forever relay (ONLINE - HOST). The join code says which: address|key or address:port|key.
# Starts only the game (no backend, no game servers on this PC), logged in with the account the host made,
# and pointed at the host. Needs "1 - SETUP.bat" to have been run on this PC once.
param([string]$Code = '')   # given by the launcher's Friends page: join without any questions
. (Join-Path $PSScriptRoot 'common.ps1')

Say ''
Say '=== Dauntless 1.6.2 - join a LAN game ===' 'Cyan'
$cfg = Get-Config
if (-not $cfg) { Fail 'set-up has not been run yet. Double-click "1 - SETUP.bat" first.' }
$Bin = Join-Path $cfg.GameDir 'Archon\Binaries\Win64'
$Exe = Join-Path $Bin 'Dauntless-Win64-Shipping.exe'
if ((Hash256 (Join-Path $Bin 'dxgi.dll')) -ne $LoaderHash -or (Hash256 (Join-Path $Bin 'UndauntedInternalServer.dll')) -ne $ServerHash) {
    Fail 'the game folder is missing files this package puts there. Run "1 - SETUP.bat" again.'
}
if ((Hash256 $Exe) -ne $ExeHash) { Fail 'the game in the saved folder is not Dauntless 1.6.2. Run "1 - SETUP.bat" again.' }
$missing = @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'xinput1_3.dll', 'x3daudio1_7.dll', 'xapofx1_5.dll') |
    Where-Object { -not (Test-Path -LiteralPath (Join-Path $env:WINDIR "System32\$_")) }
if (@($missing).Count -gt 0) { Fail "Windows is missing parts the game needs ($(@($missing) -join ', ')). Run set-up again: it installs them." }
if (@(Get-PlayerGame).Count -gt 0) { Fail 'the game is already running. Close it first.' }
Stop-Everything -Quiet      # this PC's own offline servers must not run at the same time

# --- the join code (host address | account key), remembered for next time
New-Item -ItemType Directory -Force $DataDir | Out-Null
$codeFile = Join-Path $DataDir 'lan_join_code.txt'
# (PowerShell names ignore case: $code IS the -Code parameter, so the remembered code goes in $saved;
#  before this fix the remembered code silently replaced the one the launcher passed in)
$fromLauncher = -not [string]::IsNullOrWhiteSpace($Code)
$saved = if (Test-Path -LiteralPath $codeFile) { ((Get-Content -LiteralPath $codeFile -Raw) + '').Trim() } else { '' }
if ($fromLauncher) {
    $code = $Code.Trim()
    Say 'Joining with the code from the launcher.'
} elseif ($saved) {
    $code = $saved
    $hostShown = ($code -split '\|')[0]
    $ans = Read-Host "Join $hostShown again? Press Enter for yes, or paste a new join code"
    if ($ans.Trim()) { $code = $ans.Trim() }
} else {
    $code = (Read-Host 'Paste the join code from the host (looks like 209.145.57.41:21000|UUK_... or 192.168.1.50|UUK_...)').Trim()
}
$code = $code -replace '\s', ''
if ($code -cnotmatch '^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{2,5}))?\|(UUK_[0-9A-Za-z]+)$') { Fail 'that does not look like a join code (address|UUK_... or address:port|UUK_...). Copy it again from the host window.' }
$hostIp = $Matches[1]; $key = $Matches[3]
$hostPort = if ($Matches[2]) { [int]$Matches[2] } else { $MetaPort }
if (-not $fromLauncher) { [IO.File]::WriteAllText($codeFile, $code) }

# --- is the host reachable?
Say "Checking the host at ${hostIp}:${hostPort}..."
$ok = $false
try { $r = Invoke-WebRequest -Uri "http://${hostIp}:$hostPort/dauntless-status" -UseBasicParsing -TimeoutSec 8; $ok = ($r.StatusCode -eq 200) } catch {}
if (-not $ok) {
    Fail ("cannot reach the host at ${hostIp}:$hostPort.`n" +
          "         - Is the host's LAN - HOST or ONLINE - HOST window still open, and has their game reached the main menu?`n" +
          "         - Is the join code from the host's CURRENT session? (Online codes change each time the host starts.)`n" +
          "         - LAN codes only work on the same home network as the host.")
}
Say 'Host found.' 'Green'

# --- your own character comes along (gear, inventory, progress) and goes home again when the game closes
#     (tools\travel.js; the host keeps it in the account it made for you). If a game ended without bringing it home
#     (crash, host gone), data\travel_pending.json says so: then the host's copy is the newer one and comes home first.
$node = $cfg.Node; if (-not $node -or -not (Test-Path -LiteralPath $node)) { $node = Find-Node }
$travel = Join-Path $PSScriptRoot 'travel.js'
$travelKey = $key
$pendingFile = Join-Path $DataDir 'travel_pending.json'
$canFetch = $false
function Invoke-Travel([string]$What) {
    $out = & $node $travel $What "${hostIp}:$hostPort" $travelKey 2>&1
    $c = $LASTEXITCODE
    foreach ($l in @($out)) { if ("$l".Trim()) { Say "  $l" } }
    return $c
}
if ($node -and (Test-Path -LiteralPath $travel)) {
    $pending = $null; try { $pending = Get-Content -LiteralPath $pendingFile -Raw | ConvertFrom-Json } catch {}
    if ($pending -and $pending.key -eq $travelKey) {
        Say 'Your last game with this host did not bring your character home. Doing that first...'
        if ((Invoke-Travel 'fetch') -ne 1) { Remove-Item -LiteralPath $pendingFile -Force -ErrorAction SilentlyContinue }
    }
    $null = Invoke-Travel 'backup'    # DF-ONLINE-1: a copy from before this game stays in data\travel-backups
    Say 'Bringing your character along...'
    $tc = Invoke-Travel 'send'
    if ($tc -eq 0 -or $tc -eq 2) {
        $canFetch = $true
        [IO.File]::WriteAllText($pendingFile, (@{ key = $travelKey; host = "${hostIp}:$hostPort"; since = (Get-Date -Format s) } | ConvertTo-Json))
    } else { Say '  Your character stays on this PC this time: the host''s game gives you its own character for you.' 'Yellow' }
}

# --- start only the game, pointed at the host
$privCfg = Join-Path $HomeDir 'AppData\Local\Archon\Saved\Config\WindowsClient'
foreach ($d in @($privCfg, (Join-Path $HomeDir 'AppData\Roaming'), (Join-Path $HomeDir 'Documents'))) { New-Item -ItemType Directory -Force $d | Out-Null }
$ini = (Get-Content -LiteralPath (Join-Path $Root 'profile\Game.ini') -Raw) -replace "127\.0\.0\.1:$MetaPort", "${hostIp}:$hostPort"
[IO.File]::WriteAllText((Join-Path $privCfg 'Game.ini'), $ini)
Set-ChatConfig $privCfg $hostIp $hostPort
Set-MenuBackground $privCfg   # main menu background picked in the launcher (Settings)
if ($node) { & $node (Join-Path $PSScriptRoot 'mod-paks.cjs') $cfg.GameDir }   # add-on paks: the same files as the host has

$gameArgs = @("${hostIp}:$hostPort", "-AUTH_PASSWORD=$key", '-AUTH_LOGIN=unused', '-AUTH_TYPE=exchangecode',
    '-epicapp=appidlol', '-epicenv=Prod', '-EpicPortal', '-epicusername=usernamelol', '-epicuserid=useridlol',
    '-epiclocale=en-US', '-epicsandboxid=sandboxidlol', '-epicdeploymentid=deploymentidlol') -join ' '
$gameArgs = Add-GameLanguage $gameArgs   # language picked in the launcher (Settings)
$gameArgs = Add-GameMods $gameArgs       # modded mode (launcher: 1.6.2 > Mods); your own game only
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Exe
$psi.Arguments = $gameArgs
$psi.WorkingDirectory = $Bin
$psi.UseShellExecute = $false
$psi.EnvironmentVariables['USERPROFILE']  = $HomeDir
$psi.EnvironmentVariables['LOCALAPPDATA'] = Join-Path $HomeDir 'AppData\Local'
$psi.EnvironmentVariables['APPDATA']      = Join-Path $HomeDir 'AppData\Roaming'
$startTime = Get-Date
$p = [Diagnostics.Process]::Start($psi)
$key = $null
Say ''
Say "THE GAME IS STARTING, joining $hostIp. It can take a minute to show up." 'Green'
Say 'If a popup about anti-cheat or "IGameClient" appears, click OK: that is normal offline.'
Say 'This window waits until you close the game.'
# While you play, your character is saved home every 3 minutes when something changed, and at once when the host
# says they are closing (the launcher leaves data\travel_save_now): a host who drops out costs you minutes at most.
$saveNowFile = Join-Path $DataDir 'travel_save_now'
Remove-Item -LiteralPath $saveNowFile -Force -ErrorAction SilentlyContinue
$lastSave = Get-Date
$autosave = $canFetch
while (-not $p.WaitForExit(5000)) {
    if (-not $autosave) { continue }
    $wanted = Test-Path -LiteralPath $saveNowFile
    if ($wanted -or ((Get-Date) - $lastSave).TotalSeconds -ge 180) {
        Remove-Item -LiteralPath $saveNowFile -Force -ErrorAction SilentlyContinue
        $lastSave = Get-Date
        $sc = Invoke-Travel 'autosave'
        if ($sc -eq 3) { $autosave = $false; Say '  Saving home is paused for this game: your own character on this PC stays as it was.' 'Yellow' }
    }
}
Remove-Item -LiteralPath $saveNowFile -Force -ErrorAction SilentlyContinue
Say "Game closed at $(Get-Date -Format HH:mm:ss)."
if ($canFetch) {
    Say 'Bringing your character home with what you earned...'
    $tc = Invoke-Travel 'fetch'
    if ($tc -ne 1) { Remove-Item -LiteralPath $pendingFile -Force -ErrorAction SilentlyContinue }
    else { Say '  Not now (has the host closed?). It stays safe on the host and comes home the next time you join them.' 'Yellow' }
}
Start-Sleep -Seconds 2

try {
    $savedDirs = @((Join-Path $HomeDir 'AppData\Local\Archon\Saved'), (Join-Path $env:LOCALAPPDATA 'Archon\Saved')) | Where-Object { Test-Path -LiteralPath $_ }
    $files = @(foreach ($sd in $savedDirs) {
        foreach ($sub in @('Logs', 'Crashes')) {
            $dir = Join-Path $sd $sub
            if (-not (Test-Path -LiteralPath $dir)) { continue }
            Get-ChildItem -LiteralPath $dir -Recurse -File -Include *.log, *.txt, *.xml, *.runtime-xml -ErrorAction SilentlyContinue |
                Where-Object { $_.LastWriteTime -ge $startTime.AddMinutes(-1) } | ForEach-Object { $_.FullName }
        }
    })
    Save-LogZip $files 'client_logs_lan.zip'
    Say 'Logs for asking for help: upload\client_logs_lan.zip' 'Green'
} catch { Say "Could not collect the logs: $($_.Exception.Message)" 'Yellow' }
exit 0
