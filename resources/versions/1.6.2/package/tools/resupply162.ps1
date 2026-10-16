# Dauntless Forever - Dauntless 1.6.2 offline package
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Based on KombatKing's "Resupply Beacons 162" R1 (Dauntless Forever community). Licence: AGPL-3.0-only.
# Called by the deploy server (backend/deploy/.../resupply162.js) for a new hunt server when the Game Rule
# "Unlimited Resupply Beacons" is on in solo play. Changes 6 bytes in that server's memory (resupply162.cs);
# the exe on disk is not touched. Exit 0 = applied, 1 = not applied (the hunt keeps normal beacons).
param([Parameter(Mandatory = $true)][int]$ServerPid, [Parameter(Mandatory = $true)][string]$GameExe)
$ErrorActionPreference = 'Stop'
try {
    if (-not ('DfResupply162' -as [type])) {
        Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'resupply162.cs') -Raw) -Language CSharp
    }
    [DfResupply162]::Apply($ServerPid, $GameExe)
    Write-Output 'Resupply: applied.'
    exit 0
} catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    Write-Output ("Resupply: " + $e.Message)
    exit 1
}
