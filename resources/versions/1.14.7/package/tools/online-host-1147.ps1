# Dauntless Forever - Dauntless 1.14.7 offline package
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# online-host-1147.ps1 - "ONLINE - HOST.bat": play 1.14.7 with friends anywhere, hosted on this PC, through the
# Dauntless Forever relay (same relay and same steps as 1.6.2's ONLINE - HOST). No router settings, no administrator
# rights: this PC only makes outgoing connections to the relay.
#   - tools\df-gateway-1147.js: the relay's one TCP port -> the right one of the 28 backend ports (63000-63027)
#   - tools\relay-client.js: connects to the relay (game servers UDP 8780-8787, the gateway for the backend)
#   - starts the normal PLAY in its own window, telling every game to use the relay's address
#   - shows the join code (address:port) for the friend's "LAN - JOIN.bat"
#   - when PLAY is closed: disconnects from the relay
. (Join-Path $PSScriptRoot 'common.ps1')
$DataDir = Join-Path $Root 'data'
$DefaultRelay = '209.145.57.41'          # the Dauntless Forever relay; data\relay_host.txt overrides it
$RelayControlPort = 7000
$GatewayPort = 63099
$StatusFile = Join-Path $DataDir 'relay-1147.json'   # not relay.json: the launcher's Friends page reads that one for 1.6.2

Say ''
Say '=== Dauntless 1.14.7 - ONLINE host (friends join from anywhere) ===' 'Cyan'
$cfg = Get-Config
if (-not $cfg) { Fail 'set-up has not been run yet. Double-click "1 - SETUP.bat" first.' }
$node = $cfg.Node
if (-not $node -or -not (Test-Path -LiteralPath $node)) { $node = Find-Node }
if (-not $node -or -not (Test-Path -LiteralPath $node)) { Fail 'Node.js from set-up is missing. Run "1 - SETUP.bat" again.' }
if (Test-Recorder) { Fail 'Dauntless 1.14.7 is already running on this PC (its backend answers). Close the game and PLAY first, then start ONLINE - HOST again.' }
New-Item -ItemType Directory -Force $DataDir | Out-Null

# --- which relay (network.json in the Dauntless Forever repo, as for 1.6.2; data\relay_host.txt overrides it)
$relayHost = $DefaultRelay
$netCache = Join-Path $DataDir 'network.json'
$net = $null
try {
    $net = Invoke-RestMethod -Uri ("https://raw.githubusercontent.com/addison2k/DauntlessForever/main/network.json?t=" + [DateTime]::UtcNow.Ticks) -TimeoutSec 8
    if ($net.relay.host) { $relayHost = "$($net.relay.host)"; if ($net.relay.controlPort) { $RelayControlPort = [int]$net.relay.controlPort }; ($net | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $netCache -Encoding ASCII }
} catch {
    try { $net = Get-Content -LiteralPath $netCache -Raw | ConvertFrom-Json; if ($net.relay.host) { $relayHost = "$($net.relay.host)"; if ($net.relay.controlPort) { $RelayControlPort = [int]$net.relay.controlPort } } } catch {}
}
if ($net -and $net.online -and ($net.online.enabled -eq $false)) {
    $why = if ($net.online.message) { "$($net.online.message)" } else { 'The Dauntless Forever online server is being worked on.' }
    Fail "online play is switched off right now: $why Solo play (PLAY) still works."
}
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
    if ($picked) { $relayHost = $picked.host; $RelayControlPort = $picked.port; Say "Using the $($picked.label) relay ($($picked.ms) ms)." 'Green' }
}
$hostFile = Join-Path $DataDir 'relay_host.txt'
if (Test-Path -LiteralPath $hostFile) { $t = ((Get-Content -LiteralPath $hostFile -Raw) + '').Trim(); if ($t) { $relayHost = $t; Say "Using the relay in data\relay_host.txt: $relayHost" } }

# --- 1. the gateway, then the relay connection
$logDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
Remove-Item -LiteralPath $StatusFile -Force -ErrorAction SilentlyContinue
$gateway = Start-Process -FilePath $node -PassThru -WindowStyle Hidden -WorkingDirectory $Root `
    -ArgumentList @("`"$(Join-Path $PSScriptRoot 'df-gateway-1147.js')`"") `
    -RedirectStandardOutput (Join-Path $logDir 'gateway.log') -RedirectStandardError (Join-Path $logDir 'gateway.err')
