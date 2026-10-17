# Dauntless Forever - Dauntless 1.14.7 offline package
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# lan-host-1147.ps1 - "LAN - HOST.bat": play 1.14.7 with another PC on the same home network (same design as 1.6.2).
#   - finds this PC's address on the home network
#   - lets other PCs on the home network (only) reach the backend (TCP 63000-63027) and the game servers (UDP 8780-8787)
#   - starts the normal PLAY in its own window, telling every game to use this PC's address for the servers
#   - shows the address to type on the other PC ("LAN - JOIN.bat")
#   - when PLAY is closed: takes the network openings away again
param([switch]$Elevated)
. (Join-Path $PSScriptRoot 'common.ps1')
$DataDir = Join-Path $Root 'data'
New-Item -ItemType Directory -Force $DataDir | Out-Null
$RuleTcp = 'Dauntless Forever LAN 1.14.7 - backend (TCP 63000-63027)'
$RuleUdp = 'Dauntless Forever LAN 1.14.7 - game servers (UDP 8780-8787)'
$DisabledList = Join-Path $DataDir 'lan_disabled_rules.txt'

# --- needs administrator (to change Windows Firewall)
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    if ($Elevated) { Fail 'this needs to run as administrator (it opens the game ports for your home network).' }
    Say 'Asking Windows for administrator rights (needed to open the game ports for your home network)...'
    try {
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated')
    } catch { Fail 'Windows did not give administrator rights. Right-click "LAN - HOST.bat" and choose "Run as administrator".' }
    exit 0
}

function Restore-Firewall {
    Remove-NetFirewallRule -DisplayName $RuleTcp -ErrorAction SilentlyContinue
    Remove-NetFirewallRule -DisplayName $RuleUdp -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $DisabledList) {
        foreach ($n in Get-Content -LiteralPath $DisabledList -ErrorAction SilentlyContinue) {
            if ($n) { Enable-NetFirewallRule -Name $n -ErrorAction SilentlyContinue }
        }
        Remove-Item -LiteralPath $DisabledList -Force -ErrorAction SilentlyContinue
    }
}

Say ''
Say '=== Dauntless 1.14.7 - LAN host (play with another PC on your home network) ===' 'Cyan'
$cfg = Get-Config
if (-not $cfg) { Fail 'set-up has not been run yet. Double-click "1 - SETUP.bat" first.' }
if (Test-Recorder) { Fail 'Dauntless 1.14.7 is already running on this PC (its backend answers). Close the game and PLAY first, then start LAN - HOST again.' }
Restore-Firewall    # leftovers from a LAN session that did not close properly

# --- 1. this PC's address on the home network
$ipFile = Join-Path $DataDir 'lan_ip.txt'
$ip = $null
if (Test-Path -LiteralPath $ipFile) {
    $t = ((Get-Content -LiteralPath $ipFile -Raw) + '').Trim()
    if ($t -match '^\d{1,3}(\.\d{1,3}){3}$') { $ip = $t; Say "Using the address in data\lan_ip.txt: $ip" }
}
if (-not $ip) {
    $cands = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue |
        Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
        ForEach-Object { $_.IPv4Address } | ForEach-Object { $_.IPAddress } |
        Where-Object { $_ -and $_ -notmatch '^(127\.|169\.254\.)' })
    if ($cands.Count -eq 0) { Fail 'could not find this PC''s address on the home network. Is it connected (cable or Wi-Fi)?' }
    $ip = $cands[0]
    if ($cands.Count -gt 1) { Say "This PC has several network addresses ($($cands -join ', ')); using $ip. To pick another, write it into data\lan_ip.txt." 'Yellow' }
}
Say "Address the other PC will use: $ip" 'Green'

# --- 2. firewall: allow the home network in, and pause Windows' own "blocked" entries for node / the game
#        (clicking Cancel on the Windows network prompt creates such block entries, and a block beats an allow)
$blockers = @(Get-NetFirewallRule -Direction Inbound -Action Block -Enabled True -ErrorAction SilentlyContinue | Where-Object {
    $app = ($_ | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue).Program
    $app -and ($app -match '\\node\.exe$' -or $app -match '\\Dauntless-Win64-Shipping\.exe$')
})
if ($blockers.Count) {
    [IO.File]::WriteAllLines($DisabledList, [string[]]@($blockers | ForEach-Object { $_.Name }))
    foreach ($b in $blockers) { Disable-NetFirewallRule -Name $b.Name -ErrorAction SilentlyContinue }
    Say "Paused $($blockers.Count) Windows Firewall block entr$(if ($blockers.Count -eq 1) {'y'} else {'ies'}) for node / Dauntless (turned back on when you stop)." 'Yellow'
}
# Allowed: the home network and Tailscale's private range (100.64.0.0/10). The backend itself also refuses anything else.
$allowFrom = @('LocalSubnet', '100.64.0.0/10')
New-NetFirewallRule -DisplayName $RuleTcp -Direction Inbound -Protocol TCP -LocalPort '63000-63027' -RemoteAddress $allowFrom -Profile Any -Action Allow | Out-Null
New-NetFirewallRule -DisplayName $RuleUdp -Direction Inbound -Protocol UDP -LocalPort '8780-8787' -RemoteAddress $allowFrom -Profile Any -Action Allow | Out-Null
Say 'Game ports opened for your home network only (not the open internet).' 'Green'

try {
    # --- 3. start the normal PLAY, with the backend open to the home network and every game sent to this PC's address
    $env:RECORDER_BIND = '0.0.0.0'
    $env:RECORDER_PUBLIC_HOST = $ip
    Say ''
    Say 'Starting PLAY in its own window (backend, game server, then your game)...'
    $play = Start-Process -FilePath 'powershell.exe' -PassThru -WorkingDirectory $Root `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $PSScriptRoot 'start.ps1')`"")
    [IO.File]::WriteAllText((Join-Path $Root 'LAN-join-address.txt'), $ip)
    Say ''
    Say '============================================================' 'Cyan'
    Say ' On the OTHER PC: double-click "LAN - JOIN.bat" and type this address:' 'Cyan'
    Say ''
    Say "   $ip" 'White'
    Say ''
    Say ' (It is also saved in LAN-join-address.txt in this folder.)'
    Say ' Wait until your own game has reached Ramsgate before the other PC joins.'
    Say '============================================================' 'Cyan'
    Say ''
    Say 'Keep this window open. When you close your game, PLAY shuts everything down and this window'
    Say 'closes the game ports again.'
    $play.WaitForExit()
}
finally {
    Restore-Firewall
    Say ''
    Say 'LAN session over: the game ports are closed again.' 'Green'
}
