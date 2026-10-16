// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// voice.js - voice chat with the people in your game (the game's own voice ran on Vivox, which is gone).
//
//   - One voice room per hosted game, named by the host's friends id: the host is in their own room, a friend
//     who joined through the Friends page is in the host's. The launcher goes in and out by itself.
//   - The friends service on the VPS only introduces the launchers (WebRTC offers/answers through a long poll)
//     and hands out TURN logins. The sound goes player to player, or through the VPS's TURN server when a
//     direct path is blocked. The window (renderer/voice.js) does the WebRTC and the microphone.
//   - Push to talk works while the game has the focus: a small hidden PowerShell helper reads the key's state
//     (GetAsyncKeyState) every 10 ms. It never blocks the key, so the game still sees it: pick a key the game
//     does not use. Mouse buttons 4 and 5 work too.
'use strict';
const { spawn } = require('child_process');
const { ipcMain } = require('electron');
const settings = require('./settings');

const DEFAULTS = { auto: true, mode: 'ptt', pttKey: null, vadLevel: 35, inputId: '', volumes: {}, muted: false };

let ctx = null;           // { social, send, log }
let room = null;          // { id, name, iceServers }
let peers = [];           // [{ id, name }]
let rev = 0;
let leftByUser = null;    // the room the player left by hand: not re-joined until the game changes
let joinedByUser = false;
let polling = false;
let lastError = '';
let helper = null, helperBuf = '', helperReady = false, pttDown = false, captureWaiter = null;

const cfg = () => ({ ...DEFAULTS, ...(settings.load().voice || {}) });
function saveCfg(patch) {
  settings.update(s => { s.voice = { ...DEFAULTS, ...(s.voice || {}), ...patch }; });
  return cfg();
}

// ------------------------------------------------------------------ key names (Windows virtual-key codes)
const NAMED = {
  0x04: 'Middle mouse', 0x05: 'Mouse 4', 0x06: 'Mouse 5', 0x08: 'Backspace', 0x09: 'Tab', 0x0D: 'Enter', 0x13: 'Pause',
  0x14: 'Caps Lock', 0x1B: 'Esc', 0x20: 'Space', 0x21: 'Page Up', 0x22: 'Page Down', 0x23: 'End', 0x24: 'Home',
  0x25: 'Left', 0x26: 'Up', 0x27: 'Right', 0x28: 'Down', 0x2D: 'Insert', 0x2E: 'Delete', 0x90: 'Num Lock', 0x91: 'Scroll Lock',
  0xA0: 'Left Shift', 0xA1: 'Right Shift', 0xA2: 'Left Ctrl', 0xA3: 'Right Ctrl', 0xA4: 'Left Alt', 0xA5: 'Right Alt',
  0xBA: ';', 0xBB: '=', 0xBC: ',', 0xBD: '-', 0xBE: '.', 0xBF: '/', 0xC0: '`', 0xDB: '[', 0xDC: '\\', 0xDD: ']', 0xDE: "'",
  0x6A: 'Num *', 0x6B: 'Num +', 0x6D: 'Num -', 0x6E: 'Num .', 0x6F: 'Num /',
};
function keyName(vk) {
  if (NAMED[vk]) return NAMED[vk];
  if ((vk >= 0x30 && vk <= 0x39) || (vk >= 0x41 && vk <= 0x5A)) return String.fromCharCode(vk);
  if (vk >= 0x60 && vk <= 0x69) return 'Num ' + (vk - 0x60);
  if (vk >= 0x70 && vk <= 0x87) return 'F' + (vk - 0x6F);
  return 'Key ' + vk;
}