Start-Sleep -Milliseconds 800
if ($gateway.HasExited) { Fail 'the backend gateway did not start (port 63099 in use?). See logs\gateway.log.' }
$env:LOCAL_BACKEND_PORT = "$GatewayPort"          # relay-client.js: friends' backend connections go to the gateway
$env:LOCAL_GAME_PORT_BASE = '8780'                # ...and game traffic to this version's servers (UDP 8780-8787)
Say "Connecting to the Dauntless Forever relay ($relayHost)..."
$relay = Start-Process -FilePath $node -PassThru -WindowStyle Hidden -WorkingDirectory $Root `
    -ArgumentList @("`"$(Join-Path $PSScriptRoot 'relay-client.js')`"", $relayHost, "$RelayControlPort", "`"$StatusFile`"") `
    -RedirectStandardOutput (Join-Path $logDir 'relay.log') -RedirectStandardError (Join-Path $logDir 'relay.err')
$t0 = Get-Date
while (-not (Test-Path -LiteralPath $StatusFile)) {
    if ($relay.HasExited) { try { $gateway.Kill() } catch {}; Fail 'could not start the relay connection. See logs\relay.log.' }
    if (((Get-Date) - $t0).TotalSeconds -gt 20) { try { $relay.Kill() } catch {}; try { $gateway.Kill() } catch {}; Fail "the relay at $relayHost did not answer. Is this PC online? (Details: logs\relay.log)" }
    Start-Sleep -Milliseconds 300
}
$st = Get-Content -LiteralPath $StatusFile -Raw | ConvertFrom-Json
$ip = "$($st.ip)"; $base = [int]$st.base
if (-not ($ip -match '^\d{1,3}(\.\d{1,3}){3}$')) { $ip = $relayHost }
Say "Relay connected. Friends reach this PC at ${ip}:$base." 'Green'

try {
    # --- 2. the normal PLAY: backend stays on this PC only (the relay reaches it from inside), games are sent to the relay
    Remove-Item Env:\RECORDER_BIND -ErrorAction SilentlyContinue
    $env:RECORDER_PUBLIC_HOST = $ip
    $env:RECORDER_PUBLIC_PORT_OFFSET = "$($base - 8780)"
    $env:RECORDER_PUBLIC_BACKEND_PORT = "$base"
    Say ''
    Say 'Starting PLAY in its own window (backend, game server, then your game)...'
    $play = Start-Process -FilePath 'powershell.exe' -PassThru -WorkingDirectory $Root `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $PSScriptRoot 'start.ps1')`"")
    $code = "${ip}:$base"
    [IO.File]::WriteAllText((Join-Path $Root 'ONLINE-join-code.txt'), $code)
    # self-check once the backend is up: it answers through the relay
    $t0 = Get-Date
    while (-not (Test-Recorder) -and -not $play.HasExited -and ((Get-Date) - $t0).TotalSeconds -lt 120) { Start-Sleep -Seconds 1 }
    $ok = $false
    try { Invoke-RestMethod -Uri "http://${ip}:$base/_recorder/ping" -TimeoutSec 8 | Out-Null; $ok = $true } catch {}
    if ($ok) { Say 'Checked: your backend answers through the relay.' 'Green' }
    else { Say 'Warning: your backend did not answer through the relay yet. If your friend cannot join, send logs\relay.log and logs\gateway.log.' 'Yellow' }
    Say ''
    Say '============================================================' 'Cyan'
    Say ' Your friend: double-click "LAN - JOIN.bat" and paste this join code:' 'Cyan'
    Say ''
    Say "   $code" 'White'
    Say ''
    Say ' (Also saved in ONLINE-join-code.txt. It changes each time you start ONLINE - HOST.'
    Say '  Anyone with it can join while you host: send it privately.)'
    Say '============================================================' 'Cyan'
    Say ''
    Say 'Keep this window open. When you close your game, PLAY shuts everything down and this window disconnects.'
    while (-not $play.HasExited) {
        if ($relay.HasExited) { Say 'The relay connection program stopped. Friends cannot reach you until you start ONLINE - HOST again.' 'Yellow'; break }
        Start-Sleep -Seconds 2
    }
    $play.WaitForExit()
}
finally {
    try { if (-not $relay.HasExited) { $relay.Kill() } } catch {}
    try { if (-not $gateway.HasExited) { $gateway.Kill() } } catch {}
    Remove-Item -LiteralPath $StatusFile -Force -ErrorAction SilentlyContinue
    Say ''
    Say 'Online session over: disconnected from the relay.' 'Green'
}
