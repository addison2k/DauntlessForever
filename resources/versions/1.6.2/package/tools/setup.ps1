# Dauntless Forever - Dauntless 1.6.2 offline package
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# setup.ps1 - one-time set-up for playing Dauntless 1.6.2 offline. Started by "1 - SETUP.bat".
#   setup.ps1             set up (safe to run again at any time; it only fixes what is missing)
#   setup.ps1 -Uninstall  take this package's two files out of the game folder again
param([switch]$Uninstall)
. (Join-Path $PSScriptRoot 'common.ps1')

$loader = Join-Path $Root 'bin\dxgi.dll'
$server = Join-Path $Root 'bin\UndauntedInternalServer.dll'
$backup = Join-Path $Root 'backup'
$stamp  = Get-Date -Format 'yyyyMMdd_HHmmss'

Say ''
Say '=== Dauntless 1.6.2 offline - set-up ===' 'Cyan'
Say ''

# ---------------------------------------------------------------- uninstall (first, so it works whatever state things are in)
# It needs none of the checks below: not the package files, not the exact game version. It only takes out what is ours.
if ($Uninstall) {
    if (@(Get-PlayerGame).Count -gt 0) { Fail 'please close the game first, then run uninstall again.' }
    foreach ($c in Get-ServerCopies) { Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue }
    $ucfg = Get-Config
    $ugame = if ($ucfg -and $ucfg.GameDir) { [string]$ucfg.GameDir } else { '' }
    if (-not $ugame -or -not (Test-Path -LiteralPath (Join-Path $ugame 'Archon\Binaries\Win64'))) {
        Say 'Which game folder should be put back? (the one that has the "Archon" folder inside it)' 'White'
        $ugame = "$(Read-Host 'Paste the folder path (Enter on its own to quit)')".Trim().Trim('"')
        if (-not $ugame) { Fail 'no game folder given. Nothing was changed.' }
    }
    $ubin = Join-Path $ugame 'Archon\Binaries\Win64'
    if (-not (Test-Path -LiteralPath $ubin)) { Fail "there is no Archon\Binaries\Win64 in $ugame. Nothing was changed." }
    $ubak = Join-Path $Root 'backup'
    New-Item -ItemType Directory -Force $ubak | Out-Null
    $ustamp = Get-Date -Format 'yyyyMMdd_HHmmss'
    # the server code: the file name is ours alone, whatever build of it this is
    $usrv = Join-Path $ubin 'UndauntedInternalServer.dll'
    if (Test-Path -LiteralPath $usrv) {
        Move-Item -LiteralPath $usrv -Destination (Join-Path $ubak "removed_${ustamp}_UndauntedInternalServer.dll")
        Say 'Server code (UndauntedInternalServer.dll) taken out of the game folder (kept in the backup folder).' 'Green'
    }
    # dxgi.dll: only take it out when it is this package's loader. Another dxgi.dll is someone else's (a mod like ReShade).
    $udx = Join-Path $ubin 'dxgi.dll'
    if (Test-Path -LiteralPath $udx) {
        if ((Hash256 $udx) -eq $LoaderHash) {
            Move-Item -LiteralPath $udx -Destination (Join-Path $ubak "removed_${ustamp}_dxgi.dll")
            Say 'Server loader (dxgi.dll) taken out of the game folder (kept in the backup folder).' 'Green'
        } else {
            Say 'The dxgi.dll in the game folder is not this package''s loader (maybe a mod like ReShade, or an older loader). Left in place.' 'Yellow'
        }
    }
    Say ''
    Say 'Done. Your offline progress stays in the data folder of this package.' 'Green'
    exit 0
}


if ((Hash256 $loader) -ne $LoaderHash -or (Hash256 $server) -ne $ServerHash -or -not (Test-Path -LiteralPath (Join-Path $MetaDir 'dist\server.js'))) {
    Fail 'files in this package are missing or damaged. Unzip the package again (all of it, not from inside the zip) and re-run set-up.'
}
if (@(Get-PlayerGame).Count -gt 0) { Fail 'please close the game first, then run set-up again.' }
Stop-Everything -Quiet

