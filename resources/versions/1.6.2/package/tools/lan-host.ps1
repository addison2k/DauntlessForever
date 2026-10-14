# Dauntless Forever - Dauntless 1.6.2 offline package
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# lan-host.ps1 - "LAN - HOST.bat": play 1.6.2 with another PC on the same home network (LAN test).
#   - finds this PC's address on the home network
#   - lets other PCs on the home network (only) reach the backend (TCP 61000) and the game servers (UDP 8770-8777)
#   - starts the normal PLAY in its own window, telling every game to join this PC's address
#   - makes an account for the other PC and shows a join code (address|key) to type or paste there
#   - when PLAY is closed: takes the network openings away again
param([switch]$Elevated)
. (Join-Path $PSScriptRoot 'common.ps1')

$RuleTcp = 'Dauntless Forever LAN - backend (TCP 61000)'
$RuleUdp = 'Dauntless Forever LAN - game servers (UDP 8770-8777)'
$DisabledList = Join-Path $DataDir 'lan_disabled_rules.txt'
$FriendKeyFile = Join-Path $DataDir 'lan_friend.key'

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
Say '=== Dauntless 1.6.2 - LAN host (play with another PC on your home network) ===' 'Cyan'
$cfg = Get-Config
if (-not $cfg) { Fail 'set-up has not been run yet. Double-click "1 - SETUP.bat" first.' }
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
Say "Address other PCs will use: $ip" 'Green'
$mine = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.IPAddress })
if ($ip -notin $mine) {
    # Not an address of this PC: the VPS relay. Its tunnel (WireGuard, tunnel "dauntless-relay") must be on.
    if (Test-Connection -ComputerName '10.77.0.1' -Count 2 -Quiet -ErrorAction SilentlyContinue) {
        Say 'VPS relay: tunnel is up. Friends connect through the VPS.' 'Green'
    } else {
        Fail "the address in data\lan_ip.txt ($ip) is not this PC, so it should be the VPS relay, but the relay tunnel is not answering. Open WireGuard and click Activate on the dauntless-relay tunnel, then start LAN - HOST again. (To play on the home network instead, delete data\lan_ip.txt.)"
    }
}
$ts = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.IPAddress } | Where-Object { $_ -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.' })
if ($ts.Count -and $ip -notin $ts) {
    Say "Tailscale is on this PC ($($ts[0])). To play with a friend over Tailscale, write $($ts[0]) into data\lan_ip.txt and start LAN - HOST again." 'Yellow'
}

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
# Allowed: the home network, Tailscale's private range (100.64.0.0/10), and the VPS relay tunnel (10.77.0.0/24).
$allowFrom = @('LocalSubnet', '100.64.0.0/10', '10.77.0.0/24')
New-NetFirewallRule -DisplayName $RuleTcp -Direction Inbound -Protocol TCP -LocalPort $MetaPort -RemoteAddress $allowFrom -Profile Any -Action Allow | Out-Null
New-NetFirewallRule -DisplayName $RuleUdp -Direction Inbound -Protocol UDP -LocalPort '8770-8777' -RemoteAddress $allowFrom -Profile Any -Action Allow | Out-Null
Say 'Game ports opened for your home network and Tailscale only (not the open internet).' 'Green'

try {
    # --- 3. start the normal PLAY, with every game told to join this PC's address
    $env:BIND_HOST = '0.0.0.0'                              # backend: accept the other PC (still only through the rules above)
    $env:MY_IP = $ip                                       # deploy server: the address it gives games for Ramsgate / hunts
    $env:QOS_TARGET_URL = "http://${ip}:$MetaPort/QoS"     # the "ping" address the game is given
    Say ''
    Say 'Starting PLAY in its own window (backend, game servers, then your game)...'
    $play = Start-Process -FilePath 'powershell.exe' -PassThru -WorkingDirectory $Root `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $PSScriptRoot 'start.ps1')`"")

    # --- 4. an account for the other PC (made once, kept in data\lan_friend.key)
    $t0 = Get-Date
    while (-not (Test-Meta)) {
        if ($play.HasExited) { Fail 'PLAY stopped before the backend was ready; see its window or upload\server_logs.zip.' }
        if (((Get-Date) - $t0).TotalSeconds -gt 120) { Fail 'the backend did not start within 2 minutes.' }
        Start-Sleep -Seconds 1
    }
    $fkey = if (Test-Path -LiteralPath $FriendKeyFile) { ((Get-Content -LiteralPath $FriendKeyFile -Raw) + '').Trim() } else { '' }
    if (-not $fkey.StartsWith('UUK_')) {
        $name = 'Friend' + (Get-Random -Minimum 100 -Maximum 999)
        try {
            $r = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$MetaPort/undaunted/api/Register" -ContentType 'application/json' `
                -Body (@{ Username = $name } | ConvertTo-Json) -TimeoutSec 10
            $fkey = "$($r.UUK)".Trim()
        } catch { $fkey = '' }
        if (-not $fkey.StartsWith('UUK_')) { Fail 'could not make the account for the other PC (the backend did not answer the sign-up).' }
        [IO.File]::WriteAllText($FriendKeyFile, $fkey)
        Say "Made a second account ($name) for the other PC." 'Green'
    }
    $code = "$ip|$fkey"
    [IO.File]::WriteAllText((Join-Path $Root 'LAN-join-code.txt'), $code)

    Say ''
    Say '============================================================' 'Cyan'
    Say ' On the OTHER PC: double-click "LAN - JOIN.bat" and paste this join code:' 'Cyan'
    Say ''
    Say "   $code" 'White'
    Say ''
    Say ' (It is also saved in LAN-join-code.txt in this folder. It is a password for that account:'
    Say '  only give it to people on your home network you play with.)'
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
