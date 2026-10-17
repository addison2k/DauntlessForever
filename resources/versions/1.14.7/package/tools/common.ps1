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
$LoaderHash   = 'A495AEACDB69365B1B140AA30B33ADE73493C868AB5D9CBDA9C41F4EF1666D25'    # bin\dxgi.dll (server loader: fix5 + KombatKing's equipment fix R1 + owner-only replication)
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
    [pscustomobject]@{ Name = 'zzzzzzzz_Equipment1147_P.pak'; Hash = '9A2B3AF97304AE8CDD49BFC605A2E2C34657B0707A02076A0EFB6F62C7C80E65'; Old = @(); What = 'Equipment fix (KombatKing)' }
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
