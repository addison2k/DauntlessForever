# Dauntless Forever - export YOUR OWN character from a Dauntless Revived (1.4.4) server
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
#
# What it does: logs in with YOUR account key, exactly like your game does, and READS your own account:
# characters, inventory, loadouts and progression. It saves them to one file on your Desktop that
# Dauntless Forever can import into 1.6.2. It never changes anything on the Revived server, never reads
# anyone else's data, and does not save your key or login token in the file.
#
# How to use:
#   1. Start Dauntless with the Dauntless Revived launcher as usual and wait until you are in game.
#      (The Revived launcher only connects to its server while the game runs.)
#   2. Right-click this file > Run with PowerShell.
#   3. Paste your account key (UUK_...) or the whole key backup text, and press Enter.
param(
    [int]$Port = 61000,
    [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
$base = "http://127.0.0.1:$Port"
function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Fail($t) { Write-Host ''; Write-Host "STOPPED: $t" -ForegroundColor Yellow; Write-Host ''; Read-Host 'Press Enter to close' | Out-Null; exit 1 }

Say ''
Say '=== Export my Dauntless Revived character ===' 'Cyan'
Say 'Reads only your own account, with your own key. Nothing on the server is changed.'
Say ''

# 1. Is the Revived launcher's connection up?
try { Invoke-WebRequest -Uri "$base/" -UseBasicParsing -TimeoutSec 5 | Out-Null }
catch {
    if (-not $_.Exception.Response) {
        Fail "Dauntless Revived is not running. Start the game with the Revived launcher, wait until you are in game, then run this again."
    }
}

# 2. Your key (never written to disk)
$text = Read-Host 'Paste your account key (UUK_...) and press Enter'
$m = [regex]::Match($text, 'UUK_[0-9A-Za-z_-]{16,120}')
if ($m.Success) { $key = $m.Value } else { $key = $text.Trim() }
if ($key -notmatch '^[A-Za-z0-9_-]{8,128}$') { Fail 'That does not look like an account key.' }

# 3. Log in like the game does
Say 'Logging in...'
try {
    $tok = Invoke-RestMethod -Method Post -Uri "$base/account/api/oauth/token" -UseBasicParsing -TimeoutSec 30 `
        -ContentType 'application/x-www-form-urlencoded' -Body @{ grant_type = 'exchange_code'; exchange_code = $key; token_type = 'eg1' }
} catch { Fail "The server did not accept that key ($($_.Exception.Message)). Check you pasted the key for this server." }
$key = $null
if (-not $tok.access_token -or -not $tok.account_id) { Fail 'The server answered, but without a login. Try again in a minute.' }
$uid = [string]$tok.account_id
$h = @{ Authorization = "bearer $($tok.access_token)" }
function Get-Json([string]$path) {
    Start-Sleep -Milliseconds 400   # go easy on their server
    try { return Invoke-RestMethod -Method Get -Uri "$base$path" -Headers $h -UseBasicParsing -TimeoutSec 60 }
    catch { Say "  could not read $path ($($_.Exception.Message))" 'DarkYellow'; return $null }
}

# 4. Read your own account
Say 'Reading your characters...'
$chars = @(Get-Json '/character')
if (-not $chars.Count -or -not $chars[0]) { Fail 'No characters on this account.' }
$export = [ordered]@{
    format      = 'dauntless-forever-revived-export'
    version     = 1
    source      = 'Dauntless Revived (1.4.4)'
    exportedAt  = (Get-Date).ToUniversalTime().ToString('o')
    accountId   = $uid
    progression = (Get-Json "/progression/$uid")
    objectives  = (Get-Json "/progression/objectives/$uid")
    characters  = @()
}
foreach ($c in $chars) {
    $cid = [string]$c.id
    Say "  $($c.name): inventory, loadouts..."
    $export.characters += [ordered]@{
        character = $c
        inventory = (Get-Json "/inventory/$uid/$cid")
        loadouts  = (Get-Json "/loadout/$uid/$cid/all")
    }
}
$h = $null; $tok = $null

# 5. Save to the Desktop
if (-not $Out) {
    $desk = [Environment]::GetFolderPath('Desktop'); if (-not $desk) { $desk = $PWD.Path }
    $Out = Join-Path $desk ("my-revived-characters-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmm'))
}
[IO.File]::WriteAllText($Out, ($export | ConvertTo-Json -Depth 40), (New-Object Text.UTF8Encoding($false)))
$n = 0; foreach ($e in $export.characters) { if ($e.inventory) { $n += @($e.inventory.instancedItems).Count + @($e.inventory.stackedItems).Count } }
Say ''
Say "Saved $($export.characters.Count) character(s), $n inventory entries:" 'Green'
Say "  $Out" 'White'
Say 'This file has no key or password in it. Send it to Dauntless Forever (or import it in the launcher).'
Say ''
Read-Host 'Press Enter to close' | Out-Null
