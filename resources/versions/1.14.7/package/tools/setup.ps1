# Dauntless Forever - Dauntless 1.14.7 offline package
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# setup.ps1 - one-time set-up for playing Dauntless 1.14.7 offline. Started by "1 - SETUP.bat".
#   setup.ps1             set up (safe to run again at any time; it only fixes what is missing)
#   setup.ps1 -Uninstall  put the game folder back the way Epic shipped it
param([switch]$Uninstall, [switch]$Auto)
# -Auto (DF-AUTO): the launcher runs set-up by itself after the download, without a window. Every question is answered
# "yes" (use the folder it found, install what is missing); with no game folder found it stops and says so.
. (Join-Path $PSScriptRoot 'common.ps1')

$standIn = Join-Path $Root 'bin\EOSSDK-Win64-Shipping.dll'
$loader  = Join-Path $Root 'bin\dxgi.dll'
$backup  = Join-Path $Root 'backup'

Say ''
Say '=== Dauntless 1.14.7 offline - set-up ===' 'Cyan'
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
    # offline sign-in: put Epic's original back if it is there
    $ueos = Join-Path $ubin 'EOSSDK-Win64-Shipping.dll'
    $uepic = "$ueos.epic"
    if ((Hash256 $ueos) -eq $EpicEosHash) { Say "Epic's sign-in file is already in place." 'Green' }
    elseif (Test-Path -LiteralPath $uepic) {
        if (Test-Path -LiteralPath $ueos) { Move-Item -LiteralPath $ueos -Destination (Join-Path $ubak "removed_${ustamp}_EOSSDK-Win64-Shipping.dll") }
        Rename-Item -LiteralPath $uepic -NewName 'EOSSDK-Win64-Shipping.dll'
        Say "Epic's sign-in file is back." 'Green'
    } else {
        Say "Epic's original sign-in file (.dll.epic) is not in the game folder, so the offline one stays. Verify the game files to get Epic's back." 'Yellow'
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


if ((Hash256 $standIn) -ne $StandInHash -or (Hash256 $loader) -ne $LoaderHash) {
    Fail "files in the bin folder are missing or damaged. Unzip the package again (all of it) and re-run set-up."
}
if (@(Get-PlayerGame).Count -gt 0 -or @(Get-ServerCopies).Count -gt 0) {
    Say 'Dauntless is running. Closing the server copies started by this package...'
    foreach ($c in Get-ServerCopies) { Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    if (@(Get-PlayerGame).Count -gt 0) { Fail 'please close the game first, then run set-up again.' }
}

# ---------------------------------------------------------------- 1. find the game
function Resolve-GameDir([string]$pick) {
    if (-not $pick) { return $null }
    $pick = $pick.Trim().Trim('"')
    if (-not (Test-Path -LiteralPath $pick)) { return $null }
    if ((Get-Item -LiteralPath $pick).PSIsContainer -eq $false) { $pick = Split-Path -Parent $pick }
    # accept the game folder itself, or any folder inside it, or a folder that contains it
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
    Say 'Looking for Dauntless 1.14.7 on your drives...'
    $cands = New-Object System.Collections.Generic.List[string]
    foreach ($drv in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | Where-Object { $_.Root -match '^[A-Z]:\\$' })) {
        foreach ($base in @($drv.Root, (Join-Path $drv.Root 'Games'), (Join-Path $drv.Root 'Epic Games'), (Join-Path $drv.Root 'Program Files\Epic Games'))) {
            Get-ChildItem -LiteralPath $base -Directory -Filter '*auntless*' -ErrorAction SilentlyContinue | ForEach-Object { $cands.Add($_.FullName) }
        }
    }
    foreach ($b in @((Split-Path -Parent $Root), [Environment]::GetFolderPath('Desktop'), (Join-Path $env:USERPROFILE 'Downloads'))) {
        Get-ChildItem -LiteralPath $b -Directory -Filter '*auntless*' -ErrorAction SilentlyContinue | ForEach-Object { $cands.Add($_.FullName) }
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
        $a = if ($Auto) { '' } else { Read-Host 'Use this folder? Press Enter for yes, or type N to pick another' }
        if ($a -match '^[nN]') { $gameDir = $null }
    }
}
if (-not $gameDir -and $Auto) { Fail 'the game folder was not found. In the launcher use More > "Use a game folder I already have", or Download.' }
while (-not $gameDir) {
    Say ''
    Say 'Pick the Dauntless 1.14.7 game folder (the one that has the "Archon" folder inside it).' 'White'
    $pick = $null
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = 'Pick the Dauntless 1.14.7 game folder (it has the Archon folder inside it)'
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
    Fail ("the game in $gameDir is not Dauntless 1.14.7 (build 647472). This package only works with that exact version.`n" +
          "         Your exe: $(Hash256 $exe)`n         Needed:   $ExeHash")
}
Say 'Dauntless 1.14.7: correct version.' 'Green'

$probe = Join-Path $bin ('write_test_' + [guid]::NewGuid().ToString('N') + '.tmp')
try { [System.IO.File]::WriteAllText($probe, 'x'); Remove-Item -LiteralPath $probe -Force }
catch { Fail "Windows will not let set-up change files in $bin. Move the game to a folder like C:\Games, or right-click '1 - SETUP.bat' and choose 'Run as administrator'." }

$eosDll  = Join-Path $bin 'EOSSDK-Win64-Shipping.dll'
$eosEpic = "$eosDll.epic"
$dxgi    = Join-Path $bin 'dxgi.dll'
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
    $a = if ($Auto) { '' } else { Read-Host "Install $What now with winget? Press Enter for yes, or type N for no" }
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
    $a = if ($Auto) { '' } else { Read-Host 'Download and install it now? Press Enter for yes, or type N for no' }
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

# ---------------------------------------------------------------- 2. Node.js (runs the small local backend)
Say ''
$node = Find-Node
if (-not $node) {
    Say 'Node.js is not installed. It is needed to run the small local backend the game talks to.' 'White'
    $hasWinget = [bool](Get-Command winget.exe -ErrorAction SilentlyContinue)
    if ($hasWinget) {
        $a = if ($Auto) { '' } else { Read-Host 'Install Node.js LTS now with winget? Press Enter for yes, or type N for no' }
        if ($a -notmatch '^[nN]') {
            & winget.exe install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
            $node = Find-Node
        }
    }
    if (-not $node) {
        Start-Process 'https://nodejs.org/en/download' -ErrorAction SilentlyContinue
        Fail 'install Node.js (the LTS version) from https://nodejs.org (the page should have opened), then run set-up again.'
    }
}
$nodeVer = (& $node --version) 2>$null
if ("$nodeVer" -match '^v(\d+)\.' -and [int]$Matches[1] -lt 16) { Fail "Node.js $nodeVer is too old. Install the current LTS from https://nodejs.org and run set-up again." }
Say "Node.js $nodeVer : $node" 'Green'

# ---------------------------------------------------------------- 3. offline sign-in (replaces Epic's sign-in file, keeps the original)
$h = Hash256 $eosDll
if ($h -eq $StandInHash) { Say 'Offline sign-in: already in place.' 'Green' }
else {
    if ($h -eq $EpicEosHash) {
        if (Test-Path -LiteralPath $eosEpic) { Move-Item -LiteralPath $eosEpic -Destination (Join-Path $backup ('old_epic_copy_' + (Get-Date -Format 'yyyyMMdd_HHmmss') + '.dll')) }
        Rename-Item -LiteralPath $eosDll -NewName 'EOSSDK-Win64-Shipping.dll.epic'
    } elseif ((Hash256 $eosEpic) -eq $EpicEosHash) {
        if ($h -ne '(missing)') { Move-Item -LiteralPath $eosDll -Destination (Join-Path $backup ('eos_replaced_' + (Get-Date -Format 'yyyyMMdd_HHmmss') + '.dll')) }
    } else {
        Fail "EOSSDK-Win64-Shipping.dll in $bin is not Epic's original and no original (.dll.epic) is there. Re-download or verify the game, then run set-up again."
    }
    Copy-Item -LiteralPath $standIn -Destination $eosDll
    if ((Hash256 $eosDll) -ne $StandInHash) { Fail 'copying the offline sign-in file failed.' }
    Say "Offline sign-in: installed (Epic's original kept as EOSSDK-Win64-Shipping.dll.epic)." 'Green'
}

# ---------------------------------------------------------------- 4. server loader (only active when this package starts a server copy)
$h = Hash256 $dxgi
if ($h -eq $LoaderHash) { Say 'Server loader: already in place.' 'Green' }
else {
    if ($h -ne '(missing)') {
        $park = Join-Path $backup ('dxgi_replaced_' + (Get-Date -Format 'yyyyMMdd_HHmmss') + '.dll')
        Move-Item -LiteralPath $dxgi -Destination $park
        Say "  A different dxgi.dll was in the game folder (an older version of this loader, or a mod like ReShade). Kept as $park" 'Yellow'
    }
    Copy-Item -LiteralPath $loader -Destination $dxgi
    if ((Hash256 $dxgi) -ne $LoaderHash) { Fail 'copying the server loader failed.' }
    Say 'Server loader: installed. (It does nothing unless PLAY starts a server copy.)' 'Green'
}

# ---------------------------------------------------------------- 5. backend replies recorded from the live servers (public, downloaded once)
$capDir = Join-Path $Root 'captures'
function Test-Captures { [bool](Get-ChildItem -LiteralPath $capDir -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'Login\README.md') }) }
if (Test-Captures) { Say 'Backend reference data: already downloaded.' 'Green' }
else {
    Say 'Downloading the backend reference data (public DauntlessEndpointDocumentation, a few MB)...'
    New-Item -ItemType Directory -Force $capDir | Out-Null
    $zip = Join-Path $capDir 'main.zip'
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $CapturesUrl -OutFile $zip -UseBasicParsing
        Expand-Archive -LiteralPath $zip -DestinationPath $capDir -Force
        Remove-Item -LiteralPath $zip -Force
    } catch { Say "  Download failed: $($_.Exception.Message)" 'Yellow' }
    if (-not (Test-Captures)) {
        Fail ("could not get the backend reference data. Download this file in your browser:`n         $CapturesUrl`n" +
              "         and unzip it into: $capDir`n         (so that $capDir\DauntlessEndpointDocumentation-main\Login exists), then run set-up again.")
    }
    Say 'Backend reference data: downloaded.' 'Green'
}

