# Dauntless Forever - launcher tools
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# install-hooks.ps1 - DF-PRIVATE (Oct 31): puts two git hooks into this clone's .git\hooks (git never copies hooks on a
# clone, so run this once per clone): commit-msg refuses a message with a private word, pre-push checks every commit
# message and file about to be pushed. Both run tools\check-private.js, which reads wip\private-words.txt.
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$Hooks = Join-Path $Repo '.git\hooks'
if (-not (Test-Path -LiteralPath $Hooks)) { Write-Host "STOPPED: $Hooks is not there (not a git clone?)" -ForegroundColor Yellow; exit 1 }
$commitMsg = @'
#!/bin/sh
# DF-PRIVATE: a commit message with a private word (wip/private-words.txt) is refused. Written by tools/install-hooks.ps1.
exec node "$(git rev-parse --show-toplevel)/tools/check-private.js" --msg "$1"
'@
$prePush = @'
#!/bin/sh
# DF-PRIVATE: every commit message and file being pushed is checked for private words. Written by tools/install-hooks.ps1.
root="$(git rev-parse --show-toplevel)"
while read lref lsha rref rsha; do
  case "$lsha" in 0000000000000000000000000000000000000000) continue ;; esac
  node "$root/tools/check-private.js" --push "$rsha" "$lsha" || exit 1
done
exit 0
'@
foreach ($h in @(@('commit-msg', $commitMsg), @('pre-push', $prePush))) {
    $f = Join-Path $Hooks $h[0]
    [IO.File]::WriteAllText($f, (($h[1] -replace "`r`n", "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))   # LF only: git runs hooks with sh
    Write-Host "hook written: $f" -ForegroundColor Green
}
if (-not (Test-Path -LiteralPath (Join-Path $Repo 'wip\private-words.txt'))) { Write-Host 'Note: wip\private-words.txt is missing: the hooks and the build stop until it is there.' -ForegroundColor Yellow }
