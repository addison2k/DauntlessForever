# stop.ps1 - "STOP (if something got stuck).bat": closes everything this package started.
# It does not close your own game window; close that first if it is stuck.
. (Join-Path $PSScriptRoot 'common.ps1')
Say ''
Say '=== Dauntless 1.6.2 offline - stop ===' 'Cyan'
if (@(Get-PlayerGame).Count -gt 0) { Say 'Your game is still open. Close it (or end Dauntless-Win64-Shipping in Task Manager) if it is stuck.' 'Yellow' }
Stop-Everything
