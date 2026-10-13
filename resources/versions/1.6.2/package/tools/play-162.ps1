# play-162.ps1 - start the Dauntless 1.6.2 game itself, logged in to the local backend, with a private settings folder.
# Normally started by "2 - PLAY.bat" (tools\start.ps1) after the backend and the game servers are up.
# Waits until you close the game, then puts the logs into upload\client_logs.zip (PC name and user name blanked).
. (Join-Path $PSScriptRoot 'common.ps1')

$cfg = Get-Config
if (-not $cfg) { Fail 'set-up has not been run yet. Double-click "1 - SETUP.bat" first.' }
$Bin = Join-Path $cfg.GameDir 'Archon\Binaries\Win64'
$Exe = Join-Path $Bin 'Dauntless-Win64-Shipping.exe'

if (@(Get-PlayerGame).Count -gt 0) { Fail 'the game is already running. Close it first.' }
if (-not (Test-Meta)) { Fail 'the local backend is not running. Start the game with "2 - PLAY.bat".' }
$keyFile = Join-Path $DataDir 'player.key'
$key = if (Test-Path -LiteralPath $keyFile) { (Get-Content -LiteralPath $keyFile -Raw).Trim() } else { '' }
if (-not $key.StartsWith('UUK_')) { Fail 'your account key (data\player.key) is missing. Run "1 - SETUP.bat" again.' }

# private settings folder: your normal Dauntless settings are not touched
$privCfg = Join-Path $HomeDir 'AppData\Local\Archon\Saved\Config\WindowsClient'
foreach ($d in @($privCfg, (Join-Path $HomeDir 'AppData\Roaming'), (Join-Path $HomeDir 'Documents'))) { New-Item -ItemType Directory -Force $d | Out-Null }
Copy-Item -LiteralPath (Join-Path $Root 'profile\Game.ini') -Destination (Join-Path $privCfg 'Game.ini') -Force

# The first argument is the backend address; the DLL in client mode points the game at it.
$gameArgs = @("127.0.0.1:$MetaPort", "-AUTH_PASSWORD=$key", '-AUTH_LOGIN=unused', '-AUTH_TYPE=exchangecode',
    '-epicapp=appidlol', '-epicenv=Prod', '-EpicPortal', '-epicusername=usernamelol', '-epicuserid=useridlol',
    '-epiclocale=en-US', '-epicsandboxid=sandboxidlol', '-epicdeploymentid=deploymentidlol') -join ' '

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
Say 'THE GAME IS STARTING (it can take a minute to show up). Have fun!' 'Green'
Say 'A small black text window opens with the game: that is normal, leave it open.'
Say 'If a popup about anti-cheat or "IGameClient" appears, click OK: that is normal offline.'
Say 'This window waits until you close the game, then shuts everything down for you.'
$p.WaitForExit()
Say "Game closed at $(Get-Date -Format HH:mm:ss)."
Start-Sleep -Seconds 2

# collect the game's logs (for asking for help)
try {
    # the game writes to the real %LOCALAPPDATA%\Archon\Saved (it ignores the private home), so look in both
    $savedDirs = @((Join-Path $HomeDir 'AppData\Local\Archon\Saved'), (Join-Path $env:LOCALAPPDATA 'Archon\Saved')) | Where-Object { Test-Path -LiteralPath $_ }
    $files = @(foreach ($sd in $savedDirs) {
        foreach ($sub in @('Logs', 'Crashes')) {
            $dir = Join-Path $sd $sub
            if (-not (Test-Path -LiteralPath $dir)) { continue }
            Get-ChildItem -LiteralPath $dir -Recurse -File -Include *.log, *.txt, *.xml, *.runtime-xml -ErrorAction SilentlyContinue |
                Where-Object { $_.LastWriteTime -ge $startTime.AddMinutes(-1) } | ForEach-Object { $_.FullName }
        }
    })
    Save-LogZip $files 'client_logs.zip'
} catch { Say "Could not collect the logs: $($_.Exception.Message)" 'Yellow' }
exit 0
