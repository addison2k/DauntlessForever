# Dauntless Forever - relay failover (shared by the online host scripts)
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
#
# Get-RelayCandidates: every relay in network.json, fastest first. The player's preferred server
# (data\relay_prefer.txt: us / eu / au ..., written by the launcher's Settings page; "auto" or no file = fastest)
# goes first when it answers. data\relay_host.txt (for testing) still forces one relay, with no failover.
# Connect-Relay: tries the candidates in order (at most 3), $PerRelaySeconds each, with a countdown on screen.
# A relay that does not hand out a slot in time is dropped and the next one is tried.

$PerRelaySeconds = 10

function Measure-Relay([string]$H, [int]$Port) {
    $best = $null
    for ($i = 0; $i -lt 3; $i++) {
        $c = New-Object System.Net.Sockets.TcpClient
        $sw = [Diagnostics.Stopwatch]::StartNew()
        try { $t = $c.ConnectAsync($H, $Port); if ($t.Wait(2000) -and $c.Connected) { $ms = $sw.ElapsedMilliseconds; if ($best -eq $null -or $ms -lt $best) { $best = $ms } } } catch {} finally { $c.Close() }
    }
    return $best
}

function Get-RelayCandidates($Net, [string]$DefaultHost, [int]$DefaultPort, [string]$DataDir) {
    $hostFile = Join-Path $DataDir 'relay_host.txt'
    if (Test-Path -LiteralPath $hostFile) {
        $t = ((Get-Content -LiteralPath $hostFile -Raw) + '').Trim()
        if ($t) {
            Say "Using the relay in data\relay_host.txt: $t (no failover)"
            return , @(@{ host = $t; port = $DefaultPort; ms = $null; label = $t; id = '' })
        }
    }
    $answered = @(); $silent = @()
    if ($Net -and $Net.relays -and @($Net.relays).Count -gt 0) {
        foreach ($r in @($Net.relays)) {
            $port = if ($r.controlPort) { [int]$r.controlPort } else { 7000 }
            $ms = Measure-Relay "$($r.host)" $port
            $label = if ($r.name) { "$($r.name)" } else { "$($r.host)" }
            $c = @{ host = "$($r.host)"; port = $port; ms = $ms; label = $label; id = "$($r.id)" }
            if ($ms -ne $null) { Say "  Relay ${label}: $ms ms"; $answered += $c } else { Say "  Relay ${label}: no answer" 'Yellow'; $silent += $c }
        }
    }
    $list = @($answered | Sort-Object { $_.ms })
    # a relay that did not answer the quick check is still worth one try at the end (the check can miss)
    $list += $silent
    if ($list.Count -eq 0) { $list = @(@{ host = $DefaultHost; port = $DefaultPort; ms = $null; label = $DefaultHost; id = '' }) }

    $prefFile = Join-Path $DataDir 'relay_prefer.txt'
    $pref = ''
    if (Test-Path -LiteralPath $prefFile) { $pref = ((Get-Content -LiteralPath $prefFile -Raw) + '').Trim().ToLower() }
    if ($pref -and $pref -ne 'auto') {
        $hit = @($list | Where-Object { $_.id.ToLower() -eq $pref -or $_.label.ToLower() -eq $pref })
        if ($hit.Count -gt 0) {
            $p = $hit[0]
            if ($p.ms -ne $null) { Say "Your preferred server: $($p.label)." 'Green' }
            else { Say "Your preferred server ($($p.label)) did not answer the quick check; trying it first anyway." 'Yellow' }
            $list = @($p) + @($list | Where-Object { $_ -ne $p })
        }
        else { Say "Your preferred server ($pref) is not in the server list; using the fastest." 'Yellow' }
    }
    return , $list
}

# Returns @{ proc; host; port; label; ms } for the relay that handed out a slot, or $null when none did.
# $Live: show a countdown on one line (a console window). Without it (Host Mode, read by the launcher): plain lines.
function Connect-Relay($Candidates, [string]$Node, [string]$Root, [string]$LogDir, [string]$StatusFile, [switch]$Live) {
    $relayLog = Join-Path $LogDir 'relay.log'
    $tried = @()
    $n = 0
    foreach ($c in @($Candidates)) {
        if ($n -ge 3) { break }
        $n++
        Remove-Item -LiteralPath $StatusFile -Force -ErrorAction SilentlyContinue
        $msText = if ($c.ms -ne $null) { " ($($c.ms) ms)" } else { '' }
        $what = "Server $n of $([Math]::Min(3, @($Candidates).Count)): $($c.label)$msText"
        if (-not $Live) { Say "$what - connecting..." }
        $proc = $null; $why = ''
        try {
            $proc = Start-Process -FilePath $Node -PassThru -WindowStyle Hidden -WorkingDirectory $Root `
                -ArgumentList @("`"$(Join-Path $PSScriptRoot 'relay-client.js')`"", $c.host, "$($c.port)", "`"$StatusFile`"") `
                -RedirectStandardOutput $relayLog -RedirectStandardError (Join-Path $LogDir 'relay.err') -ErrorAction Stop
        } catch { $why = "could not start the relay program ($($_.Exception.Message))" }
        $t0 = Get-Date
        while (-not $why) {
            if (Test-Path -LiteralPath $StatusFile) { break }
            $s = [int]((Get-Date) - $t0).TotalSeconds
            if ($proc.HasExited) { $why = 'closed the connection'; break }
            if ($s -ge $PerRelaySeconds) { $why = "no slot after $PerRelaySeconds s"; break }
            if ($Live) { Write-Host -NoNewline ("`r  $what... {0,2}s " -f $s) }
            Start-Sleep -Milliseconds 250
        }
        if ($Live) { Write-Host '' }
        if (-not $why) {
            Say "Connected to the $($c.label) relay." 'Green'
            if ($c.ms -ne $null -and $c.ms -gt 150) { Say '  That is far from you: friends near you may lag. A relay closer to you would help (ask in the Discord).' 'Yellow' }
            return @{ proc = $proc; host = $c.host; port = $c.port; label = $c.label; ms = $c.ms }
        }
        if ($proc) {
            try { if (-not $proc.HasExited) { $proc.Kill() } } catch {}
            try { $proc.WaitForExit(3000) | Out-Null } catch {}
        }
        if (Test-Path -LiteralPath $relayLog) { Copy-Item -LiteralPath $relayLog -Destination (Join-Path $LogDir "relay-try$n.log") -Force -ErrorAction SilentlyContinue }
        $tried += "$($c.label) ($why)"
        $more = ($n -lt 3) -and ($n -lt @($Candidates).Count)
        if ($more) { Say "  $($c.label): $why. Trying the next server..." 'Yellow' } else { Say "  $($c.label): $why." 'Yellow' }
    }
    Remove-Item -LiteralPath $StatusFile -Force -ErrorAction SilentlyContinue
    $script:RelayTried = $tried -join ', '
    return $null
}
