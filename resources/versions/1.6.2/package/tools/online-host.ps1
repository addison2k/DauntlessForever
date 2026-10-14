# Dauntless Forever - Dauntless 1.6.2 offline package
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# online-host.ps1 - "ONLINE - HOST.bat": play 1.6.2 with friends anywhere, hosted on this PC, through the
# Dauntless Forever relay. Nothing to install, no router settings, no administrator rights: this PC only makes
# outgoing connections to the relay, and players' traffic reaches this PC's servers from inside the PC.
#   - connects to the relay (tools\relay-client.js, run with the package's Node.js) and gets a public address
#   - starts the normal PLAY in its own window, telling every game to join that address
#   - makes an account for the friend and shows a join code (address:port|key)
#   - when PLAY is closed: disconnects from the relay
#   -Public (the launcher's "Play online" or "Allow randoms"): anyone can join, and hunts stay open to join for
#   3 minutes after they start (HUNT_JOIN_WINDOW_SEC, read by the backend). Without it: friends only, as before. DF-ONLINE-1
param([switch]$Public)
. (Join-Path $PSScriptRoot 'common.ps1')

$DefaultRelay = '209.145.57.41'          # the Dauntless Forever relay; data\relay_host.txt overrides it
$RelayControlPort = 7000
$FriendKeyFile = Join-Path $DataDir 'lan_friend.key'
$StatusFile = Join-Path $DataDir 'relay.json'

Say ''
Say '=== Dauntless 1.6.2 - ONLINE host (friends join from anywhere) ===' 'Cyan'
$cfg = Get-Config
if (-not $cfg) { Fail 'set-up has not been run yet. Double-click "1 - SETUP.bat" first.' }
$node = $cfg.Node
if (-not $node -or -not (Test-Path -LiteralPath $node)) { Fail 'Node.js from set-up is missing. Run "1 - SETUP.bat" again.' }
New-Item -ItemType Directory -Force $DataDir | Out-Null

