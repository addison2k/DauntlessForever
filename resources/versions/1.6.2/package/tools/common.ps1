# common.ps1 - shared settings for the Dauntless 1.6.2 offline package. Loaded by the other scripts.
$ErrorActionPreference = 'Stop'
$Root       = Split-Path -Parent $PSScriptRoot
$ConfigFile = Join-Path $Root 'config.json'

# The one game build this package works with, and the two files it puts into the game folder.
$ExeHash     = 'E7ACBA587320491B71CB53BB8F8CBF5F3760BB52F78E74A82384B8BC42D05FD6'   # Dauntless 1.6.2, CL 271281
$LoaderHash  = '9A431D7B6FD20C43FA92BEBD91C3BC023EC7A3FCBC52871C41F4DF293D4B0D1F'   # bin\dxgi.dll (Undaunted loader)
$ServerHash  = '7B563865D317AEDA3DA99F1D4078326BBFDBC00A93BB5A7D61D008116539C988'   # bin\UndauntedInternalServer.dll (1.6.2 port)
$ExeRel      = 'Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe'
$MetaPort    = 61000
$DeployPort  = 61001
$RamsgatePort = 8777
$MinNode     = [version]'20.6'      # the backend reads its settings with node --env-file

$MetaDir   = Join-Path $Root 'backend\metagame'
$DeployDir = Join-Path $Root 'backend\deploy'
$DataDir   = Join-Path $Root 'data'
$LogDir    = Join-Path $Root 'logs'
$HomeDir   = Join-Path $Root 'home'       # private settings folder for the game and its servers

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
function Get-NodeVersion([string]$node) {
    $v = "$((& $node --version) 2>$null)".Trim()
    if ($v -match '^v(\d+\.\d+)') { return [version]$Matches[1] }
    return [version]'0.0'
}

function Test-Http([int]$Port, [string]$Path) {
    try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port$Path" -UseBasicParsing -TimeoutSec 2; return ($r.StatusCode -eq 200) } catch { return $false }
}
function Test-Meta { Test-Http $MetaPort '/dauntless-status' }
function Get-ListenerPid([int]$Port) {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess } else { return 0 }
}
function Test-UdpPort([int]$Port) { [bool](Get-NetUDPEndpoint -LocalPort $Port -ErrorAction SilentlyContinue) }

# Game copies started as servers have -server on their command line; the player's own game does not.
function Get-ServerCopies {
    @(Get-CimInstance Win32_Process -Filter "Name='Dauntless-Win64-Shipping.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match '(^|\s)-server(\s|$)' })
}
function Get-PlayerGame {
    @(Get-CimInstance Win32_Process -Filter "Name='Dauntless-Win64-Shipping.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -notmatch '(^|\s)-server(\s|$)' })
}
# Close everything this package started: game server copies, the deploy server, the backend.
function Stop-Everything([switch]$Quiet) {
    $n = 0
    foreach ($c in Get-ServerCopies) { Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }
    foreach ($f in @('deploy.pid', 'metagame.pid')) {
        $fp = Join-Path $DataDir $f
        if (Test-Path -LiteralPath $fp) {
            $id = 0; [int]::TryParse((Get-Content -LiteralPath $fp -Raw).Trim(), [ref]$id) | Out-Null
            $p = if ($id) { Get-Process -Id $id -ErrorAction SilentlyContinue } else { $null }
            if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; $n++ }
            Remove-Item -LiteralPath $fp -Force -ErrorAction SilentlyContinue
        }
    }
    # server copies the deploy server restarted in the last moment
    Start-Sleep -Seconds 1
    foreach ($c in Get-ServerCopies) { Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue }
    if (-not $Quiet) { if ($n) { Say "Closed $n program(s) started by this package." 'Green' } else { Say 'Nothing from this package was running.' } }
}

# Run a program, show its output indented, return its exit code.
# (Windows PowerShell 5.1 would otherwise stop on any line a program writes to its error output.)
function Invoke-Native([string]$Exe, [string[]]$ArgList) {
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        & $Exe @ArgList 2>&1 | ForEach-Object { Write-Host ("    " + "$_") }
        return $LASTEXITCODE
    } finally { $ErrorActionPreference = $old }
}

# Copy logs into a zip for asking for help, with the PC name and Windows user name blanked out.
function Save-LogZip([string[]]$Files, [string]$ZipName) {
    $upload = Join-Path $Root 'upload'
    $tmp = Join-Path $LogDir ('zip_' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $upload, $tmp | Out-Null
    # secrets from the two .env files (the game server key etc.) are blanked out of every log
    $secrets = @()
    foreach ($e in @((Join-Path $MetaDir '.env'), (Join-Path $DeployDir '.env'))) {
        if (-not (Test-Path -LiteralPath $e)) { continue }
        foreach ($line in Get-Content -LiteralPath $e -ErrorAction SilentlyContinue) {
            if ($line -match '^\s*[A-Za-z0-9_]+\s*=\s*"?([^"]{12,})"?\s*$') { $secrets += $Matches[1].Trim() }
        }
    }
    $n = 0
    foreach ($f in $Files) {
        if (-not (Test-Path -LiteralPath $f)) { continue }
        try {
            $fs = [IO.File]::Open($f, 'Open', 'Read', 'ReadWrite'); $sr = New-Object IO.StreamReader($fs); $t = $sr.ReadToEnd(); $sr.Close()
        } catch { continue }
        foreach ($s in @($env:COMPUTERNAME, $env:USERNAME) | Where-Object { $_ -and $_.Length -ge 3 }) { $t = $t -replace [regex]::Escape($s), 'XXXX' }
        $t = $t -replace 'UUK_[0-9a-fA-F]+', 'UUK_XXXX'
        $t = $t -replace 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*', 'JWT_XXXX'
        foreach ($s in $secrets) { if ($s -notmatch '^(https?://|[0-9.:]+$|[A-Za-z]:\\)') { $t = $t -replace [regex]::Escape($s), 'KEY_XXXX' } }
        $n++
        $leaf = Split-Path -Leaf $f
        if (Test-Path -LiteralPath (Join-Path $tmp $leaf)) { $leaf = "$n" + '_' + $leaf }
        [IO.File]::WriteAllText((Join-Path $tmp $leaf), $t)
    }
    $zip = Join-Path $upload $ZipName
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    if (Get-ChildItem -LiteralPath $tmp -File) { Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath $zip }
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
