// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// runner.js - runs the package scripts exactly as the .bat files would, and reports what they print.
//   setup / uninstall: a visible PowerShell window (set-up asks questions: player name, Node.js install).
//   play:              hidden; every line it prints is sent to the launcher window; "STOPPED:" lines are errors.
//   stop:              the package's own stop script(s), then any backend pid file it keeps.
'use strict';
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { IS_WIN, MOCK, bundledNode } = require('./paths');

const PS = 'powershell.exe';
const PS_ARGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass'];

const running = new Map(); // versionId -> { kind, child }

// Windows: a program installed while the launcher is open (Node.js via winget) is on the system PATH, but not
// on ours. Rebuild PATH from the registry before starting a script, so set-up and play see it without a restart.
const { execFileSync } = require('child_process');
function freshEnv() {
  const env = { ...process.env };
  // The Node.js that ships with the launcher: the package scripts use it first (Find-Node), so players never install Node.
  const bn = bundledNode();
  if (bn) {
    env.DF_NODE = bn;
    // Also first on PATH, so server files from before DF_NODE (their Find-Node looks at PATH first) use it too.
    const k = Object.keys(env).find(x => x.toLowerCase() === 'path') || 'Path';
    env[k] = path.dirname(bn) + ';' + (env[k] || '');
  }
  if (!IS_WIN) return env;
  const read = (key) => {
    try {
      const out = execFileSync('reg.exe', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true });
      const m = /\s+Path\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im.exec(out);
      return m ? m[1].trim() : '';
    } catch { return ''; }
  };
  const machine = read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');
  const user = read('HKCU\\Environment');
  const expand = (p) => p.replace(/%([^%]+)%/g, (_, n) => process.env[n] || '');
  const merged = [machine, user].filter(Boolean).map(expand).join(';');
  if (merged) {
    const have = new Set((env.Path || env.PATH || '').split(';').map(x => x.trim().toLowerCase()));
    const extra = merged.split(';').map(x => x.trim()).filter(x => x && !have.has(x.toLowerCase()));
    if (extra.length) { const k = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'Path'; env[k] = env[k] + ';' + extra.join(';'); }
  }
  return env;
}

function isRunning(id) { return running.has(id); }
function anyRunning() { return [...running.entries()].map(([id, r]) => ({ id, kind: r.kind })); }

// A visible console window that stays open at the end so the player can read the last lines.
// Resolves with the script's exit code when the window closes.
function runVisible(id, kind, scriptPath, args, title) {
  return new Promise((resolve) => {
    if (!IS_WIN) { setTimeout(() => resolve(MOCK ? 0 : 1), 1500); return; }
    // Only single quotes inside the PowerShell command, so it can sit inside cmd's double quotes untouched.
    // try/finally: even when the script stops with an error, the window waits so the player can read it
    const psCmd = `try { & '${scriptPath.replace(/'/g, "''")}' ${args.join(' ')} } catch { Write-Host ('ERROR: ' + $_) -ForegroundColor Red } finally { Write-Host ''; Read-Host 'Finished. Press Enter to close this window' | Out-Null }`;
    // cmd /c start /wait gives the script a real console (Read-Host, the folder picker) and waits for it.
    const cmdLine = `cmd.exe /d /c start "${title}" /wait ${PS} -NoProfile -ExecutionPolicy Bypass -Command "${psCmd}"`;
    const child = spawn('cmd.exe', [cmdLine.slice('cmd.exe '.length)],
      { windowsHide: false, windowsVerbatimArguments: true, stdio: 'ignore', cwd: path.dirname(path.dirname(scriptPath)), env: freshEnv() });
    running.set(id, { kind, child });
    child.on('exit', (code) => { running.delete(id); resolve(code == null ? 1 : code); });
    child.on('error', () => { running.delete(id); resolve(1); });
  });
}

// Hidden run with every output line reported. onLine(text, isError). Resolves with the exit code.
function runHidden(id, kind, scriptPath, args, onLine) {
  return new Promise((resolve) => {
    if (!IS_WIN) { return mockPlay(id, kind, onLine, resolve); }
    const child = spawn(PS, [...PS_ARGS, '-File', scriptPath, ...args],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(path.dirname(scriptPath)), env: freshEnv() });
    running.set(id, { kind, child });
    const feed = (stream, isErr) => {
      let buf = '';
      stream.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.search(/\r?\n/)) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + (buf[i] === '\r' ? 2 : 1));
          if (line.trim()) onLine(line, isErr || /^STOPPED:/.test(line.trim()));
        }
      });
      stream.on('end', () => { if (buf.trim()) onLine(buf, isErr); });
    };
    feed(child.stdout, false); feed(child.stderr, true);
    child.on('exit', (code) => { running.delete(id); resolve(code == null ? 1 : code); });
    child.on('error', (e) => { running.delete(id); onLine('Could not start PowerShell: ' + e.message, true); resolve(1); });
  });
}

// Kill a whole process tree (the play script and everything it started) - the STOP button when stuck.
function killTree(id) {
  const r = running.get(id);
  if (!r || !r.child || r.child.exitCode !== null) return false;
  if (IS_WIN) execFile('taskkill', ['/PID', String(r.child.pid), '/T', '/F'], () => {});
  else r.child.kill('SIGTERM');
  return true;
}

// The package's own stop: its stop script(s), then the backend pid file(s) (only if that pid is node).
async function runStop(v, onLine) {
  const pkg = v.package; if (!pkg) return 0;
  let code = 0;
  for (const s of (pkg.stop.scripts || [])) {
    const [rel, ...a] = s;
    const c = await runHidden(v.id + ':stop', 'stop', path.join(v.dataDir, rel), a, onLine);
    if (c) code = c;
  }
  for (const pf of (pkg.stop.pidFiles || [])) {
    const f = path.join(v.dataDir, pf);
    if (!fs.existsSync(f)) continue;
    const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
    if (pid && IS_WIN) {
      await new Promise((res) => execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], (e, out) => {
        if (!e && /"node\.exe"/i.test(out)) execFile('taskkill', ['/PID', String(pid), '/F'], () => { onLine('Local backend closed.', false); res(); });
        else res();
      }));
    }
    try { fs.unlinkSync(f); } catch {}
  }
  return code;
}

function mockPlay(id, kind, onLine, resolve) {
  const lines = ['=== Dauntless offline ===', '1/3 Starting the local backend...', '    Local backend: running.',
    '2/3 Starting the game server. This takes about a minute, please wait...', '    still starting... 10 s', '    Game server: ready after 14 s.',
    '3/3 Starting the game...', '(mock) game running - press STOP to end', 'Shutting down the game server and the local backend...',
    'All closed. Your progress is saved. See you next time!'];
  let i = 0;
  const t = setInterval(() => {
    if (!running.has(id)) { clearInterval(t); resolve(1); return; }
    if (i < lines.length) onLine(lines[i++], false);
    if (i === 8) { /* linger as if the game were open */ i = i; }
    if (i >= lines.length) { clearInterval(t); running.delete(id); resolve(0); }
  }, 700);
  running.set(id, { kind, child: { pid: 0, exitCode: null, kill() { running.delete(id); } } });
}

module.exports = { runVisible, runHidden, runStop, killTree, isRunning, anyRunning };
