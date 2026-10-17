'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const pkg = path.resolve(__dirname, '../resources/versions/1.14.7/package');
const helper = require(path.join(pkg, 'tools/unlock1147.cjs'));
const catalog = require(path.join(pkg, 'tools/unlock-catalog1147.json'));
const skin = 'AR_1P_ARCSLAYER_ARMS';
const weapon = 'WP_EB_TRAINING';
const copy = x => JSON.parse(JSON.stringify(x));
const inputs = {
  catalog, nodes: ['starter', 'unlock_hunt'], offers: [{ items: [{ catalogId: skin }, { catalogId: 'DYE_TEST' }, { catalogId: 'BNC_ANIMATION_HP06-1_COINS_00' }] }],
  paths: [
    { progression_id: 'ExperienceTrack_Weapon_Sword', requirements: [{ rank_id: 20, xp_required: 100 }] },
    { progression_id: 'PrestigeTrack_Weapon_Sword', requirements: [] },
    { progression_id: 'season27', premium_gating_entitlement: 'season27_premium', requirements: [{ rank_id: 50, xp_required: 200 }],
      free_rewards: [{ instanced_items: [{ catalog_id: skin }], stacked_items: [{ catalog_id: 'TOKEN_TEST', quantity: 3 }], entitlements: ['reward_flag'] }] },
    { progression_id: 'd24_season1', requirements: [{ rank_id: 50, xp_required: 200 }] },
  ],
};
function fixture() {
  return { metadata: { keep: true }, players: {
    one: { accountId: 'account-one', characters: [{ id: 'char-one', name: 'Original name', data: 'unchanged appearance' }, { id: 'char-two', name: 'Other character' }],
      inventory: { 'char-one': {
        extra: 'keep', instancedItems: [
          { catalogId: skin, instanceId: 'old-skin', itemData: '{}' },
          { catalogId: weapon, instanceId: 'equipped-weapon', updateVersion: 8, itemData: JSON.stringify({ CurrentLevel: 25, CurrentXP: 42, TransmogCatalogID: 'existing-skin', EquippedCells: [{ CellID: 'CELL_EXISTING', SlotIndex: 0 }] }) },
          { catalogId: 'UNLISTED_ITEM', instanceId: 'custom' },
          { catalogId: 'GD_FRAME_STARTER_BASE', instanceId: 'frame' },
        ], stackedItems: [{ catalogId: 'CURRENCY_NOTES', quantity: 123456 }, { catalogId: 'CUSTOM_STACK', quantity: 11 }],
      }, 'char-two': { instancedItems: [], stackedItems: [{ catalogId: 'CURRENCY_NOTES', quantity: 12 }] } },
      loadouts: { 'char-one': { weapon: 'equipped-weapon', glider: 'GD_FRAME_STARTER_BASE' } },
      progress: { tracks: { custom: { progress: 123 } } }, pjmMaps: { main: { nodes: { starter: { objectives: [{ objective_amount: 25 }] } }, update_version: 1 } },
      escalation: {}, entitlements: [{ name: 'keep-entitlement' }],
    },
    two: { characters: [{ id: 'friend', name: 'Friend' }], inventory: { friend: { instancedItems: [], stackedItems: [] } } },
  } };
}
function setup(t, state = fixture()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-unlock-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tools'));
  fs.mkdirSync(path.join(root, 'data'));
  for (const f of ['items.js', 'unlock1147.cjs', 'unlock-catalog1147.json']) fs.copyFileSync(path.join(pkg, 'tools', f), path.join(root, 'tools', f));
  const file = path.join(root, 'data', 'state.json');
  if (state !== null) fs.writeFileSync(file, '\uFEFF' + JSON.stringify(state));
  const captures = path.join(root, 'captures', 'DauntlessEndpointDocumentation-main');
  fs.mkdirSync(path.join(captures, 'Progression'), { recursive: true });
  fs.mkdirSync(path.join(captures, 'Store', 'Product', 'Skus'), { recursive: true });
  fs.writeFileSync(path.join(captures, 'Progression', 'Config.json'), JSON.stringify({ payload: { paths: inputs.paths } }));
  fs.writeFileSync(path.join(captures, 'Progression', 'GetSlayersPath.md'), '```json\n' + JSON.stringify({ payload: { nodes: Object.fromEntries(inputs.nodes.map(id => [id, {}])) } }) + '\n```');
  fs.writeFileSync(path.join(captures, 'Store', 'Product', 'Skus', 'test.json'), JSON.stringify(inputs.offers));
  return { root, file, captures };
}