# ---------------------------------------------------------------- 1. find the game
function Resolve-GameDir([string]$pick) {
    if (-not $pick) { return $null }
    $pick = $pick.Trim().Trim('"')
    if (-not (Test-Path -LiteralPath $pick)) { return $null }
    if ((Get-Item -LiteralPath $pick).PSIsContainer -eq $false) { $pick = Split-Path -Parent $pick }
    # accept the game folder itself, a folder inside it, or a folder that contains it
    $d = $pick
    for ($i = 0; $i -lt 4 -and $d; $i++) {
        if (Test-Path -LiteralPath (Join-Path $d $ExeRel)) { return $d }
        $d = Split-Path -Parent $d
    }
    $hit = Get-ChildItem -LiteralPath $pick -Filter 'Dauntless-Win64-Shipping.exe' -Recurse -Depth 5 -File -ErrorAction SilentlyContinue |
        Where-Object { $_.DirectoryName -like '*\Archon\Binaries\Win64' } | Select-Object -First 1
    if ($hit) { return (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $hit.DirectoryName))) }
    return $null
}
function Test-Build([string]$dir) { (Hash256 (Join-Path $dir $ExeRel)) -eq $ExeHash }

$cfg = Get-Config
$gameDir = $null
if ($cfg -and $cfg.GameDir -and (Test-Path -LiteralPath (Join-Path $cfg.GameDir $ExeRel))) {
    $gameDir = $cfg.GameDir
    Say "Game folder (from last time): $gameDir"
}
if (-not $gameDir) {
    Say 'Looking for Dauntless 1.6.2 on your drives (this can take a minute)...'
    $cands = New-Object System.Collections.Generic.List[string]
    foreach ($drv in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | Where-Object { $_.Root -match '^[A-Z]:\\$' })) {
        foreach ($base in @($drv.Root, (Join-Path $drv.Root 'Games'), (Join-Path $drv.Root 'Epic Games'), (Join-Path $drv.Root 'Program Files\Epic Games'))) {
            Get-ChildItem -LiteralPath $base -Directory -Filter '*auntless*' -ErrorAction SilentlyContinue | ForEach-Object { $cands.Add($_.FullName) }
        }
    }
    foreach ($b in @((Split-Path -Parent $Root), [Environment]::GetFolderPath('Desktop'), (Join-Path $env:USERPROFILE 'Downloads'))) {
        if ($b) { Get-ChildItem -LiteralPath $b -Directory -Filter '*auntless*' -ErrorAction SilentlyContinue | ForEach-Object { $cands.Add($_.FullName) } }
    }
    $found = @()
    foreach ($c in ($cands | Select-Object -Unique)) {
        $g = Resolve-GameDir $c
        if ($g -and ($found -notcontains $g) -and (Test-Build $g)) { $found += $g }
    }
    if ($found.Count -ge 1) {
        $gameDir = $found[0]
        Say "Found it: $gameDir" 'Green'
        if ($found.Count -gt 1) { Say "  (also found: $(($found | Select-Object -Skip 1) -join ', '))" }
        $a = Read-Host 'Use this folder? Press Enter for yes, or type N to pick another'
        if ($a -match '^[nN]') { $gameDir = $null }
    }
}
while (-not $gameDir) {
    Say ''
    Say 'Pick the Dauntless 1.6.2 game folder (the one that has the "Archon" folder inside it).' 'White'
    $pick = $null
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = 'Pick the Dauntless 1.6.2 game folder (it has the Archon folder inside it)'
        $dlg.ShowNewFolderButton = $false
        $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }   # keeps the picker in front
        if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $pick = $dlg.SelectedPath }
        $owner.Dispose()
    } catch { }
    if (-not $pick) { $pick = Read-Host 'Or paste the folder path here (Enter on its own to quit)' }
    if (-not $pick) { Fail 'no game folder picked.' }
    $g = Resolve-GameDir $pick
    if (-not $g) { Say "No Dauntless game (Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe) found in: $pick" 'Yellow'; continue }
    $gameDir = $g
}
$exe = Join-Path $gameDir $ExeRel
$bin = Split-Path -Parent $exe
Say 'Checking the game version (a few seconds)...'
if (-not (Test-Build $gameDir)) {
    Fail ("the game in $gameDir is not Dauntless 1.6.2 (build 271281). This package only works with that exact version.`n" +
          "         Your exe: $(Hash256 $exe)`n         Needed:   $ExeHash")
}
Say 'Dauntless 1.6.2: correct version.' 'Green'

$probe = Join-Path $bin ('write_test_' + [guid]::NewGuid().ToString('N') + '.tmp')
try { [System.IO.File]::WriteAllText($probe, 'x'); Remove-Item -LiteralPath $probe -Force }
catch { Fail "Windows will not let set-up change files in $bin. Move the game to a folder like C:\Games, or right-click '1 - SETUP.bat' and choose 'Run as administrator'." }

