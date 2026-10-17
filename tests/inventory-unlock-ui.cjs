// Run with: npx electron tests/inventory-unlock-ui.cjs [screenshot.png]
// Exercises the actual renderer in a hidden Chromium window with an isolated IPC fixture.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const { pathToFileURL } = require('url');
const root = path.resolve(__dirname, '..');
const renderer = path.join(root, 'src', 'renderer');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'df-unlock-ui-'));
app.setPath('userData', path.join(temp, 'profile'));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1340, height: 900, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  const run = code => window.webContents.executeJavaScript(code);
  try {
    const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
      .replace('<head>', `<head><base href="${pathToFileURL(renderer + path.sep).href}">`);
    const page = path.join(temp, 'index.html'); fs.writeFileSync(page, html);
    await window.loadFile(page);
    await run(`window.__calls = []; window.__reply = null;
      window.launcher = {
        items: async id => window.__fixtures[id],
        unlockItems: (id, characterId, mode) => { window.__calls.push({id, characterId, mode}); return new Promise(resolve => window.__reply = resolve); }
      }; void 0;`);
    const source = fs.readFileSync(path.join(renderer, 'app.js'), 'utf8').replace(/\bboot\(\);\s*$/, '');
    await run(source + `
      window.__render = async (id, running = false, character = true) => {
        versions = [{id:'1.14.7',hasPackage:true}, {id:'1.6.2',hasPackage:true}];
        window.__fixtures = Object.fromEntries(versions.map(v => [v.id, {groups:[{title:'Currencies',items:[{id:'CURRENCY_NOTES',name:'Rams'}]}],running,
          unlockEverything: v.id === '1.14.7',save:{ok:true,characters:character ? [{id:'test-character',name:'Test Slayer',items:{CURRENCY_NOTES:50}}] : []}}]));
        selected = itemVer = id; itemChar = null; itemData = null; itemPending = {}; itemNote = null; itemUnlockBusy = false;
        for (const pg of document.querySelectorAll('.page')) pg.hidden = pg.id !== 'page-items';
        for (const nav of document.querySelectorAll('.nav-item')) nav.classList.toggle('selected', nav.dataset.page === 'items');
        await renderItems(true);
      }; void 0;`);
    await run(`window.__render('1.14.7', false, false)`);
    assert.equal(await run(`document.getElementById('item-body').hidden`), true);
    assert.match(await run(`document.getElementById('item-none-text').textContent`), /make a character first/);
    await run(`window.__render('1.6.2')`);
    assert.equal(await run(`document.getElementById('item-unlock').hidden`), true);
    await run(`window.__render('1.14.7', true)`);
    assert.equal(await run(`document.getElementById('item-unlock-btn').disabled`), true);
    await run(`window.__render('1.14.7')`);
    assert.equal(await run(`document.getElementById('item-unlock').hidden`), false);
    assert.equal(await run(`document.getElementById('item-unlock-btn').disabled`), false);
    assert.equal(await run(`document.getElementById('item-unlock').getBoundingClientRect().top >= document.querySelector('.item-bar').getBoundingClientRect().bottom`), true);
    await run(`itemPending = {CURRENCY_NOTES: 100}; renderItems(false)`);
    assert.equal(await run(`document.getElementById('item-unlock-btn').disabled`), true);
    await run(`document.getElementById('item-undo').click()`);
    assert.equal(await run(`document.getElementById('item-unlock-btn').disabled`), false);
    for (const mode of ['cosmetics-only', 'all']) {
      await run(`document.getElementById('item-cosmetics-only').checked = ${mode === 'cosmetics-only'}; document.getElementById('item-cosmetics-only').onchange();`);
      const label = await run(`document.getElementById('item-unlock-btn').textContent`);
      assert.equal(label, mode === 'all' ? 'Unlock and max everything' : 'Unlock cosmetics only');
      await run(`document.getElementById('item-unlock-btn').click()`);
      assert.equal(await run(`document.getElementById('dlg-confirm').open`), true);
      await run(`document.getElementById('confirm-yes').click()`);
      // Wait for the async render before the IPC call.
      for (let n = 0; n < 30 && !await run(`!!window.__reply`); n++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(await run(`window.__calls.at(-1)`), { id: '1.14.7', characterId: 'test-character', mode });
      assert.equal(await run(`document.getElementById('item-unlock-btn').disabled`), true);
      assert.equal(await run(`document.getElementById('item-groups').inert`), true);
      await run(`window.__reply({ok:true,cosmetics:1016,addedGear:0,addedStacks:1016}); window.__reply=null;`);
      for (let n = 0; n < 30 && await run(`itemUnlockBusy`); n++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(await run(`document.getElementById('item-unlock-btn').disabled`), false);
      assert.match(await run(`document.getElementById('item-note').textContent`), /1016 skins/);
    }
    // Failure restores the controls and shows the error without losing pending state.
    await run(`document.getElementById('item-unlock-btn').click(); document.getElementById('confirm-yes').click();`);
    for (let n = 0; n < 30 && !await run(`!!window.__reply`); n++) await new Promise(resolve => setTimeout(resolve, 20));
    await run(`window.__reply({ok:false,error:'Close the game first.'}); window.__reply=null;`);
    for (let n = 0; n < 30 && await run(`itemUnlockBusy`); n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(await run(`document.getElementById('item-note').textContent`), /Close the game first/);
    assert.equal(await run(`document.getElementById('item-unlock-btn').disabled`), false);
    await run(`window.__render('1.14.7')`);
    if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), (await window.webContents.capturePage()).toPNG());
    console.log('PASS: real renderer layout, version/character/running gates, pending edits, both modes, busy state, success and failure');
    window.destroy(); app.exit(0);
  } catch (error) { console.error(error); window.destroy(); app.exit(1); }
});
app.on('quit', () => { try { fs.rmSync(temp, { recursive: true, force: true }); } catch {} });
