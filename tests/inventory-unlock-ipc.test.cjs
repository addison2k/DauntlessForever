'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../src/main/main.js'), 'utf8');
const inventory = source.slice(source.indexOf('// ---------------------------------------------------------------- Inventory'), source.indexOf('// ---------------------------------------------------------------- patch notes'));
const pkg = path.resolve(__dirname, '../resources/versions/1.14.7/package');
function bridge() {
  const handlers = {}, calls = [], active = [];
  let pending;
  vm.runInNewContext(inventory, {
    ipcMain: { handle: (channel, fn) => handlers[channel] = fn }, fs, path,
    byId: id => ({ id, package: {}, dataDir: pkg }), R: { anyRunning: () => active, isRunning: () => false },
    findNode: async () => ({ path: process.execPath }),
    execFile: (exe, args, options, callback) => { calls.push({ exe, args, options }); pending = callback; },
  });
  return { handlers, calls, active, finish: result => pending(null, JSON.stringify(result)) };
}
test('IPC rejects other versions, invalid modes, missing character IDs and active hosting', async () => {
  const b = bridge(), unlock = b.handlers['items:unlock'];
  assert.equal((await unlock(null, '1.6.2', 'char-one', 'all')).ok, false);
  assert.equal((await unlock(null, '1.14.7', '*', 'all')).ok, false);
  assert.equal((await unlock(null, '1.14.7', 'char-one', '--anything')).ok, false);
  b.active.push({ id: '1.14.7:host', kind: 'host' });
  assert.equal((await unlock(null, '1.14.7', 'char-one', 'all')).ok, false);
  assert.equal(b.calls.length, 0);
});
test('IPC sends argument arrays to the helper, excludes overlapping inventory writes and clears busy state', async () => {
  const b = bridge(), unlock = b.handlers['items:unlock'];
  const first = unlock(null, '1.14.7', 'char-one', 'cosmetics-only');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.calls.length, 1);
  assert.deepEqual(Array.from(b.calls[0].args), [path.join(pkg, 'tools', 'items.js'), 'unlock', 'char-one', 'cosmetics-only']);
  assert.equal(b.calls[0].options.windowsHide, true);
  assert.equal((await unlock(null, '1.14.7', 'char-one', 'all')).ok, false);
  assert.equal((await b.handlers['items:set'](null, '1.14.7', 'char-one', { CURRENCY_NOTES: 1 })).ok, false);
  b.finish({ ok: false, error: 'create a character first' });
  assert.equal((await first).ok, false);
  const second = unlock(null, '1.14.7', 'char-one', 'all');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.calls.length, 2);
  b.finish({ ok: true });
  assert.equal((await second).ok, true);
});