// ------------------------------------------------------------------ push-to-talk helper
// Inline (not a file): the launcher's own files sit inside app.asar, which PowerShell cannot read.
const HELPER = `
$ErrorActionPreference = 'Stop'
$src = @'
using System; using System.Runtime.InteropServices; using System.Threading;
public static class DFPtt {
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
  static volatile int watch = 0; static volatile bool capture = false;
  static bool Down(int k) { return (GetAsyncKeyState(k) & 0x8000) != 0; }
  public static void Run() {
    var t = new Thread(() => {
      string l;
      while ((l = Console.In.ReadLine()) != null) {
        l = l.Trim();
        if (l.StartsWith("watch ")) { int v; if (int.TryParse(l.Substring(6), out v)) watch = v; }
        else if (l == "capture") capture = true;
        else if (l == "cancel") capture = false;
        else if (l == "quit") break;
      }
      Environment.Exit(0);
    });
    t.IsBackground = true; t.Start();
    bool was = false, primed = false; bool[] held = new bool[256];
    Console.Out.WriteLine("ready"); Console.Out.Flush();
    while (true) {
      if (capture) {
        if (!primed) { for (int k = 1; k < 256; k++) held[k] = Down(k); primed = true; }
        for (int k = 3; k < 256; k++) {
          if (k == 0x10 || k == 0x11 || k == 0x12) continue;
          bool d = Down(k);
          if (d && !held[k]) { capture = false; Console.Out.WriteLine("key " + k); Console.Out.Flush(); break; }
          held[k] = d;
        }
      } else primed = false;
      int w = watch;
      bool down = w > 0 && Down(w);
      if (down != was) { was = down; Console.Out.WriteLine(down ? "down" : "up"); Console.Out.Flush(); }
      Thread.Sleep(10);
    }
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
[DFPtt]::Run()
`;
function startHelper() {
  if (helper || process.platform !== 'win32') return;
  helperReady = false; helperBuf = '';
  try {
    helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(HELPER, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) { ctx.log('voice: push-to-talk helper did not start: ' + e.message); helper = null; return; }
  const me = helper;
  me.stdout.setEncoding('utf8');
  me.stdout.on('data', (d) => {
    helperBuf += d;
    let i;
    while ((i = helperBuf.indexOf('\n')) >= 0) {
      const line = helperBuf.slice(0, i).trim(); helperBuf = helperBuf.slice(i + 1);
      if (line === 'ready') { helperReady = true; watchKey(); }
      else if (line === 'down' || line === 'up') { pttDown = line === 'down'; ctx.send('voice:ptt', { down: pttDown }); }
      else if (line.startsWith('key ')) { const w = captureWaiter; captureWaiter = null; if (w) w(Number(line.slice(4))); }
    }
  });
  me.stderr.on('data', (d) => ctx.log('voice helper: ' + String(d).trim().slice(0, 300)));
  me.on('exit', (code) => {
    if (helper === me) { helper = null; helperReady = false; }
    if (pttDown) { pttDown = false; ctx.send('voice:ptt', { down: false }); }
    if (captureWaiter) { const w = captureWaiter; captureWaiter = null; w(null); }
    if (code) ctx.log('voice: push-to-talk helper stopped (' + code + ')');
  });
  me.stdin.on('error', () => {});
}
function helperSay(line) { try { if (helper && helperReady) helper.stdin.write(line + '\n'); } catch {} }
function watchKey() { const c = cfg(); helperSay('watch ' + (room && c.mode === 'ptt' && c.pttKey ? c.pttKey.vk : 0)); }
function stopHelper() { if (helper) { try { helper.stdin.write('quit\n'); } catch {} const h = helper; setTimeout(() => { try { h.kill(); } catch {} }, 1000); helper = null; helperReady = false; } }
function needHelper() { const c = cfg(); return (!!room && c.mode === 'ptt' && !!c.pttKey) || !!captureWaiter; }
function syncHelper() { if (needHelper()) { startHelper(); watchKey(); } else if (helper && !captureWaiter) { helperSay('watch 0'); stopHelper(); } }

// ------------------------------------------------------------------ the room
function publicState() {
  const c = cfg();
  const want = ctx.social.currentRoom();
  return {
    room: room ? { id: room.id, name: room.name, iceServers: room.iceServers } : null,
    me: (ctx.social.identity() || {}).id || null,
    peers, error: lastError, settings: { ...c, pttKeyName: c.pttKey ? c.pttKey.name : '' },
    available: want ? { id: want.id, name: want.name, public: !!want.public } : null,
    offline: ctx.social.offlineMode(),
  };
}
function push() { ctx.send('voice:update', publicState()); }

async function join(target) {
  const r = await ctx.social.call('POST', '/v1/voice/join', { room: target.id });
  room = { id: r.room, name: target.name, iceServers: r.iceServers || [] };
  peers = r.peers || []; rev = r.rev || 0; lastError = '';
  ctx.log(`voice: joined ${target.name}'s room (${peers.length} other)`);
  syncHelper(); push();
  pollLoop();
}
async function leave() {
  if (!room) return;
  room = null; peers = []; rev = 0;
  syncHelper(); push();
  try { await ctx.social.call('POST', '/v1/voice/leave', {}); } catch {}
}
async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    while (room) {
      let r;
      try { r = await ctx.social.call('POST', '/v1/voice/poll', { rev }, false, 30000); }
      catch (e) { lastError = 'Voice: ' + e.message; push(); await new Promise(res => setTimeout(res, 3000)); continue; }
      if (!room) break;
      if (!r.room) {      // the service forgot us (restart, time-out): go back in
        try { await join({ id: room.id, name: room.name }); } catch (e) { lastError = 'Voice: ' + e.message; }
        continue;
      }
      const changed = r.rev !== rev || JSON.stringify(r.peers) !== JSON.stringify(peers);
      rev = r.rev; peers = r.peers || [];
      if (lastError) { lastError = ''; push(); }
      else if (changed) push();
      if (r.signals && r.signals.length) ctx.send('voice:signals', r.signals);
    }
  } finally { polling = false; }
}
// every few seconds: be in the room of the game we are in (unless the player left it by hand)
async function tick() {
  try {
    const c = cfg();
    const want = ctx.social.offlineMode() ? null : ctx.social.currentRoom();
    if (!want) { leftByUser = null; if (room && !joinedByUser) await leave(); }
    else if (room && room.id !== want.id && !joinedByUser) await leave();
    // a game open to everyone: voice starts only when the player presses Join voice (no strangers by surprise)
    if (want && !room && leftByUser !== want.id && ((c.auto && !want.public) || joinedByUser)) await join(want);
    if (room && want && room.id === want.id) joinedByUser = false;
  } catch (e) { lastError = 'Voice: ' + e.message; }
  push();
}

