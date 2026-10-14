# Dauntless Forever - Dauntless 1.6.2 offline package
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# common.ps1 - shared settings for the Dauntless 1.6.2 offline package. Loaded by the other scripts.
$ErrorActionPreference = 'Stop'
$Root       = Split-Path -Parent $PSScriptRoot
$ConfigFile = Join-Path $Root 'config.json'

# The one game build this package works with, and the two files it puts into the game folder.
$ExeHash     = 'E7ACBA587320491B71CB53BB8F8CBF5F3760BB52F78E74A82384B8BC42D05FD6'   # Dauntless 1.6.2, CL 271281
$LoaderHash  = '9A431D7B6FD20C43FA92BEBD91C3BC023EC7A3FCBC52871C41F4DF293D4B0D1F'   # bin\dxgi.dll (Undaunted loader)
$ServerHash  = '64DE377188F0AE720507E627263587CE69808A8DC4DA64FD939235C707CBF1B1'   # bin\UndauntedInternalServer.dll (1.6.2 port)
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
    # The launcher ships the official portable Node.js and passes it in DF_NODE: use it first, nothing to install.
    if ($env:DF_NODE -and (Test-Path -LiteralPath $env:DF_NODE)) { return $env:DF_NODE }
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

# True when Windows has reserved this TCP port (Hyper-V, WSL, Docker): nothing owns it, but no program may open it.
function Test-PortReserved([int]$Port) {
    try { $out = & netsh int ipv4 show excludedportrange protocol=tcp 2>$null } catch { return $false }
    foreach ($l in @($out)) { if ("$l" -match '^\s*(\d+)\s+(\d+)') { if ($Port -ge [int]$Matches[1] -and $Port -le [int]$Matches[2]) { return $true } } }
    return $false
}

# Other Dauntless private servers (Dauntless Revived, older copies of this package, ...) are built on the same
# Undaunted code and use the same ports: backend 61000/61001 (TCP), game servers 8770-8777 (UDP). Only one can run.
# Closes Dauntless backends (node ... dist/server.js) and Dauntless server copies found on those ports, and stops
# with the program's name for anything else. Run Stop-Everything first (this package's own leftovers).
function Clear-DauntlessPorts([int[]]$TcpPorts = @(), [int[]]$UdpPorts = @()) {
    $owners = @{}
    foreach ($port in $TcpPorts) {
        foreach ($c in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { if ($c.OwningProcess -gt 4) { $owners[[int]$c.OwningProcess] = "TCP $port" } }
    }
    foreach ($port in $UdpPorts) {
        foreach ($c in @(Get-NetUDPEndpoint -LocalPort $port -ErrorAction SilentlyContinue)) { if ($c.OwningProcess -gt 4) { $owners[[int]$c.OwningProcess] = "UDP $port" } }
    }
    $closed = 0
    foreach ($id in $owners.Keys) {
        $w = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
        $pname = if ($w) { $w.Name } else { "process $id" }
        $cmd = if ($w -and $w.CommandLine) { $w.CommandLine } else { '' }
        $isBackend = ($pname -eq 'node.exe' -and $cmd -match 'dist[\\/]server\.js')
        $isServerCopy = ($pname -eq 'Dauntless-Win64-Shipping.exe')
        if ($isBackend -or $isServerCopy) {
            $what = if ($isBackend) { 'Dauntless server' } else { 'Dauntless game server' }
            Say "    Closing another $what that was using port $($owners[$id]) (often Dauntless Revived or an old copy; it is not harmed)." 'Yellow'
            Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
            $closed++
        } else {
            $where = if ($w -and $w.ExecutablePath) { $w.ExecutablePath } else { $pname }
            Fail "port $($owners[$id]) is used by another program: $where`n         If that is another Dauntless launcher (for example Dauntless Revived), close it completely, also from the`n         system tray next to the clock, then try again. Restarting the PC also frees it."
        }
    }
    if ($closed) {
        Start-Sleep -Seconds 2
        foreach ($port in $TcpPorts) { if (Get-ListenerPid $port) { Fail "port $port is still in use after closing the other Dauntless server. Restart the PC, then try again." } }
        foreach ($port in $UdpPorts) { if (Test-UdpPort $port) { Fail "game port $port is still in use after closing the other Dauntless server. Restart the PC, then try again." } }
    }
    foreach ($port in $TcpPorts) {
        if (Test-PortReserved $port) {
            Fail "Windows has reserved port $port (this happens with Hyper-V, WSL or Docker), so the backend cannot use it.`n         Fix: right-click Start > Terminal (Admin) or Windows PowerShell (Admin), run:  net stop winnat; net start winnat`n         then try again."
        }
    }
}

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

# In-game text chat: the game's chat connection (XMPP over WebSocket) goes to the backend it plays on
# (the metagame serves chat on its own port). Rewrites only the [OnlineSubsystemMcp.XMPP] section of Engine.ini.
function Set-ChatConfig([string]$CfgDir, [string]$ChatHost, [int]$ChatPort) {
    $eng = Join-Path $CfgDir 'Engine.ini'
    $lines = if (Test-Path -LiteralPath $eng) { @(Get-Content -LiteralPath $eng) } else { @() }
    $keep = New-Object System.Collections.Generic.List[string]; $skip = $false
    foreach ($l in $lines) {
        if ($l -match '^\[OnlineSubsystemMcp\.XMPP\]') { $skip = $true; continue }
        if ($skip -and $l -match '^\[') { $skip = $false }
        if (-not $skip) { $keep.Add($l) }
    }
    $xmpp = @('[OnlineSubsystemMcp.XMPP]', "ServerAddr=`"ws://$ChatHost`"", "ServerPort=$ChatPort", 'bUseSSL=false', '')
    Set-Content -LiteralPath $eng -Encoding ASCII -Value ($xmpp + $keep)
}
