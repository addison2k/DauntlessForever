# Dauntless Forever - Dauntless 1.14.7 offline package
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# common.ps1 - shared settings for the Dauntless 1.14.7 offline package. Loaded by the other scripts.
$ErrorActionPreference = 'Stop'
$Root       = Split-Path -Parent $PSScriptRoot
$ConfigFile = Join-Path $Root 'config.json'

# The one game build this package works with, and the files it puts into the game folder.
$ExeHash      = 'F3F95FBF22709EF077A11632ED95D675B7209B7E0172D9ECB9BA7D02A1FBB66B'   # Dauntless 1.14.7, CL 647472
$EpicEosHash  = 'CBC0E5C922CEB88A9FA99121008AE9CD76244B17753701D9D25C6B596EA2FBFC'   # Epic's EOSSDK-Win64-Shipping.dll
$StandInHash  = '4113C9EEBFBAC08532B6566A48F69E4F64A6B8E18A18AAFBA43F62F8F7DFDF70'   # bin\EOSSDK-Win64-Shipping.dll (offline sign-in)
$LoaderHash   = 'B0124C56A6E130EC49BE49FB5114E5532846045A24761BCF83620A2F37761832'    # bin\dxgi.dll (ammo + party fixes in the loader Oct 26; null RHI for server copies Oct 24; crash guard 3 Oct 24; boss bar crash fix Oct 21; in-game text chat Oct 21; server loader: fix5 + KombatKing's equipment fix R1 + owner-only replication; client: significance guard, cheap checks Oct 21)
# Quest text fix by KombatKing (AGPL-3.0, source\QuestDialogue1147-R2-source.zip): adds the missing "Unspecified"
# addressee lines to the game's own text, so quests and dialogue show real sentences. Copied into Archon\Content\Paks.
$QuestPakName = 'zzzzzzzzzzzzzzzz_QuestDialogueFallback1147_P.pak'
$QuestPakHash = '6F12AA1B3856D2A485851A4857150DCC072B2461128F862E3C351B796E33A00E'   # bin\zzzzzzzzzzzzzzzz_QuestDialogueFallback1147_P.pak (R2)
$QuestPakOld  = @('ECB2D6960527073B8EDC9932BD9562A3DC78E1C4EAD8945A178AA85AC3C34A44')   # his R1 (crashes the game at start)
$QuestPakRel  = "Archon\Content\Paks\$QuestPakName"
# Every pak set-up puts into Archon\Content\Paks. Old = earlier versions of the same file that set-up may replace.
$GamePaks = @(
    [pscustomobject]@{ Name = $QuestPakName; Hash = $QuestPakHash; Old = $QuestPakOld; What = 'Quest text fix (KombatKing)' },
    # Equipment fix by KombatKing (AGPL-3.0, source\Equipment1147-R1-source.zip): Recruit's Repeaters in the repeater category.
    [pscustomobject]@{ Name = 'zzzzzzzz_Equipment1147_P.pak'; Hash = '9A2B3AF97304AE8CDD49BFC605A2E2C34657B0707A02076A0EFB6F62C7C80E65'; Old = @(); What = 'Equipment fix (KombatKing)' },
    # KombatKing's 1.14.7 All-in-One R1 (AGPL-3.0, source\KombatKing-1147-AllInOne-R1-source.zip)
    [pscustomobject]@{ Name = 'zzzz_Mega1147_Middleman_P.pak'; Hash = '60966CBC3BC8CCCD4922D0515DF631F12C93E993F51B30665B6224E944404E8A'; Old = @(); What = 'Middleman fusion timer (KombatKing)' },
    [pscustomobject]@{ Name = 'zzzz_Mega1147_HuntPass_P.pak'; Hash = '7D64B5DCFB133FD19FBB54142D1C0F2713C954721A9D01B981BF9A4B3C91B7B1'; Old = @(); What = 'Hunt Pass seasons (KombatKing)' },
    [pscustomobject]@{ Name = 'zzzzzzzzzzzzzzzz_HammerReload1147_P.pak'; Hash = 'F8A1449FD2C70FE915B455BEAF4428AE128D0C163AAF9A2E66554C62B2451E34'; Old = @(); What = 'War Hammer reload fix (KombatKing)' },
    # KombatKing's Item Expiry R1 (AGPL-3.0, source\KombatKing-1147-Oct18-source.zip): Season 11A potions and the Springtide egg token do not expire
    [pscustomobject]@{ Name = 'zzzzzzzzzzzzzzzz_ItemExpiry1147_P.pak'; Hash = 'C71F64758B7B70DC523DA66FCEC47319B330CC8D72E425AC94265FF4C15C029D'; Old = @(); What = 'Item expiry fix (KombatKing)' },
    # DF-STORE-RAMS-ICON (Oct 25): currency_table row id_currency_event_01 (the Rams store's price label) with the Rams icon and name
    [pscustomobject]@{ Name = 'zzzzzzzzzzzzzzzz_RamsStore1147_P.pak'; Hash = '0AD4AE2278F13FA5C27BCE4A1B2090DBC1957D2FE26D1B45A9CD5C2C6B2C97AB'; Old = @(); What = 'Rams store price icon' }
)
$ExeRel       = 'Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe'
$CapturesUrl  = 'https://github.com/EisigesEis/DauntlessEndpointDocumentation/archive/refs/heads/main.zip'

