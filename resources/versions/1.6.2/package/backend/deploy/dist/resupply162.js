// Dauntless Forever - Dauntless 1.6.2 offline package
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Unlimited Resupply Beacons: based on KombatKing's "Resupply Beacons 162" R1 (Dauntless Forever community, AGPL-3.0-only).
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
'use strict';
// Game Rule "Unlimited Resupply Beacons" (rules.json key unlimited_resupply -> env RULE_UNLIMITED_RESUPPLY).
// When it is on, each new HUNT server gets one 6-byte change in its memory (tools/resupply162.ps1 + .cs): the
// instruction that takes the beacon charge away is skipped. The game exe on disk is never changed.
// - Solo only: never when hosting (DF_HOSTING=1 is set by online-host.ps1 / lan-host.ps1, and online.env sets the
//   rule to 0), so games other players join always have normal beacons.
// - Hunts only: Ramsgate and the Training Dojo are left alone.
// - Never stops a server: if anything does not match (another game build, Windows refused), the hunt simply has
//   normal beacons and the deploy log says why.
const cp = require('node:child_process'), path = require('node:path'), fs = require('node:fs');
const ROOT = path.resolve(__dirname, '..', '..', '..');   // backend/deploy/<dist|src> -> package folder

function Enabled() {
    return process.platform === 'win32' && process.env.DF_HOSTING !== '1' && String(process.env.RULE_UNLIMITED_RESUPPLY ?? '0').trim() === '1';
}

function Apply(child, exe, port, logger) {
    try {
        if (!Enabled() || !child || !child.pid) return;
        const script = path.join(ROOT, 'tools', 'resupply162.ps1');
        if (!fs.existsSync(script)) { logger.warn('[resupply] tools/resupply162.ps1 is missing: normal beacons.'); return; }
        const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        // Give Windows a moment to finish loading the new server before it is read (the helper also retries).
        setTimeout(() => {
            if (child.exitCode !== null) return;
            let out = '';
            const p = cp.spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
                '-ServerPid', String(child.pid), '-GameExe', exe], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            const limit = setTimeout(() => { try { p.kill(); } catch {} }, 60000);
            p.stdout.on('data', d => { out += d; });
            p.stderr.on('data', d => { out += d; });
            p.on('error', e => { clearTimeout(limit); logger.warn(`[resupply] helper could not start (${e && e.code ? e.code : 'error'}): normal beacons on port ${port}.`); });
            p.on('close', code => {
                clearTimeout(limit);
                const last = out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
                if (code === 0) logger.info(`[resupply] Unlimited Resupply Beacons on for the hunt on port ${port}.`);
                else logger.warn(`[resupply] not applied, normal beacons on port ${port}: ${last.slice(0, 200)}`);
            });
        }, 1500);
    } catch (e) {
        logger.warn(`[resupply] skipped: ${e && e.message ? e.message : e}`);
    }
}

module.exports = { Enabled, Apply };