// ------------------------------------------------------------------ IPC
function init(c) {
  ctx = c;
  ipcMain.handle('voice:state', () => publicState());
  ipcMain.handle('voice:join', async () => {
    const want = ctx.social.currentRoom();
    if (!want) return { ok: false, error: 'Host a game or join a friend\'s game first.' };
    leftByUser = null; joinedByUser = true;
    try { if (!room) await join(want); return { ok: true }; } catch (e) { joinedByUser = false; return { ok: false, error: e.message }; }
  });
  ipcMain.handle('voice:leave', async () => { leftByUser = room ? room.id : null; joinedByUser = false; await leave(); return { ok: true }; });
  ipcMain.handle('voice:signal', async (_e, to, data) => {
    if (!room || typeof data !== 'string') return { ok: false };
    try { await ctx.social.call('POST', '/v1/voice/signal', { to, data }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('voice:settings', (_e, patch) => {
    const allowed = {};
    for (const k of ['auto', 'mode', 'vadLevel', 'inputId', 'volumes', 'muted']) if (patch && k in patch) allowed[k] = patch[k];
    if ('mode' in allowed && !['ptt', 'vad'].includes(allowed.mode)) delete allowed.mode;
    if ('vadLevel' in allowed) allowed.vadLevel = Math.max(0, Math.min(100, Number(allowed.vadLevel) || 0));
    if (patch && patch.clearKey) allowed.pttKey = null;
    saveCfg(allowed); syncHelper(); push(); setTimeout(tick, 50);
    return publicState();
  });
  // wait for the next key or mouse button (not left/right click); Esc cancels
  ipcMain.handle('voice:captureKey', () => new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, error: 'Push to talk needs Windows.' });
    if (captureWaiter) { const w = captureWaiter; captureWaiter = null; w(null); }
    const timer = setTimeout(() => { if (captureWaiter === waiter) { captureWaiter = null; helperSay('cancel'); syncHelper(); resolve({ ok: false, error: 'No key was pressed.' }); } }, 15000);
    const waiter = (vk) => {
      clearTimeout(timer);
      if (!vk || vk === 0x1B) { syncHelper(); return resolve({ ok: false, cancelled: true }); }
      saveCfg({ pttKey: { vk, name: keyName(vk) }, mode: 'ptt' });
      syncHelper(); push();
      resolve({ ok: true, key: keyName(vk) });
    };
    captureWaiter = waiter;
    startHelper();
    const go = () => { if (captureWaiter !== waiter) return; if (helperReady) helperSay('capture'); else setTimeout(go, 100); };
    go();
  }));
  ipcMain.handle('voice:cancelCapture', () => { if (captureWaiter) { const w = captureWaiter; captureWaiter = null; helperSay('cancel'); w(null); } return true; });
  setInterval(tick, 3000);
  setTimeout(tick, 1500);
}
async function shutdown() { stopHelper(); if (room) { const r = room; room = null; try { await ctx.social.call('POST', '/v1/voice/leave', {}); } catch {} ctx.log('voice: left ' + r.name); } }

module.exports = { init, shutdown };