function Hash256([string]$p) { if ($p -and (Test-Path -LiteralPath $p)) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash } else { '(missing)' } }
function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }
function Fail([string]$Text) { Write-Host ''; Write-Host "STOPPED: $Text" -ForegroundColor Yellow; Write-Host ''; exit 1 }

function Get-Config {
    if (-not (Test-Path -LiteralPath $ConfigFile)) { return $null }
    try { return (Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json) } catch { return $null }
}
function Save-Config($cfg) {
    [System.IO.File]::WriteAllText($ConfigFile, ($cfg | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
}

# Node: on PATH, or where the installer puts it (PATH is not refreshed in a window opened before the install).
function Find-Node {
    # The launcher ships the official portable Node.js and passes it in DF_NODE: use it first, nothing to install.
    if ($env:DF_NODE -and (Test-Path -LiteralPath $env:DF_NODE)) { return $env:DF_NODE }
    $c = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    return $null
}

function Test-Recorder { try { Invoke-RestMethod -Uri 'http://127.0.0.1:63000/_recorder/ping' -TimeoutSec 2 | Out-Null; return $true } catch { return $false } }

# Game copies started by this package as servers have -server on their command line; the player's game does not.
function Get-ServerCopies {
    @(Get-CimInstance Win32_Process -Filter "Name='Dauntless-Win64-Shipping.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match '(^|\s)-server(\s|$)' })
}
function Get-PlayerGame {
    @(Get-CimInstance Win32_Process -Filter "Name='Dauntless-Win64-Shipping.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -notmatch '(^|\s)-server(\s|$)' })
}

# DF-PORTS-1147 (Oct 19): the ports this package uses are the backend's TCP 63000-63027 and the game servers' UDP
# 8780-8787. Something left on them from an earlier run (a backend or join helper that did not close, a server copy,
# or the same from another copy of this package, e.g. the old DauntlessOffline folder) used to need a PC restart.
# Clear-Ports1147 closes those (only 1.14.7 programs: node.exe running one of this package's scripts, or the game
# started with -server), names any other program, and says how to fix a port Windows has reserved.
#   -KeepFrom <folder>: leave this package's own programs from that folder running (its backend is in use).
#   -NoFail: only close our leftovers, never stop the script (STOP and the launcher's Stop everything).
$Ports1147Tcp = 63000..63027
$Ports1147Udp = 8780..8787
function Test-PortReserved1147([int[]]$Ports, [string]$Protocol = 'tcp') {
    try { $out = & netsh int ipv4 show excludedportrange protocol=$Protocol 2>$null } catch { return $null }
    foreach ($line in @($out)) {
        if ($line -match '^\s*(\d+)\s+(\d+)') { $a = [int]$Matches[1]; $b = [int]$Matches[2]; foreach ($p in $Ports) { if ($p -ge $a -and $p -le $b) { return "$a-$b" } } }
    }
    return $null
}
function Get-PortOwners1147 {
    $owners = @{}
    try { foreach ($c in @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -ge 63000 -and $_.LocalPort -le 63027 })) { if ($c.OwningProcess -gt 4) { $owners[[int]$c.OwningProcess] = "TCP $($c.LocalPort)" } } } catch {}
    try { foreach ($c in @(Get-NetUDPEndpoint -ErrorAction Stop | Where-Object { $_.LocalPort -ge 8780 -and $_.LocalPort -le 8787 })) { if ($c.OwningProcess -gt 4) { $owners[[int]$c.OwningProcess] = "UDP $($c.LocalPort)" } } } catch {}
    return $owners
}
function Clear-Ports1147([string]$KeepFrom = '', [switch]$NoFail) {
    $owners = Get-PortOwners1147
    $closed = 0
    foreach ($id in @($owners.Keys)) {
        $w = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
        $pname = if ($w) { $w.Name } else { "process $id" }
        $cmd = if ($w -and $w.CommandLine) { $w.CommandLine } else { '' }
        $ours = ($pname -eq 'node.exe' -and $cmd -match '(recorder-1147|join-proxy-1147|df-gateway-1147)\.js') -or
                ($pname -eq 'Dauntless-Win64-Shipping.exe' -and $cmd -match '(^|\s)-server(\s|$)')
        if ($ours) {
            if ($KeepFrom -and $cmd.ToLower().Contains($KeepFrom.ToLower())) { continue }
            $what = if ($pname -eq 'node.exe') { 'a 1.14.7 backend or join helper' } else { 'a 1.14.7 game server copy' }
            Say "    Closing $what left over from an earlier run (port $($owners[$id]), process $id)." 'Yellow'
            Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
            $closed++
        } elseif (-not $NoFail) {
            $where = if ($w -and $w.ExecutablePath) { $w.ExecutablePath } else { $pname }
            Fail "port $($owners[$id]) is used by another program: $where`n         Close that program (also from the system tray next to the clock), then try again."
        }
    }
    if ($closed) {
        Start-Sleep -Seconds 2
        if (-not $NoFail) {
            $still = Get-PortOwners1147
            foreach ($id in @($still.Keys)) {
                $w = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
                if (-not ($KeepFrom -and $w -and $w.CommandLine -and $w.CommandLine.ToLower().Contains($KeepFrom.ToLower()))) {
                    Fail "port $($still[$id]) is still in use after closing the leftovers. Wait a minute and try again; if it stays, restart the PC."
                }
            }
        }
    }
    if (-not $NoFail) {
        $r = Test-PortReserved1147 $Ports1147Tcp
        if ($r) { Fail "Windows has reserved the ports $r (this happens with Hyper-V, WSL or Docker), so the 1.14.7 backend cannot use them.`n         Fix: right-click Start > Terminal (Admin) or Windows PowerShell (Admin), run:  net stop winnat; net start winnat`n         then try again." }
        # DF-FIX4: the game servers' UDP ports can be reserved too. Ramsgate (8780) may still work while every hunt
        # (8781 and up) "searches forever" because its server copy cannot open its port.
        $r = Test-PortReserved1147 (8780..8787) 'udp'
        if ($r) { Fail "Windows has reserved the UDP ports $r (Hyper-V, WSL or Docker), so hunts would search forever: the hunt server cannot open its port.`n         Fix: right-click Start > Terminal (Admin) or Windows PowerShell (Admin), run:  net stop winnat; net start winnat`n         If it comes back after a restart, also run:  netsh int ipv4 add excludedportrange protocol=udp startport=8780 numberofports=8 store=persistent`n         then try again." }
    }
    return $closed
}

# KK-AUTO-LOG-CLEANUP-1147-R1 (KombatKing, AGPL-3.0-only): old run logs and log zips are removed when a tool
# starts and the local backend is not running. Keeps the newest five of each kind and everything from the last 24 hours.
& {
    $cleanupPriorExit1147 = $global:LASTEXITCODE
    try {
        $cleanupConfig1147 = Get-Config
        if ($cleanupConfig1147) {
            $cleanupNode1147 = $cleanupConfig1147.Node
            if (-not $cleanupNode1147 -or -not (Test-Path -LiteralPath $cleanupNode1147)) { $cleanupNode1147 = Find-Node }
            $cleanupFile1147 = Join-Path $PSScriptRoot 'auto-cleanup-logs1147.cjs'
            if ($cleanupNode1147 -and (Test-Path -LiteralPath $cleanupFile1147)) {
                & $cleanupNode1147 $cleanupFile1147 $Root --auto | Out-Host
            }
        }
    } catch { Say ("Automatic log cleanup skipped: " + $_.Exception.Message) 'Yellow' }
    finally { $global:LASTEXITCODE = $cleanupPriorExit1147 }
}

# Game language (launcher Settings > Game language): data\game_language.txt, same file and codes as 1.6.2.
# No file here yet: the choice made for 1.6.2 counts (the launcher only writes it when the setting changes).
$GameLanguages = @('en', 'de', 'es', 'fr', 'it', 'pt-BR', 'ru', 'pl', 'tr', 'ja', 'ko', 'zh-Hans')
function Get-GameLanguage {
    foreach ($f in @((Join-Path $Root 'data\game_language.txt'), (Join-Path (Split-Path -Parent $Root) '1.6.2\data\game_language.txt'))) {
        try {
            if (-not (Test-Path -LiteralPath $f)) { continue }
            foreach ($l in @(Get-Content -LiteralPath $f)) {
                $t = $l.Trim(); if (-not $t -or $t.StartsWith('#')) { continue }
                $hit = $GameLanguages | Where-Object { $_ -ieq $t } | Select-Object -First 1
                if ($hit) { return $hit }
                return ''   # a code this version does not have (e.g. 1.6.2's community Chinese): the game default
            }
            return ''       # the file is there but says "game default"
        } catch {}
    }
    return ''
}
# The game's arguments with the language added: without it the game follows the Windows display language
function Add-GameLanguage([string]$GameArgs) {
    $lang = Get-GameLanguage
    if (-not $lang) { return $GameArgs }
    Say "Game language: $lang" 'Gray'
    return ($GameArgs -replace '\s*-epiclocale=\S+', '') + " -epiclocale=$lang -CULTURE=$lang"
}

# --- Modded mode (launcher Mods page; tools\ue4ss.cjs writes data\mods.txt)
# mods=on: the game gets -dfmods (the loader then loads ue4ss\UE4SS.dll) and the Boss Health Bar (bossbar=on, the default);
# servers=on: the server copies load UE4SS too (D1147_SERVER_MODS=1).
# DF-CHAT-1147: the game's chat settings in its private Engine.ini: [OnlineSubsystemMcp.XMPP] points at our backend
# (XMPP over WebSocket, no SSL); [WebSockets.LibWebSockets] lets it connect to an address that is not on its built-in list.
function Set-ChatConfig1147([string]$CfgDir, [string]$ChatHost, [int]$ChatPort) {
    $eng = Join-Path $CfgDir 'Engine.ini'
    $lines = if (Test-Path -LiteralPath $eng) { @(Get-Content -LiteralPath $eng) } else { @() }
    $keep = New-Object System.Collections.Generic.List[string]; $skip = $false
    foreach ($l in $lines) {
        if ($l -match '^\[(OnlineSubsystemMcp\.XMPP|WebSockets\.LibWebSockets)\]') { $skip = $true; continue }
        if ($skip -and $l -match '^\[') { $skip = $false }
        if (-not $skip) { $keep.Add($l) }
    }
    $add = @('[OnlineSubsystemMcp.XMPP]', "ServerAddr=`"ws://$ChatHost`"", "ServerPort=$ChatPort", 'bUseSSL=false', '',
             '[WebSockets.LibWebSockets]', 'bDisableDomainWhitelist=true', '')
    Set-Content -LiteralPath $eng -Encoding ASCII -Value ($add + $keep)
}
function Get-ModsMode {
    $m = @{ On = $false; Servers = $false; BossBar = $true; TrialsRetry = $false }
    try {
        foreach ($l in @(Get-Content -LiteralPath (Join-Path $Root 'data\mods.txt') -ErrorAction Stop)) {
            $t = $l.Trim().ToLower()
            if ($t -eq 'mods=on') { $m.On = $true }
            if ($t -eq 'servers=on') { $m.Servers = $true }
            if ($t -eq 'bossbar=off') { $m.BossBar = $false }
            if ($t -eq 'trialsretry=on') { $m.TrialsRetry = $true }   # DF-WARM-1147: works without UE4SS / Modded mode
        }
    } catch {}
    if (-not $m.On) { $m.Servers = $false; $m.BossBar = $false }
    return $m
}
# Runs "ue4ss.cjs prepare" (consoles hidden, an old dwmapi.dll proxy moved aside). True when UE4SS is ready to load.
function Invoke-ModsPrepare {
    $nd = $null
    try { $nd = (Get-Config).Node } catch {}
    if (-not $nd -or -not (Test-Path -LiteralPath $nd)) { $nd = Find-Node }
    if (-not $nd) { return $false }
    try {
        $r = (& $nd (Join-Path $PSScriptRoot 'ue4ss.cjs') prepare | Out-String) | ConvertFrom-Json
        if ($r.ok -and $r.on) { return $true }
        if ($r.error) { Say "Mods: $($r.error) UE4SS mods are off this time." 'Yellow' }
    } catch { Say 'Mods: could not get UE4SS ready. UE4SS mods are off this time.' 'Yellow' }
    return $false
}
# For the game process: -dfmods when UE4SS is ready, the Boss Health Bar switch, and the loader's log folder (logs\client.log)
function Add-GameMods($psi) {
    $m = Get-ModsMode
    # DF-WARM-1147: "TR" badge in the bottom-right corner of the game while Trials Quick Retry is on
    if ($m.TrialsRetry) { $psi.EnvironmentVariables['D1147_CLIENT_BADGE'] = 'TR'; Say 'Trials Quick Retry on: a spare trial server warms up while you play (TR shows in the corner).' 'Gray' }
    if (-not $m.On) { return }
    $psi.EnvironmentVariables['D1147_DIR'] = $Root
    if ($m.BossBar) { $psi.EnvironmentVariables['D1147_CLIENT_BOSSBAR'] = '1'; Say 'Modded mode: Boss Health Bar on (windowed or borderless window mode).' 'Gray' }
    if (Invoke-ModsPrepare) { $psi.Arguments = "$($psi.Arguments) -dfmods"; Say 'Modded mode: UE4SS mods on (their windows stay hidden; Ctrl+O shows UE4SS).' 'Gray' }
}
# For the server copies (set before the server window starts; it passes its environment on)
function Set-ServerMods {
    $m = Get-ModsMode
    $on = $m.On -and $m.Servers -and (Invoke-ModsPrepare)
    $env:D1147_SERVER_MODS = if ($on) { '1' } else { $null }
    if ($on) { Say 'Modded mode: your servers load UE4SS mods too.' 'Gray' }
}