# ---------------------------------------------------------------- 6. player name
$eosDir = Join-Path $Root 'eos'
New-Item -ItemType Directory -Force $eosDir | Out-Null
$ini = Join-Path $eosDir 'eos_offline.ini'
$name = $null
if (Test-Path -LiteralPath $ini) { $m = Select-String -LiteralPath $ini -Pattern '^DisplayName=(.+)$' | Select-Object -First 1; if ($m) { $name = $m.Matches[0].Groups[1].Value.Trim() } }
# One player name for every version: the launcher asks once and passes it in DF_PLAYER_NAME (no question here).
if ($env:DF_PLAYER_NAME -match '^[A-Za-z0-9_]{3,16}$') { $name = $env:DF_PLAYER_NAME }
if (-not $name) { $name = 'Slayer' }
function Set-EosName([string]$Ini, [string]$Name) {
    $lines = if (Test-Path -LiteralPath $Ini) { @(Get-Content -LiteralPath $Ini) } else { @('; eos_offline settings. Lines starting with ; are comments.') }
    $done = $false
    $lines = @(foreach ($l in $lines) { if ($l -match '^DisplayName=') { if (-not $done) { "DisplayName=$Name"; $done = $true } } else { $l } })
    if (-not $done) { $lines += "DisplayName=$Name" }
    [System.IO.File]::WriteAllText($Ini, (($lines -join "`r`n") + "`r`n"), [System.Text.Encoding]::ASCII)
}
Set-EosName $ini $name
Say "Player name: $name" 'Green'

# ---------------------------------------------------------------- 7. finish
Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
foreach ($d in @('data', 'logs', 'upload')) { New-Item -ItemType Directory -Force (Join-Path $Root $d) | Out-Null }
Save-Config ([pscustomobject]@{ GameDir = $gameDir; Node = $node; PrereqsDone = $prereqsDone; SetupDate = (Get-Date -Format 'yyyy-MM-dd HH:mm') })

Say ''
Say 'SET-UP DONE. Double-click "2 - PLAY.bat" to play.' 'Green'
Say 'If Windows asks whether Dauntless may use the network, you can click Cancel: everything stays on this PC.'
Say ''