test('catalog classifies skins as stacks and keeps glider/prototype exclusions', () => {
  assert.equal(catalog.cosmetics.length, 1016);
  assert.equal(new Set(catalog.cosmetics).size, catalog.cosmetics.length);
  for (const id of catalog.cosmetics) { assert.equal(catalog.stacked[id], 1); assert.ok(!catalog.instanced.includes(id)); }
  for (const id of [...catalog.instanced, ...Object.keys(catalog.stacked)]) assert.ok(!id.startsWith('GD_FRAME') && !id.includes('PROTO'));
});

test('cosmetics-only migrates skins and preserves all unrelated state; repeated runs add nothing', () => {
  const state = fixture(), old = copy(state);
  const result = helper.applyUnlock(state, 'char-one', 'cosmetics-only', { catalog });
  assert.equal(result.removedCosmeticInstances, 1);
  assert.equal(result.addedGear, 0);
  const inv = state.players.one.inventory['char-one'];
  assert.deepEqual(inv.instancedItems, old.players.one.inventory['char-one'].instancedItems.filter(x => x.catalogId !== skin));
  assert.deepEqual(inv.stackedItems.slice(0, 2), old.players.one.inventory['char-one'].stackedItems);
  const owned = new Map(inv.stackedItems.map(x => [x.catalogId, x.quantity]));
  for (const id of catalog.cosmetics) assert.ok(owned.get(id) >= 1);
  const repeated = copy(state);
  assert.equal(helper.applyUnlock(state, 'char-one', 'cosmetics-only', { catalog }).addedStacks, 0);
  assert.deepEqual(state, repeated);
  state.players.one.inventory['char-one'] = old.players.one.inventory['char-one'];
  assert.deepEqual(state, old);
});

test('full unlock retains all existing features and selected-character/account scope', () => {
  const state = fixture(), old = copy(state);
  const result = helper.applyUnlock(state, 'char-one', 'all', inputs);
  assert.ok(result.addedGear > 600); assert.ok(result.addedStacks > 3500);
  const p = state.players.one, inv = p.inventory['char-one'];
  const gear = inv.instancedItems.find(x => x.catalogId === weapon), data = JSON.parse(gear.itemData);
  assert.equal(data.CurrentLevel, 25); assert.equal(data.CurrentXP, 42);
  assert.equal(data.IsPowerSurged, true); assert.equal(data.UnlockedAsTransmog, true);
  assert.equal(data.TransmogCatalogID, 'existing-skin'); assert.equal(gear.instanceId, 'equipped-weapon');
  assert.deepEqual(data.EquippedCells, [{ CellID: 'CELL_EXISTING', SlotIndex: 0 }]);
  const stacks = new Map(inv.stackedItems.map(x => [x.catalogId, x.quantity]));
  assert.equal(stacks.get('BNC_ANIMATION_HP06-1_COINS_00'), 1);
  assert.equal(stacks.get('CURRENCY_NOTES'), 123456); assert.equal(stacks.get('TOKEN_TEST'), 99999);
  for (const [id, minimum] of Object.entries(catalog.stacked)) assert.ok(stacks.get(id) >= minimum, id);
  assert.ok(!inv.instancedItems.some(x => catalog.cosmetics.includes(x.catalogId) || x.catalogId.startsWith('GD_FRAME')));
  assert.equal(p.loadouts['char-one'].glider, '');
  assert.equal(p.pjmMaps.main.nodes.starter.node_status, 2); assert.equal(p.pjmMaps.main.nodes.starter.objectives[0].objective_amount, 25);
  assert.equal(p.escalation.ESC_SEASON_6.escalation_level, 50);
  assert.equal(p.progress.tracks.ExperienceTrack_Weapon_Sword.confirmed_premium_rank, 20);
  assert.equal(p.progress.tracks.PrestigeTrack_Weapon_Sword.progress, 10);
  assert.equal(p.progress.tracks.season27.confirmed_premium_rank, 50);
  assert.equal(p.progress.tracks.d24_season1, undefined);
  assert.ok(p.entitlements.some(x => x.name === 'reward_flag'));
  assert.equal(p.unlockEverything1147, true); assert.equal(p.huntPass, 'season27');
  assert.deepEqual(p.characters, old.players.one.characters);
  assert.deepEqual(p.inventory['char-two'], old.players.one.inventory['char-two']);
  assert.deepEqual(state.players.two, old.players.two);
});

