# Dauntless Forever - Dauntless 1.14.7 offline package
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# start.ps1 - "2 - PLAY.bat": starts the local backend, then the game server, then the game, in that order.
# When the game is closed, the server and the backend are shut down again.
. (Join-Path $PSScriptRoot 'common.ps1')

Say ''
Say '=== Dauntless 1.14.7 offline ===' 'Cyan'
$cfg = Get-Config
if (-not $cfg) { Fail 'set-up has not been run yet. Double-click "1 - SETUP.bat" first.' }
$bin = Join-Path $cfg.GameDir 'Archon\Binaries\Win64'
if ((Hash256 (Join-Path $bin 'EOSSDK-Win64-Shipping.dll')) -ne $StandInHash -or (Hash256 (Join-Path $bin 'dxgi.dll')) -ne $LoaderHash) {
    Fail 'the game folder is missing files this package puts there (maybe the game was updated or verified). Run "1 - SETUP.bat" again.'
}
foreach ($gp in $GamePaks) {
    if ((Hash256 (Join-Path $cfg.GameDir "Archon\Content\Paks\$($gp.Name)")) -ne $gp.Hash) {
        Fail "the $($gp.What) is not in the game folder yet (new in these server files). Run `"1 - SETUP.bat`" again."
    }
}
$node = $cfg.Node
if (-not $node -or -not (Test-Path -LiteralPath $node)) { $node = Find-Node }
if (-not $node) { Fail 'Node.js was not found. Run "1 - SETUP.bat" again.' }
# Windows parts the game needs (Visual C++ runtime, DirectX June 2010). Without them every copy of the game
# closes at once with no log, so say it plainly here instead.
$missing = @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'xinput1_3.dll', 'x3daudio1_7.dll', 'xapofx1_5.dll') |
    Where-Object { -not (Test-Path -LiteralPath (Join-Path $env:WINDIR "System32\$_")) }
if (@($missing).Count -gt 0) { Fail "Windows is missing parts the game needs ($(@($missing) -join ', ')). Run set-up again: it installs them." }
if (@(Get-PlayerGame).Count -gt 0) { Fail 'the game is already running. Close it first (or end Dauntless-Win64-Shipping in Task Manager).' }

$dataDir = Join-Path $Root 'data'
New-Item -ItemType Directory -Force $dataDir, (Join-Path $Root 'logs') | Out-Null

# --- leftovers from a run that did not close properly
$left = Get-ServerCopies
if ($left.Count -gt 0) { Say "Closing $($left.Count) leftover server copy(ies) from last time..."; foreach ($c in $left) { Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 2 }
foreach ($f in @('server.json', 'server_hunt.json', 'wanted.json')) { $fp = Join-Path $dataDir $f; if (Test-Path -LiteralPath $fp) { Remove-Item -LiteralPath $fp -Force } }

# --- 1. backend
$recorder = Join-Path $Root 'backend\recorder-1147.js'
$recProc = $null
if (Test-Recorder) { Say '1/3 Local backend: already running.' 'Green' }
else {
    Say '1/3 Starting the local backend (a small minimized window)...'
    $recProc = Start-Process -FilePath $node -ArgumentList ('"' + $recorder + '"') -WorkingDirectory $Root -WindowStyle Minimized -PassThru
    $t0 = Get-Date
    while (-not (Test-Recorder)) {
        if ($recProc.HasExited) { Fail "the local backend stopped right away. Another program may be using ports 63000-63027. Restart the PC and try again." }
        if (((Get-Date) - $t0).TotalSeconds -gt 30) { Fail 'the local backend did not start within 30 seconds.' }
        Start-Sleep -Milliseconds 500
    }
    Say '    Local backend: running.' 'Green'
}

# --- 2. game server (hidden; its PowerShell window is minimized)
Say '2/3 Starting the game server. This takes about a minute, please wait...'
$serverPs1 = Join-Path $PSScriptRoot 'server-1147.ps1'
$srvWin = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $serverPs1 + '"'), '-Run') -WindowStyle Minimized -PassThru
$marker = Join-Path $dataDir 'server.json'
$t0 = Get-Date; $dots = 0
while (-not (Test-Path -LiteralPath $marker)) {
    if ($srvWin.HasExited) {
        Fail "the game server stopped before it was ready. Look at upload\server_logs.zip, or send it to whoever helps you."
    }
    if (((Get-Date) - $t0).TotalSeconds -gt 300) { Fail 'the game server was not ready after 5 minutes.' }
    Start-Sleep -Seconds 2; $dots++
    if ($dots % 5 -eq 0) { Write-Host ("    still starting... {0} s" -f [int]((Get-Date) - $t0).TotalSeconds) }
}
Say ("    Game server: ready after {0} s." -f [int]((Get-Date) - $t0).TotalSeconds) 'Green'

# --- 3. the game (this window waits until it is closed)
Say '3/3 Starting the game...'
$playOk = $true
try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'play-1147.ps1'); if ($LASTEXITCODE -ne 0) { $playOk = $false } }
catch { $playOk = $false; Say $_.Exception.Message 'Yellow' }

# --- shut down
Say ''
Say 'Shutting down the game server and the local backend...'
foreach ($c in Get-ServerCopies) { Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue }
$t0 = Get-Date
while (-not $srvWin.HasExited -and ((Get-Date) - $t0).TotalSeconds -lt 60) { Start-Sleep -Seconds 1 }   # it zips its logs, then closes
if (-not $srvWin.HasExited) { Stop-Process -Id $srvWin.Id -Force -ErrorAction SilentlyContinue }
$pidFile = Join-Path $dataDir 'recorder.pid'
$recPid = if ($recProc) { $recProc.Id } elseif (Test-Path -LiteralPath $pidFile) { [int]((Get-Content -LiteralPath $pidFile -Raw).Trim()) } else { 0 }
if ($recPid) {
    $rp = Get-Process -Id $recPid -ErrorAction SilentlyContinue
    if ($rp -and $rp.ProcessName -eq 'node') { Stop-Process -Id $recPid -Force -ErrorAction SilentlyContinue }
}
Say ''
if ($playOk) { Say 'All closed. Your progress is saved (data\state.json). See you next time!' 'Green' }
else { Say 'All closed. Something went wrong above; the logs are in the upload folder if you need help.' 'Yellow' }
