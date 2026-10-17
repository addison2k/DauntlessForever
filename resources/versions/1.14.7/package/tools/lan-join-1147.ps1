# Dauntless Forever - Dauntless 1.14.7 offline package
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# lan-join-1147.ps1 - "LAN - JOIN.bat": play 1.14.7 on another PC's game (LAN - HOST) on the same home network.
# Starts only the game (no backend, no game server on this PC), pointed at the host. This PC gets its own player id
# for this (eos_lan\eos_offline.ini), so the host's backend keeps your character apart from the host's.
# Needs "1 - SETUP.bat" to have been run on this PC once.
param([string]$Address = '')
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
        $ans = Read-Host "Join $saved again? Press Enter for yes, or type the host's address"
        $addr = if ($ans.Trim()) { $ans.Trim() } else { $saved }
    } else {
        $addr = (Read-Host 'Type the address the host''s LAN - HOST window shows (looks like 192.168.1.50)').Trim()
    }
}
$addr = $addr -replace '\s', ''
if ($addr -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { Fail 'that does not look like an address (four numbers with dots, like 192.168.1.50). Copy it again from the host window.' }
[IO.File]::WriteAllText($addrFile, $addr)

# --- is the host there?
Say "Checking the host at $addr..."
$ok = $false
try { Invoke-RestMethod -Uri "http://${addr}:63000/_recorder/ping" -TimeoutSec 8 | Out-Null; $ok = $true } catch {}
if (-not $ok) {
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
function Invoke-Travel([string]$What) {
    $out = & $node $travelJs $What $addr $lanId $Root 2>&1
    $c = $LASTEXITCODE
    foreach ($l in @($out)) { if ("$l".Trim()) { Say "  $l" } }
    return $c
}
if ($node -and (Test-Path -LiteralPath $travelJs)) {
    if (Test-Recorder) { Fail 'Dauntless 1.14.7 is still running on THIS PC (its backend answers). Close PLAY here first, then join again.' }
    $pending = $null; try { $pending = Get-Content -LiteralPath $pendingFile -Raw | ConvertFrom-Json } catch {}
    if ($pending -and $pending.host -eq $addr) {
        Say 'Your last game with this host did not bring your character home. Doing that first...'
        $c = Invoke-Travel 'home'
        if ($c -eq 1) { Fail 'could not bring your character home from the host. Try again in a moment (your home save was not changed).' }
    } elseif ($pending) {
        Say "Note: your character is still at another host ($($pending.host)). Join that host once to bring it home." 'Yellow'
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
try {
    & (Join-Path $PSScriptRoot 'play-1147.ps1') -JoinHost $addr -EosDirOverride $eosLan
} finally {
    if ($travelling -or (Test-Path -LiteralPath $pendingFile)) {
        Say 'Bringing your character home...'
        $c = Invoke-Travel 'home'
        if ($c -ne 0 -and $c -ne 2) { Say 'Your character could not come home just now. The next LAN - JOIN with this host brings it home first.' 'Yellow' }
    }
}