test('requires a real character and does not write/backup on missing or invalid input', async t => {
  for (const state of [null, { players: {} }, fixture()]) {
    const { root, file } = setup(t, state);
    const original = fs.existsSync(file) ? fs.readFileSync(file) : null;
    await assert.rejects(helper.unlock(root, 'missing-character', 'all', async () => false), /create a character first/);
    assert.ok(!fs.existsSync(path.join(root, 'backup')));
    if (original) assert.deepEqual(fs.readFileSync(file), original);
  }
  assert.throws(() => helper.applyUnlock(fixture(), 'char-one', 'unknown', inputs), /Unknown unlock mode/);
});

test('backs up exact bytes and saves atomically with both modes', async t => {
  for (const mode of ['all', 'cosmetics-only']) {
    const { root, file } = setup(t), original = fs.readFileSync(file);
    const result = await helper.unlock(root, 'char-one', mode, async () => false);
    assert.equal(result.ok, true);
    assert.deepEqual(fs.readFileSync(path.join(root, result.backup)), original);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.players.one.inventory['char-one'].stackedItems.find(x => x.catalogId === skin).quantity, 1);
    assert.deepEqual(fs.readdirSync(path.join(root, 'data')), ['state.json']);
  }
});

test('running backend, concurrent unlock, changed save and missing captures fail without overwriting', async t => {
  const { root, file, captures } = setup(t), original = fs.readFileSync(file);
  await assert.rejects(helper.unlock(root, 'char-one', 'all', async () => true), /Close the game/);
  fs.writeFileSync(path.join(root, 'data', 'inventory-unlock.lock'), '');
  await assert.rejects(helper.unlock(root, 'char-one', 'all', async () => false), /already running/);
  fs.unlinkSync(path.join(root, 'data', 'inventory-unlock.lock'));
  let calls = 0;
  await assert.rejects(helper.unlock(root, 'char-one', 'all', async () => {
    if (++calls === 2) fs.writeFileSync(file, JSON.stringify({ ...fixture(), changed: true }));
    return false;
  }), /save changed/);
  assert.equal(JSON.parse(fs.readFileSync(file)).changed, true);
  assert.ok(!fs.existsSync(path.join(root, 'backup')));
  fs.writeFileSync(file, original);
  fs.unlinkSync(path.join(captures, 'Progression', 'Config.json'));
  await assert.rejects(helper.unlock(root, 'char-one', 'all', async () => false), /Run Set up/);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.equal((await helper.unlock(root, 'char-one', 'cosmetics-only', async () => false)).ok, true);
});

test('store ownership and fallback shelves apply only after full unlock', t => {
  const { root } = setup(t), offers = [{ id: 'test', remaining: 1, missingEntitlementNames: ['a'] }];
  assert.deepEqual(helper.storeOffers(root, 'test', offers, {}), offers);
  const owned = { unlockEverything1147: true };
  assert.equal(helper.storeOffers(root, 'test', offers, owned)[0].remaining, 0);
  assert.equal(offers[0].remaining, 1);
  assert.equal(helper.storeOffers(root, 'season27_pass', null, owned)[0].entitlements[0].name, 'season27_premium');
  assert.ok(helper.storeOffers(root, 'season_store', [], owned).some(x => x.id === skin));
  assert.deepEqual(helper.storeOffers(root, 'season_store', [], {}), []);
});

test('inventory command runs without Python or a DLL and reports no-character errors as JSON', t => {
  const { root, file } = setup(t, { players: {} });
  const out = execFileSync(process.execPath, [path.join(root, 'tools', 'items.js'), 'unlock', 'char-one', 'cosmetics-only'], { encoding: 'utf8' });
  assert.equal(JSON.parse(out).ok, false);
  assert.match(JSON.parse(out).error, /create a character first/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')), { players: {} });
});
