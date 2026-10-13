// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// sky.js - the scene behind the pages: an aurora drifting in the launcher's own teal and gold, sparse snow,
// a faint ridge line along the bottom. Quiet on purpose; the pages sit on top of it.
// Pauses when the window is hidden, when a game is running, and stays still if the OS asks for reduced motion.
'use strict';
const Sky = (() => {
  const canvas = document.getElementById('sky');
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let enabled = true, paused = false, raf = 0, w = 0, h = 0, t0 = performance.now();
  try { enabled = localStorage.getItem('sky') !== 'off'; } catch {}

  const flakes = [];
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    flakes.length = 0;
    const n = Math.floor((w * h) / 42000);
    for (let i = 0; i < n; i++) flakes.push(newFlake(true));
  }
  function newFlake(anywhere) {
    const z = Math.random();                      // depth: far flakes are small, slow and dim
    return { x: Math.random() * w, y: anywhere ? Math.random() * h : -6, z, r: 0.6 + z * 1.4, vy: 8 + z * 18, vx: (Math.random() - 0.5) * 6, ph: Math.random() * Math.PI * 2 };
  }

  // the ridge: one fixed polyline per size, drawn once into an offscreen canvas
  let ridge = null;
  function buildRidge() {
    ridge = document.createElement('canvas'); ridge.width = canvas.width; ridge.height = canvas.height;
    const c = ridge.getContext('2d'); c.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0);
    const layers = [[0.86, 0.06, '#121a21'], [0.91, 0.045, '#0d141a']];
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (const [base, amp, col] of layers) {
      c.fillStyle = col; c.beginPath(); c.moveTo(0, h);
      let y = h * base;
      for (let x = 0; x <= w + 40; x += 40) { y = h * base + (rnd() - 0.5) * h * amp * 2 + Math.sin(x / 260) * h * amp; c.lineTo(x, y); }
      c.lineTo(w + 40, h); c.closePath(); c.fill();
    }
  }

  function aurora(time) {
    const t = time / 1000;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const bands = [
      { y: 0.08, hue: [95, 211, 198], amp: 0.10, speed: 0.07, a: 0.20 },   // teal
      { y: 0.18, hue: [214, 171, 74], amp: 0.07, speed: -0.05, a: 0.10 },  // gold
      { y: 0.27, hue: [95, 211, 198], amp: 0.12, speed: 0.04, a: 0.13 },
    ];
    for (const b of bands) {
      ctx.beginPath();
      const step = 24;
      for (let x = -step; x <= w + step; x += step) {
        const y = h * b.y + Math.sin(x / 190 + t * b.speed * 4) * h * b.amp * 0.5 + Math.sin(x / 61 - t * b.speed * 7) * h * b.amp * 0.18;
        x === -step ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      for (let x = w + step; x >= -step; x -= step) {
        const y = h * b.y + Math.sin(x / 190 + t * b.speed * 4) * h * b.amp * 0.5 + h * (0.16 + 0.04 * Math.sin(x / 140 + t * 0.3));
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      const g = ctx.createLinearGradient(0, h * (b.y - 0.1), 0, h * (b.y + 0.3));
      const [r, gg, bb] = b.hue;
      g.addColorStop(0, `rgba(${r},${gg},${bb},0)`); g.addColorStop(0.35, `rgba(${r},${gg},${bb},${b.a})`); g.addColorStop(1, `rgba(${r},${gg},${bb},0)`);
      ctx.fillStyle = g; ctx.filter = 'blur(26px)'; ctx.fill();
    }
    ctx.restore(); ctx.filter = 'none';
  }

  let last = 0;
  function frame(time) {
    raf = 0;
    if (!enabled || paused) return;
    const dt = Math.min((time - last) / 1000, 0.1); last = time;
    ctx.clearRect(0, 0, w, h);
    aurora(time - t0);
    ctx.drawImage(ridge, 0, 0, w, h);
    for (const f of flakes) {
      if (!reduced) { f.y += f.vy * dt; f.x += (f.vx + Math.sin(time / 1400 + f.ph) * 8) * dt; }
      if (f.y > h + 6 || f.x < -8 || f.x > w + 8) Object.assign(f, newFlake(false));
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(230,237,243,${0.08 + f.z * 0.3})`; ctx.fill();
    }
    if (!reduced) raf = requestAnimationFrame(frame);
  }
  function start() { if (!raf && enabled && !paused) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  function init() {
    resize(); buildRidge(); start();
    window.addEventListener('resize', () => { resize(); buildRidge(); if (reduced) { last = performance.now(); frame(performance.now()); } });
    document.addEventListener('visibilitychange', () => document.hidden ? stop() : start());
  }
  function toggle() {
    enabled = !enabled;
    try { localStorage.setItem('sky', enabled ? 'on' : 'off'); } catch {}
    if (enabled) start(); else { stop(); ctx.clearRect(0, 0, w, h); }
    return enabled;
  }
  function pause(p) { paused = !!p; if (paused) { stop(); ctx.clearRect(0, 0, w, h); } else start(); }

  init();
  return { toggle, pause, enabled: () => enabled };
})();