$relayHost = $DefaultRelay
# Where the relay is: network.json in the Dauntless Forever repo (so the VPS can move without new files),
# remembered in data\network.json for when GitHub cannot be reached. data\relay_host.txt still overrides it.
$netCache = Join-Path $DataDir 'network.json'
try {
    $net = Invoke-RestMethod -Uri ("https://raw.githubusercontent.com/addison2k/DauntlessForever/main/network.json?t=" + [DateTime]::UtcNow.Ticks) -TimeoutSec 8
    if ($net.relay.host) { $relayHost = "$($net.relay.host)"; if ($net.relay.controlPort) { $RelayControlPort = [int]$net.relay.controlPort }; ($net | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $netCache -Encoding ASCII }
} catch {
    try { $net = Get-Content -LiteralPath $netCache -Raw | ConvertFrom-Json; if ($net.relay.host) { $relayHost = "$($net.relay.host)"; if ($net.relay.controlPort) { $RelayControlPort = [int]$net.relay.controlPort } } } catch {}
}
# Online play can be switched off for everyone from network.json ("online": {"enabled": false, "message": "..."}),
# for example while the server is being fixed. Solo play is never affected.
if ($net -and $net.online -and ($net.online.enabled -eq $false)) {
    $why = if ($net.online.message) { "$($net.online.message)" } else { 'The Dauntless Forever online server is being worked on.' }
    Fail "online play is switched off right now: $why Solo play (PLAY) still works."
}
# Several relays ("relays": [...], one per region): use the one this PC reaches fastest, so EU players host in the EU.
function Measure-Relay([string]$H, [int]$Port) {
    $best = $null
    for ($i = 0; $i -lt 3; $i++) {
        $c = New-Object System.Net.Sockets.TcpClient
        $sw = [Diagnostics.Stopwatch]::StartNew()
        try { $t = $c.ConnectAsync($H, $Port); if ($t.Wait(2000) -and $c.Connected) { $ms = $sw.ElapsedMilliseconds; if ($best -eq $null -or $ms -lt $best) { $best = $ms } } } catch {} finally { $c.Close() }
    }
    return $best
}
if ($net -and $net.relays -and @($net.relays).Count -gt 0) {
    $picked = $null
    foreach ($r in @($net.relays)) {
        $port = if ($r.controlPort) { [int]$r.controlPort } else { 7000 }
        $ms = Measure-Relay "$($r.host)" $port
        $label = if ($r.name) { "$($r.name)" } else { "$($r.host)" }
        if ($ms -ne $null) { Say "  Relay ${label}: $ms ms" } else { Say "  Relay ${label}: no answer" 'Yellow' }
        if ($ms -ne $null -and ($picked -eq $null -or $ms -lt $picked.ms)) { $picked = @{ host = "$($r.host)"; port = $port; ms = $ms; label = $label } }
    }
    if ($picked) {
        $relayHost = $picked.host; $RelayControlPort = $picked.port
        Say "Using the $($picked.label) relay ($($picked.ms) ms)." 'Green'
        if ($picked.ms -gt 150) { Say "  That is far from you: friends near you may lag. A relay closer to you would help (ask in the Discord)." 'Yellow' }
    }
}
$hostFile = Join-Path $DataDir 'relay_host.txt'
if (Test-Path -LiteralPath $hostFile) {
    $t = ((Get-Content -LiteralPath $hostFile -Raw) + '').Trim()
    if ($t) { $relayHost = $t; Say "Using the relay in data\relay_host.txt: $relayHost" }
}

# --- 1. connect to the relay
Remove-Item -LiteralPath $StatusFile -Force -ErrorAction SilentlyContinue
$logDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$relayLog = Join-Path $logDir 'relay.log'
Say "Connecting to the Dauntless Forever relay ($relayHost)..."
$relay = Start-Process -FilePath $node -PassThru -WindowStyle Hidden -WorkingDirectory $Root `
    -ArgumentList @("`"$(Join-Path $PSScriptRoot 'relay-client.js')`"", $relayHost, "$RelayControlPort", "`"$StatusFile`"") `
    -RedirectStandardOutput $relayLog -RedirectStandardError (Join-Path $logDir 'relay.err')
$t0 = Get-Date
while (-not (Test-Path -LiteralPath $StatusFile)) {
    if ($relay.HasExited) { Fail "could not start the relay connection. See logs\relay.log." }
    if (((Get-Date) - $t0).TotalSeconds -gt 20) {
        try { $relay.Kill() } catch {}
        Fail "the relay at $relayHost did not answer. Is this PC online? (Details: logs\relay.log)"
    }
    Start-Sleep -Milliseconds 300
}
$st = Get-Content -LiteralPath $StatusFile -Raw | ConvertFrom-Json
$ip = "$($st.ip)"; $base = [int]$st.base
if (-not ($ip -match '^\d{1,3}(\.\d{1,3}){3}$')) { $ip = $relayHost }
Say "Relay connected. Friends reach this PC at ${ip}:$base." 'Green'

try {
    # --- 2. start the normal PLAY, with every game told to join through the relay
    $env:MY_IP = $ip                                     # deploy server: the address it gives games
    $env:PUBLIC_PORT_OFFSET = "$($base - 8770)"          # ...and relay ports instead of 8770-8777
    $env:QOS_TARGET_URL = "http://${ip}:$base/QoS"       # the "ping" address the game is given
    Remove-Item Env:\BIND_HOST -ErrorAction SilentlyContinue   # backend stays on this PC only: the relay reaches it locally
    if ($Public) {
        $env:HUNT_JOIN_WINDOW_SEC = '180'
        Say 'Open to everyone: players from "Play online" can join you, and join your hunts in the first 3 minutes.' 'Green'
    } else { Remove-Item Env:\HUNT_JOIN_WINDOW_SEC -ErrorAction SilentlyContinue }
    Say ''
    Say 'Starting PLAY in its own window (backend, game servers, then your game)...'
    $play = Start-Process -FilePath 'powershell.exe' -PassThru -WorkingDirectory $Root `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $PSScriptRoot 'start.ps1')`"")

    # --- 3. an account for the friend (made once, kept in data\lan_friend.key)
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
        if (-not $fkey.StartsWith('UUK_')) { Fail 'could not make the account for your friend (the backend did not answer the sign-up).' }
        [IO.File]::WriteAllText($FriendKeyFile, $fkey)
        Say "Made a second account ($name) for your friend." 'Green'
    }
    $code = "${ip}:$base|$fkey"
    [IO.File]::WriteAllText((Join-Path $Root 'ONLINE-join-code.txt'), $code)

    # quick self-check: the backend answers through the relay
    try { $ok = (Invoke-WebRequest -Uri "http://${ip}:$base/dauntless-status" -UseBasicParsing -TimeoutSec 8).StatusCode -eq 200 } catch { $ok = $false }
    if ($ok) { Say 'Checked: your backend answers through the relay.' 'Green' }
    else { Say 'Warning: your backend did not answer through the relay yet. If your friend cannot join, send logs\relay.log.' 'Yellow' }

    Say ''
    Say '============================================================' 'Cyan'
    Say ' Your friend: double-click "LAN - JOIN.bat" and paste this join code:' 'Cyan'
    Say ''
    Say "   $code" 'White'
    Say ''
    Say ' (Also saved in ONLINE-join-code.txt. It is the password for that account: send it privately,'
    Say '  never in a public channel or on stream.)'
    Say '============================================================' 'Cyan'
    Say ''
    Say 'Keep this window open. When you close your game, PLAY shuts everything down and this window'
    Say 'disconnects from the relay.'
    while (-not $play.HasExited) {
        if ($relay.HasExited) { Say 'The relay connection program stopped. Friends cannot reach you until you start ONLINE - HOST again.' 'Yellow'; break }
        Start-Sleep -Seconds 2
    }
    $play.WaitForExit()
}
finally {
    try { if (-not $relay.HasExited) { $relay.Kill() } } catch {}
    Remove-Item -LiteralPath $StatusFile -Force -ErrorAction SilentlyContinue
    Say ''
    Say 'Online session over: disconnected from the relay.' 'Green'
}