$dxgi = Join-Path $bin 'dxgi.dll'
$srvDll = Join-Path $bin 'UndauntedInternalServer.dll'
New-Item -ItemType Directory -Force $backup | Out-Null

# ---------------------------------------------------------------- 1a. other projects' loaders in the game folder
# Other tools load their own code into the game by putting a DLL with a Windows name beside the exe (Mystic Paradox
# uses winmm.dll; mod loaders use version.dll, dinput8.dll or winhttp.dll). Made for other builds, they crash this
# one at start ("unable to start correctly (0xc0000005)"). They are moved to backup\, nothing is deleted.
# This package's own dxgi.dll is handled further down.
$otherLoaders = @(Get-ChildItem -LiteralPath $bin -File -ErrorAction SilentlyContinue | Where-Object {
    ($_.Name -in @('winmm.dll', 'version.dll', 'dinput8.dll', 'winhttp.dll')) -or ($_.Name -match 'mystic|paradox')
})
if ($otherLoaders.Count -gt 0) {
    $parkDir = Join-Path $backup ('other-loaders_' + (Get-Date -Format 'yyyyMMdd_HHmmss'))
    New-Item -ItemType Directory -Force $parkDir | Out-Null
    foreach ($f in $otherLoaders) {
        Move-Item -LiteralPath $f.FullName -Destination (Join-Path $parkDir $f.Name) -Force
        Say "  Moved $($f.Name) out of the game folder: it loads another project's code into the game, which crashes this version." 'Yellow'
    }
    Say "  Kept in $parkDir. To use that other project again, move the files back into $bin." 'Yellow'
}
foreach ($gfx in @('d3d11.dll', 'd3d12.dll', 'dxgi.dll.reshade')) {
    if (Test-Path -LiteralPath (Join-Path $bin $gfx)) {
        Say "  Note: $gfx is in the game folder (ReShade or another graphics mod). Left in place; if the game crashes at start, move it out." 'Yellow'
    }
}


