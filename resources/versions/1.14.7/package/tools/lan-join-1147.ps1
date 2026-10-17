# Dauntless Forever - Dauntless 1.14.7 offline package
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# lan-join-1147.ps1 - "LAN - JOIN.bat": play 1.14.7 on another PC's game: on the same home network (LAN - HOST,
# code = address) or from anywhere through the Dauntless Forever relay (ONLINE - HOST, code = address:port).
# Starts only the game (no backend, no game server on this PC), pointed at the host. Online, tools\join-proxy-1147.js
# carries the game's backend connections to the host through the relay. This PC gets its own player id
# for this (eos_lan\eos_offline.ini), so the host's backend keeps your character apart from the host's.
# Needs "1 - SETUP.bat" to have been run on this PC once.
# The launcher runs this too (version.json "online"): Join on the Friends page and Play online pass -Code
# (address:port). While the game runs, data\travel_save_now (the host is closing) saves your character home at once.
param([Alias('Code')][string]$Address = '')
. (Join-Path $PSScriptRoot 'common.ps1')
$DataDir = Join-Path $Root 'data'

Say ''
Say '=== Dauntless 1.14.7 - join a LAN game ===' 'Cyan'
$cfg = Get-Config
if (-not $cfg) { Fail 'set-up has not been run yet. Double-click "1 - SETUP.bat" first.' }
$Bin = Join-Path $cfg.GameDir 'Archon\Binaries\Win64'
if ((Hash256 (Join-Path $Bin 'EOSSDK-Win64-Shipping.dll')) -ne $StandInHash) { Fail 'the offline sign-in is not in the game folder. Run "1 - SETUP.bat" again.' }
foreach ($gp in $GamePaks) {
    if ((Hash256 (Join-Path $cfg.GameDir "Archon\Content\Paks\$($gp.Name)")) -ne $gp.Hash) { Fail "the $($gp.What) is not in the game folder yet. Run `"1 - SETUP.bat`" again." }
}
if (@(Get-PlayerGame).Count -gt 0) { Fail 'the game is already running. Close it first.' }
foreach ($c in Get-ServerCopies) { Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue }   # this PC's own servers are not used

# --- the host's address, remembered for next time
New-Item -ItemType Directory -Force $DataDir | Out-Null
$addrFile = Join-Path $DataDir 'lan_join_address.txt'
$addr = $Address.Trim()
if (-not $addr) {
    $saved = if (Test-Path -LiteralPath $addrFile) { ((Get-Content -LiteralPath $addrFile -Raw) + '').Trim() } else { '' }
    if ($saved) {
        $ans = Read-Host "Join $saved again? Press Enter for yes, or paste a new address / join code"
        $addr = if ($ans.Trim()) { $ans.Trim() } else { $saved }
    } else {
        $addr = (Read-Host 'Paste the address or join code from the host (192.168.1.50 at home, or 209.145.57.41:21000 online)').Trim()
    }
}
$addr = ($addr -replace '\s', '') -replace '\|.*$', ''
if ($addr -notmatch '^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{2,5}))?$') { Fail 'that does not look like an address (192.168.1.50) or join code (209.145.57.41:21000). Copy it again from the host window.' }
$hostIp = $Matches[1]; $relayPort = if ($Matches[2]) { [int]$Matches[2] } else { 0 }
[IO.File]::WriteAllText($addrFile, $addr)

# --- online: the join proxy carries the game's backend connections through the relay
$proxy = $null
$gameHost = $hostIp
if ($relayPort) {
    if (Test-Recorder) { Fail 'Dauntless 1.14.7 is still running on THIS PC (its backend answers). Close PLAY here first, then join again.' }
    $node0 = $cfg.Node; if (-not $node0 -or -not (Test-Path -LiteralPath $node0)) { $node0 = Find-Node }
    if (-not $node0) { Fail 'Node.js from set-up is missing. Run "1 - SETUP.bat" again.' }
    $ready = Join-Path $DataDir 'join-proxy.json'
    Remove-Item -LiteralPath $ready -Force -ErrorAction SilentlyContinue
    # a join proxy left over from an earlier join (window closed early) still holds 63000-63027: stop only that one (Oct 17)
    try {
        Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
            Where-Object { $_.CommandLine -and $_.CommandLine -like '*join-proxy-1147.js*' } |
            ForEach-Object { Say "Closing a join helper left over from last time (process $($_.ProcessId))."; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 500
    } catch {}
    New-Item -ItemType Directory -Force (Join-Path $Root 'logs') | Out-Null
    $proxy = Start-Process -FilePath $node0 -PassThru -WindowStyle Hidden -WorkingDirectory $Root `
        -ArgumentList @("`"$(Join-Path $PSScriptRoot 'join-proxy-1147.js')`"", $hostIp, "$relayPort", "`"$ready`"") `
        -RedirectStandardOutput (Join-Path $Root 'logs\join-proxy.log') -RedirectStandardError (Join-Path $Root 'logs\join-proxy.err')
    $t0 = Get-Date
    while (-not (Test-Path -LiteralPath $ready)) {
        if ($proxy.HasExited -or ((Get-Date) - $t0).TotalSeconds -gt 10) { Fail 'the join proxy did not start (ports 63000-63027 in use on this PC?). See logs\join-proxy.log.' }
        Start-Sleep -Milliseconds 200
    }
    $gameHost = '127.0.0.1'
}
function Stop-Proxy { if ($proxy) { try { if (-not $proxy.HasExited) { $proxy.Kill() } } catch {}; Remove-Item -LiteralPath (Join-Path $DataDir 'join-proxy.json') -Force -ErrorAction SilentlyContinue } }

# --- is the host there?
Say "Checking the host at $addr..."
$ok = $false
$hostLabel = $addr
try {
    $pong = Invoke-RestMethod -Uri "http://${gameHost}:63000/_recorder/ping" -TimeoutSec 10; $ok = $true
    # the host's own id (server files .8 and newer): the join code changes every session, this id does not
    if ("$($pong.host)" -match '^[0-9a-f]{16}$') { $hostLabel = "host:$($pong.host)" }
} catch {}
if (-not $ok) {
    Stop-Proxy
    if ($relayPort) {
        Fail ("cannot reach the host through the relay at $addr.`n" +
              "         - Is the host's ONLINE - HOST window still open, and has their game reached Ramsgate?`n" +
              "         - Is the join code from the host's CURRENT session? (It changes each time they start ONLINE - HOST.)")
    }
    Fail ("cannot reach the host at $addr.`n" +
          "         - Is the host's LAN - HOST window still open, and has their game reached Ramsgate?`n" +
          "         - Are both PCs on the same home network (same router)?")
}
Say 'Host found.' 'Green'

# --- this PC's own player id for LAN games (made once). Your solo save on this PC is not touched.
$eosLan = Join-Path $Root 'eos_lan'
New-Item -ItemType Directory -Force $eosLan | Out-Null
$lanIni = Join-Path $eosLan 'eos_offline.ini'
$soloIni = Join-Path $Root 'eos\eos_offline.ini'
$lines = if (Test-Path -LiteralPath $lanIni) { @(Get-Content -LiteralPath $lanIni) } elseif (Test-Path -LiteralPath $soloIni) { @(Get-Content -LiteralPath $soloIni) } else { @('; eos_offline settings for LAN games.') }
$hasId = @($lines | Where-Object { $_ -match '^EpicAccountId=[0-9a-f]{32}$' }).Count -gt 0
if (-not $hasId) {
    $bytes = New-Object byte[] 16; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $lines = @($lines | Where-Object { $_ -notmatch '^EpicAccountId=' }) + @('EpicAccountId=' + (($bytes | ForEach-Object { $_.ToString('x2') }) -join ''))
    Say 'Made this PC''s player id for LAN games.' 'Green'
}
$name = $null
if ($env:DF_PLAYER_NAME -match '^[A-Za-z0-9_]{3,16}$') { $name = $env:DF_PLAYER_NAME }
elseif (Test-Path -LiteralPath $soloIni) { $m = Select-String -LiteralPath $soloIni -Pattern '^DisplayName=(.+)$' | Select-Object -First 1; if ($m) { $name = $m.Matches[0].Groups[1].Value.Trim() } }
if ($name) { $lines = @($lines | Where-Object { $_ -notmatch '^DisplayName=' }) + @("DisplayName=$name") }
[System.IO.File]::WriteAllText($lanIni, (($lines -join "`r`n") + "`r`n"), [System.Text.Encoding]::ASCII)

# --- your own character travels with you (gear, quests, progress) and comes home when the game closes
#     (tools\travel-1147.js; the same idea as 1.6.2). Your home save is backed up first (backup\travel\).
$lanId = (@($lines | Where-Object { $_ -match '^EpicAccountId=' })[0] -split '=', 2)[1].Trim()
$node = $cfg.Node; if (-not $node -or -not (Test-Path -LiteralPath $node)) { $node = Find-Node }
$travelJs = Join-Path $PSScriptRoot 'travel-1147.js'
$pendingFile = Join-Path $DataDir 'travel_pending.json'
$travelling = $false
$env:TRAVEL_LABEL = $hostLabel
function Invoke-Travel([string]$What) {
    $out = & $node $travelJs $What $gameHost $lanId $Root 2>&1
    $c = $LASTEXITCODE
    foreach ($l in @($out)) { if ("$l".Trim()) { Say "  $l" } }
    return $c
}
if ($node -and (Test-Path -LiteralPath $travelJs)) {
    if (-not $relayPort -and (Test-Recorder)) { Fail 'Dauntless 1.14.7 is still running on THIS PC (its backend answers). Close PLAY here first, then join again.' }
    $pending = $null; try { $pending = Get-Content -LiteralPath $pendingFile -Raw | ConvertFrom-Json } catch {}
    if ($pending -and ($pending.host -eq $hostLabel -or $pending.host -eq $addr)) {
        Say 'Your last game with this host did not bring your character home. Doing that first...'
        $c = Invoke-Travel 'home'
        if ($c -eq 1) { Stop-Proxy; Fail 'could not bring your character home from the host. Try again in a moment (your home save was not changed).' }
    } elseif ($pending) {
        # another host has a copy from a game that ended without coming home. Your home save was kept up to date
        # while you played there (every 3 minutes), so it travels from here, as 1.6.2 does. The old copy stays on
        # that host; nothing on this PC is lost (backup\travel has the saves from before each join).
        Say "Your last game ($($pending.host)) did not bring your character home at the end; using the copy saved home while you played." 'Yellow'
        Remove-Item -LiteralPath $pendingFile -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path -LiteralPath $pendingFile)) {
        Say 'Sending your character to the host...'
        $c = Invoke-Travel 'send'
        if ($c -eq 0) { $travelling = $true }
        elseif ($c -eq 2) { Say '  (You play with a new character on the host.)' }
        else { Say '  You play with the host''s copy of your character this time.' 'Yellow' }
    }
} else { Say 'Node.js or tools\travel-1147.js not found: you play with a character kept on the host.' 'Yellow' }

Say ''
Say "Joining $addr..." 'Green'
# the host is closing (the launcher writes data\travel_save_now): save the character home now, while the host still answers
$saveNow = Join-Path $DataDir 'travel_save_now'
Remove-Item -LiteralPath $saveNow -Force -ErrorAction SilentlyContinue
$saver = $null
if ($travelling) {
    # while you play: your character is saved home every 3 minutes, and at once when the host says they are
    # closing, so a host who drops out costs you minutes at most (as 1.6.2). A copy that looks wrong (exit 3)
    # pauses this for the rest of the game; your home save stays as it was.
    $saver = Start-Job -ArgumentList $saveNow, $node, $travelJs, $gameHost, $lanId, $Root, $hostLabel -ScriptBlock {
        param($flag, $node, $js, $gh, $id, $root, $label)
        $env:TRAVEL_LABEL = $label
        $last = Get-Date
        while ($true) {
            $now = Test-Path -LiteralPath $flag
            if ($now -or ((Get-Date) - $last).TotalSeconds -ge 180) {
                Remove-Item -LiteralPath $flag -Force -ErrorAction SilentlyContinue
                $last = Get-Date
                & $node $js 'save' $gh $id $root 2>&1 | Out-Null
                if ($LASTEXITCODE -eq 3) { break }
            }
            Start-Sleep -Seconds 2
        }
    }
}
try {
    & (Join-Path $PSScriptRoot 'play-1147.ps1') -JoinHost $gameHost -EosDirOverride $eosLan
} finally {
    if ($saver) { Stop-Job $saver -ErrorAction SilentlyContinue; Remove-Job $saver -Force -ErrorAction SilentlyContinue }
    if ($travelling -or (Test-Path -LiteralPath $pendingFile)) {
        Say 'Bringing your character home...'
        $c = Invoke-Travel 'home'
        if ($c -ne 0 -and $c -ne 2) { Say 'Your character could not come home just now. The next LAN - JOIN with this host brings it home first.' 'Yellow' }
    }
    Stop-Proxy
}
