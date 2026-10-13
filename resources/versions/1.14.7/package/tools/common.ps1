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
$LoaderHash   = '87CF40D2D45FD4BA682E997CB6C05A785A7F5786D88D8C8CE06044373B791DC6'    # bin\dxgi.dll (server loader)
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