# ---------------------------------------------------------------- 1b. game prerequisites (Visual C++ runtime, DirectX parts)
# A game downloaded by the launcher never ran Epic's prerequisite installer, and the download has no copy of it.
# Without these the game and its server copies close at once, with no log at all.
function Get-VcRuntimeVersion {
    foreach ($k in @('HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64')) {
        $p = Get-ItemProperty -LiteralPath $k -ErrorAction SilentlyContinue
        if ($p -and $p.Installed -eq 1) { try { return [version]("{0}.{1}.{2}" -f $p.Major, $p.Minor, $p.Bld) } catch { } }
    }
    return $null
}
$dxNeeded = @('xinput1_3.dll', 'x3daudio1_7.dll', 'xapofx1_5.dll')    # DirectX (June 2010) parts the game loads at start
function Get-MissingDx { @($dxNeeded | Where-Object { -not (Test-Path -LiteralPath (Join-Path $env:WINDIR "System32\$_")) }) }
function Install-WithWinget([string]$Id, [string]$What) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { return $false }
    $a = Read-Host "Install $What now with winget? Press Enter for yes, or type N for no"
    if ($a -match '^[nN]') { return $false }
    Say "  Installing $What (Windows may ask for permission)..."
    & winget.exe install -e --id $Id --accept-package-agreements --accept-source-agreements
    return $true
}
$MinVc = [version]'14.30'
$prereqsDone = $false
Say ''
$vcFiles = @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll')
function Test-VcFiles { @($vcFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $env:WINDIR "System32\$_")) }).Count -eq 0 }
$vc = Get-VcRuntimeVersion
if (-not (Test-VcFiles)) { $vc = $null }   # the same rule the launcher and PLAY use: the files must be there
if (-not $vc -or $vc -lt $MinVc) {
    Say "The Visual C++ 2015-2022 runtime (64-bit) is needed, version $MinVc or newer. Found: $(if ($vc) { $vc } else { 'none' })." 'White'
    Install-WithWinget 'Microsoft.VCRedist.2015+.x64' 'the Visual C++ runtime' | Out-Null
    $vc = Get-VcRuntimeVersion
    if (-not (Test-VcFiles)) { $vc = $null }
    if (-not $vc -or $vc -lt $MinVc) {
        Start-Process 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -ErrorAction SilentlyContinue
        Fail 'install the Visual C++ runtime (the download should have started: run vc_redist.x64.exe), then run set-up again.'
    }
}
Say "Visual C++ runtime $vc : OK" 'Green'
$missDx = Get-MissingDx
if ($missDx.Count -gt 0) {
    Say "DirectX parts the game needs are missing: $($missDx -join ', ')." 'White'
    Say "  Microsoft's DirectX End-User Runtime (June 2010) adds them. It is about 95 MB."
    $a = Read-Host 'Download and install it now? Press Enter for yes, or type N for no'
    if ($a -notmatch '^[nN]') {
        # The offline package: it carries every file inside (the web installer can stop half-way).
        $dxUrl  = 'https://download.microsoft.com/download/8/4/A/84A35BF1-DAFE-4AE8-82AF-AD2AE20B6B14/directx_Jun2010_redist.exe'
        $dxWork = Join-Path $env:TEMP ('dauntless_dx_' + [guid]::NewGuid().ToString('N'))
        $dxPkg  = Join-Path $dxWork 'directx_Jun2010_redist.exe'
        $dxOut  = Join-Path $dxWork 'files'
        New-Item -ItemType Directory -Force $dxOut | Out-Null
        try {
            Say '  Downloading from Microsoft...'
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $dxUrl -OutFile $dxPkg -UseBasicParsing
            # Checksums of this file differ between reports; Microsoft's signature on it does not.
            $sig = Get-AuthenticodeSignature -LiteralPath $dxPkg
            if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'the downloaded file is not signed by Microsoft' }
            Say '  Unpacking...'
            $px = Start-Process -FilePath $dxPkg -ArgumentList @('/Q', '/C', "/T:`"$dxOut`"") -Wait -PassThru
            $dxSetup = Join-Path $dxOut 'DXSETUP.exe'
            if (-not (Test-Path -LiteralPath $dxSetup)) { throw "unpacking failed (code $($px.ExitCode))" }
            Say '  Installing (Windows asks for permission)...'
            Start-Process -FilePath $dxSetup -ArgumentList '/silent' -Verb RunAs -Wait
        } catch {
            Say "  That did not work: $($_.Exception.Message)" 'Yellow'
        } finally {
            Remove-Item -LiteralPath $dxWork -Recurse -Force -ErrorAction SilentlyContinue
        }
        $missDx = Get-MissingDx
    }
    if ($missDx.Count -gt 0) {
        Start-Process 'https://www.microsoft.com/en-us/download/details.aspx?id=8109' -ErrorAction SilentlyContinue
        Fail ("still missing: $($missDx -join ', '). On the page that opened, download directx_Jun2010_redist.exe,`n" +
              "         run it and unpack to an empty folder, then right-click DXSETUP.exe there and Run as administrator.`n" +
              "         Then run set-up again.")
    }
}
Say 'DirectX parts: OK' 'Green'
$prereqsDone = $true

# ---------------------------------------------------------------- 2. Node.js (runs the local backend)
Say ''
$node = Find-Node
if ($node -and (Get-NodeVersion $node) -lt $MinNode) {
    Say "Node.js $((& $node --version) 2>$null) is too old for this package (it needs 20.6 or newer)." 'Yellow'
    $node = $null
}
if (-not $node) {
    Say 'Node.js (the LTS version) is needed to run the local backend the game talks to.' 'White'
    if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
        $a = Read-Host 'Install Node.js LTS now with winget? Press Enter for yes, or type N for no'
        if ($a -notmatch '^[nN]') {
            & winget.exe install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
            $node = Find-Node
            if ($node -and (Get-NodeVersion $node) -lt $MinNode) { $node = $null }
        }
    }
    if (-not $node) {
        Start-Process 'https://nodejs.org/en/download' -ErrorAction SilentlyContinue
        Fail 'install Node.js (the LTS version) from https://nodejs.org (the page should have opened), then run set-up again.'
    }
}
Say "Node.js $((& $node --version) 2>$null) : $node" 'Green'
# Node was maybe installed a moment ago: this window's PATH does not know it yet, but npm's install steps
# need a plain "node" on PATH. Put its folder first for the rest of this set-up.
$nodeDir = Split-Path -Parent $node
if (($env:Path -split ';') -notcontains $nodeDir) { $env:Path = "$nodeDir;$env:Path" }
$npm = Join-Path $nodeDir 'npm.cmd'
if (-not (Test-Path -LiteralPath $npm)) { Fail "npm was not found next to Node.js ($npm). Reinstall Node.js LTS from https://nodejs.org and run set-up again." }

# ---------------------------------------------------------------- 3. backend parts (downloaded once by npm, about 30 MB)
$nodeVerNow = "$((& $node --version) 2>$null)".Trim()
foreach ($dir in @($MetaDir, $DeployDir)) {
    $name = Split-Path -Leaf $dir
    $sqlite = Join-Path $dir 'node_modules\better-sqlite3\build\Release\better_sqlite3.node'
    $stampFile = Join-Path $dir 'node_modules\.installed-for-node'
    $ok = (Test-Path -LiteralPath $sqlite) -and (Test-Path -LiteralPath $stampFile) -and ((Get-Content -LiteralPath $stampFile -Raw).Trim() -eq $nodeVerNow)
    if ($ok) { Say "Backend parts ($name): already installed." 'Green'; continue }
    Say "Installing the backend parts ($name). This needs the internet once and takes a minute..."
    Push-Location -LiteralPath $dir
    try {
        $code = Invoke-Native $npm @('ci', '--omit=dev', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error')
    } finally { Pop-Location }
    if ($code -ne 0 -or -not (Test-Path -LiteralPath $sqlite)) {
        Fail "installing the backend parts ($name) failed. Check your internet connection and run set-up again. If it keeps failing, send the text above to whoever helps you."
    }
    [IO.File]::WriteAllText($stampFile, $nodeVerNow)
    Say "Backend parts ($name): installed." 'Green'
}

# ---------------------------------------------------------------- 4. the two DLLs (loader + 1.6.2 server code)
foreach ($pair in @(@($loader, $dxgi, $LoaderHash, 'Loader (dxgi.dll)'), @($server, $srvDll, $ServerHash, 'Server code (UndauntedInternalServer.dll)'))) {
    $src, $dst, $want, $label = $pair
    $h = Hash256 $dst
    if ($h -eq $want) { Say "${label}: already in place." 'Green'; continue }
    if ($h -ne '(missing)') {
        $park = Join-Path $backup ("replaced_${stamp}_" + (Split-Path -Leaf $dst))
        Move-Item -LiteralPath $dst -Destination $park
        Say "  A different $(Split-Path -Leaf $dst) was in the game folder (an older build, or a mod like ReShade). Kept as $park" 'Yellow'
    }
    Copy-Item -LiteralPath $src -Destination $dst
    if ((Hash256 $dst) -ne $want) { Fail "copying $(Split-Path -Leaf $dst) into the game folder failed." }
    Say "${label}: installed." 'Green'
}

# ---------------------------------------------------------------- 5. player name, account and backend settings
New-Item -ItemType Directory -Force $DataDir, $LogDir | Out-Null
$name = 'Slayer'
if ($cfg -and $cfg.PlayerName) { $name = $cfg.PlayerName }
$hasAccount = (Test-Path -LiteralPath (Join-Path $DataDir 'player.key'))
if (-not $hasAccount) {
    Say ''
    $n = Read-Host 'Your player name (3-16 letters/numbers; Enter for "Slayer")'
    if ($n -match '^[A-Za-z0-9_]{3,16}$') { $name = $n } elseif ($n) { Say '  Not a valid name, using Slayer.' 'Yellow' }
}
Clear-DauntlessPorts -TcpPorts @($MetaPort, $DeployPort)
Say 'Setting up the local backend (your account, keys and settings)...'
$code = Invoke-Native $node @((Join-Path $PSScriptRoot 'backend-setup.js'), $exe, $name)
if ($code -ne 0) { Fail 'setting up the local backend failed (see the line above).' }
Say "Player name: $name" 'Green'

# ---------------------------------------------------------------- 6. private settings folder with the backend addresses
$privCfg = Join-Path $HomeDir 'AppData\Local\Archon\Saved\Config\WindowsClient'
foreach ($d in @($privCfg, (Join-Path $HomeDir 'AppData\Roaming'), (Join-Path $HomeDir 'Documents'))) { New-Item -ItemType Directory -Force $d | Out-Null }
Copy-Item -LiteralPath (Join-Path $Root 'profile\Game.ini') -Destination (Join-Path $privCfg 'Game.ini') -Force

# ---------------------------------------------------------------- 7. finish
Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
foreach ($d in @('upload')) { New-Item -ItemType Directory -Force (Join-Path $Root $d) | Out-Null }
Save-Config ([pscustomobject]@{ GameDir = $gameDir; Node = $node; PrereqsDone = $prereqsDone; PlayerName = $name; SetupDate = (Get-Date -Format 'yyyy-MM-dd HH:mm') })

Say ''
Say 'SET-UP DONE. Double-click "2 - PLAY.bat" to play.' 'Green'
Say 'If Windows asks whether Node.js or Dauntless may use the network, you can click Cancel: everything stays on this PC.'
Say ''
