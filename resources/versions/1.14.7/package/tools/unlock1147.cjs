// Dauntless Forever - 1.14.7 inventory unlocks
// SPDX-License-Identifier: AGPL-3.0-only
// Catalog IDs/flags are exported by tools/export-unlock1147.py. No Python or Oodle at runtime.
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const INSTANCED = /^(WP_|AR_|LT_|PART_|BN_|FL_|PLAYER_ROLE_|PR_|ACC_|TOY_|PET_|MINIPET_|AC_HEAD_|AC_BACK_|MP_)/;
const STACKED = /^(CELL_|CURRENCY_|TOKEN_|QI_|DYE_|EM_|EJ_|BNC_|TITLE_|CONTAINER_|FLARE_|TY_)/;
const FIRST_PLAY = 'Press Play for 1.14.7 and create a character first, then close the game and stop hosting.';
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const max = (value, minimum) => Math.max(Number(value) || 0, minimum);

function backendUp() {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: 63000 });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(800, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function wanted(id) {
  return typeof id === 'string' && /^[A-Z0-9_-]{3,80}$/.test(id) && !id.startsWith('GD_FRAME') &&
    id !== 'CURRENCY_NULL_REWARD' && !id.includes('PROTO') &&
    !(id.startsWith('CELL_') && (/UNLOCK/.test(id) || /^CELL_(EFFECT|DP_)/.test(id))) &&
    (INSTANCED.test(id) || STACKED.test(id));
}
function quantity(id) {
  if (/^(CURRENCY_|TOKEN_)/.test(id)) return 99999;
  if (id.startsWith('CELL_')) return 6;
  if (id.startsWith('QI_') && /POTION|PYLON|FLASK/.test(id)) return 999;
  return id.startsWith('CONTAINER_') ? 4 : 1;
}
function item(raw) {
  return typeof raw === 'string' ? [raw, 1] : [raw && (raw.catalogId || raw.catalog_id), Number(raw && raw.quantity) || 1];
}

function loadInputs(root, mode) {
  const catalog = readJson(path.join(root, 'tools', 'unlock-catalog1147.json'));
  if (catalog.version !== '1.14.7' || !Array.isArray(catalog.cosmetics) || !catalog.cosmetics.length ||
      !Array.isArray(catalog.instanced) || !catalog.stacked || !Array.isArray(catalog.talents) ||
      catalog.cosmetics.some(id => !wanted(id) || !Number.isFinite(catalog.stacked[id]) || catalog.stacked[id] < 1 || catalog.instanced.includes(id))) {
    throw new Error('The 1.14.7 unlock catalog is missing or invalid. Update the server files.');
  }
  if (mode === 'cosmetics-only') return { catalog };
  const captures = path.join(root, 'captures', 'DauntlessEndpointDocumentation-main');
  try {
    const config = readJson(path.join(captures, 'Progression', 'Config.json'));
    const paths = config.payload.paths;
    if (!Array.isArray(paths) || !paths.length) throw new Error('No progression paths');
    const text = fs.readFileSync(path.join(captures, 'Progression', 'GetSlayersPath.md'), 'utf8');
    const match = /```json\s*([\s\S]*?)```/.exec(text);
    const nodes = Object.keys(JSON.parse(match[1]).payload.nodes);
    const skuDir = path.join(captures, 'Store', 'Product', 'Skus');
    const offers = fs.readdirSync(skuDir).filter(f => f.endsWith('.json')).flatMap(f => {
      const rows = readJson(path.join(skuDir, f));
      if (!Array.isArray(rows)) throw new Error('Invalid store capture');
      return rows;
    });
    return { catalog, paths, nodes, offers };
  } catch {
    throw new Error('The progression and shop data is missing or damaged. Run Set up for 1.14.7 first.');
  }
}

function gearData(id, current) {
  let old = {};
  try { old = typeof current === 'string' ? JSON.parse(current) : current || {}; } catch {}
  if (!old || typeof old !== 'object' || Array.isArray(old)) old = {};
  const fresh = id.startsWith('FL_') ? { CurrentCount: 999, UnlimitedUse: true } : {
    TransmogCatalogID: 'None', UnlockedAsTransmog: true, CurrentLevel: 20, CurrentXP: 0,
    EquippedCells: [], EquippedCellsv2: [],
    ...(id.startsWith('WP_') ? { EquippedWeaponParts: [], IsPowerSurged: true } : {}),
    ...(/^(AR_|LT_)/.test(id) ? { Primary: 'None', Secondary: 'None', Tertiary: 'None', IsPowerSurged: true } : {}),
  };
  for (const [key, value] of Object.entries(fresh)) {
    if (key === 'CurrentLevel' || key === 'CurrentCount') old[key] = max(old[key], value);
    else if (old[key] == null || old[key] === '' || old[key] === 'None' || old[key] === false ||
        (Array.isArray(old[key]) && !old[key].length)) old[key] = value;
  }
  if (!id.startsWith('FL_')) old.UnlockedAsTransmog = true;
  if (/^(WP_|AR_|LT_)/.test(id)) old.IsPowerSurged = true;
  return JSON.stringify(old);
}

function scrubFrames(node) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.glider === 'string' && node.glider.startsWith('GD_FRAME')) node.glider = '';
  for (const value of Object.values(node)) scrubFrames(value);
}

function mergeProgress(player, paths, nodes, talents) {
  const maps = player.pjmMaps ||= {};
  const main = maps.main ||= { nodes: {}, update_version: 0 };
  main.nodes ||= {};
  for (const id of nodes) main.nodes[id] ||= { node_id: id, objectives: [] };
  for (const [id, node] of Object.entries(main.nodes)) {
    node.node_id = id; node.node_status = 2;
    for (const objective of node.objectives || []) {
      objective.objective_status = 2; objective.objective_amount = max(objective.objective_amount, 10);
    }
  }
  main.update_version = (Number(main.update_version) || 0) + 1;
  const escalation = player.escalation ||= {};
  for (let i = 1; i <= 6; i++) escalation[`ESC_SEASON_${i}`] ||= {};
  for (const [id, season] of Object.entries(escalation)) {
    season.escalation_level = max(season.escalation_level, 50);
    season.next_level_xp ??= 0; season.update_version ??= 1;
    const unlocks = season.unlock_progress ||= [];
    const have = new Set(unlocks.map(x => x.TalentId));
    for (const talent of talents.filter(x => x.includes(`_S${id.split('_').pop()}_`))) {
      if (!have.has(talent)) unlocks.push({ TalentId: talent, Unlocked: true, CurrentRank: 1 });
    }
    season.talents_progress = unlocks;
  }
  const tracks = (player.progress ||= {}).tracks ||= {};
  for (const track of paths) {
    const id = track.progression_id || '';
    if (id.includes('d24_season1')) continue;
    const requirements = track.requirements || [];
    let rank, progress;
    if (id.startsWith('ExperienceTrack_Weapon_')) rank = 20;
    else if (id.startsWith('PrestigeTrack_Weapon_')) { rank = 10; progress = 10; }
    else if (/^(season|eventpass)/.test(id)) rank = Math.max(0, ...requirements.map(x => Number(x.rank_id) || 0));
    else continue;
    progress ??= requirements.filter(x => Number(x.rank_id) <= rank).reduce((n, x) => n + (Number(x.xp_required) || 0), 0) + 1;
    const current = tracks[id] ||= {};
    current.progress = max(current.progress, progress);
    current.confirmed_fremium_rank = max(current.confirmed_fremium_rank, rank);
    current.confirmed_premium_rank = max(current.confirmed_premium_rank, rank);
    current.confirmed_date ||= new Date().toISOString().slice(0, 19);
  }
  player.huntPass ||= 'season27';
}

// Pure save transformation. Only the selected character and its account progression are changed.
function applyUnlock(state, characterId, mode, inputs) {
  if (!['all', 'cosmetics-only'].includes(mode)) throw new Error('Unknown unlock mode.');
  const player = Object.values(state.players || {}).find(p => (p.characters || []).some(c => c && c.id === characterId));
  if (!player) throw new Error(FIRST_PLAY);
  const catalog = inputs.catalog, skins = new Set(catalog.cosmetics);
  const inv = (player.inventory ||= {})[characterId] ||= { instancedItems: [], stackedItems: [] };
  if (!Array.isArray(inv.instancedItems) || !Array.isArray(inv.stackedItems)) throw new Error('The character inventory is damaged. Restore a save backup first.');
  const instanced = new Set(mode === 'all' ? catalog.instanced : []);
  const stacked = mode === 'all' ? { ...catalog.stacked } : Object.fromEntries([...skins].map(id => [id, 1]));
  const entitlements = new Set(['season27_premium']);
  function grant(raw) {
    const [id, count] = item(raw);
    if (!wanted(id)) return;
    if (!skins.has(id) && INSTANCED.test(id) && !id.startsWith('PR_UNLOCK')) instanced.add(id);
    else stacked[id] = Math.max(stacked[id] || 0, quantity(id), count);
  }
  if (mode === 'all') {
    for (const track of inputs.paths) {
      if (track.premium_gating_entitlement) entitlements.add(track.premium_gating_entitlement);
      for (const rank of [...(track.free_rewards || []), ...(track.premium_rewards || [])]) {
        for (const raw of rank.entitlements || []) {
          const name = typeof raw === 'string' ? raw : raw.name;
          if (name) entitlements.add(name);
        }
        for (const raw of [...(rank.instanced_items || []), ...(rank.stacked_items || [])]) grant(raw);
      }
    }
    for (const offer of inputs.offers) for (const raw of (offer && offer.items) || []) grant(raw);
  }
  const piles = new Map(inv.stackedItems.filter(Boolean).map(x => [x.catalogId, x]));
  let addedStacks = 0, addedGear = 0;
  for (const [id, count] of Object.entries(stacked)) {
    if (piles.has(id)) piles.get(id).quantity = max(piles.get(id).quantity, count);
    else { const row = { catalogId: id, quantity: count }; inv.stackedItems.push(row); piles.set(id, row); addedStacks++; }
  }
  const removedCosmeticInstances = inv.instancedItems.filter(x => x && skins.has(x.catalogId)).length;
  inv.instancedItems = inv.instancedItems.filter(x => x && !skins.has(x.catalogId));
  if (mode === 'all') {
    // Preserve the original unlocker's exclusion: these frames break the 1.14.7 glider slot.
    inv.instancedItems = inv.instancedItems.filter(x => !String(x.catalogId).startsWith('GD_FRAME'));
    inv.stackedItems = inv.stackedItems.filter(x => x && !String(x.catalogId).startsWith('GD_FRAME'));
    scrubFrames((player.loadouts || {})[characterId]);
    const have = new Map(inv.instancedItems.map(x => [x.catalogId, x]));
    for (const id of instanced) {
      if (skins.has(id)) continue;
      let row = have.get(id);
      if (!row) { row = { catalogId: id, instanceId: id, updateVersion: 1, itemData: null }; inv.instancedItems.push(row); have.set(id, row); addedGear++; }
      if (/^(WP_|AR_|LT_|FL_)/.test(id)) row.itemData = gearData(id, row.itemData);
    }
    const owned = new Set((player.entitlements ||= []).map(x => x && x.name));
    for (const name of entitlements) if (!owned.has(name)) player.entitlements.push({ activatedDate: null, duration: 0, name });
    mergeProgress(player, inputs.paths, inputs.nodes, catalog.talents);
    player.unlockEverything1147 = true;
  }
  return { mode, cosmetics: skins.size, addedGear, addedStacks, removedCosmeticInstances };
}

async function unlock(root, characterId, mode, isBackendUp = backendUp) {
  if (!['all', 'cosmetics-only'].includes(mode)) throw new Error('Unknown unlock mode.');
  if (await isBackendUp()) throw new Error('Close the game and stop hosting before unlocking items.');
  const file = path.join(root, 'data', 'state.json');
  if (!fs.existsSync(file)) throw new Error(FIRST_PLAY);
  const lock = path.join(root, 'data', 'inventory-unlock.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch (e) {
    if (e.code === 'EEXIST') throw new Error('An inventory unlock is already running. If it was interrupted, close the launcher and remove data/inventory-unlock.lock.');
    throw e;
  }
  let tmp;
  try {
    const original = fs.readFileSync(file);
    const state = JSON.parse(original.toString('utf8').replace(/^\uFEFF/, ''));
    // Check the character before loading optional setup data, and never create a character here.
    if (!Object.values(state.players || {}).some(p => (p.characters || []).some(c => c && c.id === characterId))) throw new Error(FIRST_PLAY);
    const result = applyUnlock(state, characterId, mode, loadInputs(root, mode));
    if (await isBackendUp() || !fs.readFileSync(file).equals(original)) throw new Error('The game started or the save changed. Close the game and try again.');
    const backup = path.join('backup', 'inventory', `state-unlock-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.mkdirSync(path.join(root, 'backup', 'inventory'), { recursive: true });
    fs.writeFileSync(path.join(root, backup), original, { flag: 'wx' });
    tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { flag: 'wx' });
    fs.renameSync(tmp, file); tmp = null;
    return { ok: true, ...result, backup };
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
    fs.closeSync(fd); fs.unlinkSync(lock);
  }
}

// Store ownership is scoped to the account that ran the full unlock. No runtime source patching.
function storeOffers(root, tag, offers, player) {
  if (!player.unlockEverything1147) return Array.isArray(offers) ? offers : [];
  let rows = Array.isArray(offers) ? offers : [];
  if (!rows.length) {
    const make = (id, items, tags, entitlements = []) => ({
      availableFrom: null, availableTo: null, displayDescription: id, displayName: id, displayPriority: 1,
      duplicateInstancedItems: null, entitlements, id, images: {}, items, loadoutSlots: null, maxAllowed: 1,
      missingEntitlementNames: null, platformOfferId: null, prices: [], remaining: 0, scheduledTags: null,
      skuProgression: null, tags, timeAvailabilityReason: null,
    });
    if (tag === 'season_store') {
      const { payload } = readJson(path.join(root, 'captures', 'DauntlessEndpointDocumentation-main', 'Progression', 'Config.json'));
      const ids = new Map();
      for (const track of payload.paths || []) if (/^(season|eventpass)/.test(track.progression_id || '')) {
        for (const rank of [...(track.free_rewards || []), ...(track.premium_rewards || [])]) {
          for (const raw of [...(rank.stacked_items || []), ...(rank.instanced_items || [])]) {
            const [id, count] = item(raw);
            if (wanted(id) && !/^(CURRENCY_|TOKEN_|CELL_)/.test(id)) ids.set(id, count);
          }
        }
      }
      rows = [...ids].map(([id, count]) => make(id, [{ catalogId: id, quantity: count }], [tag]));
    } else if (tag === 'season27_pass') rows = [make('season27_premium', null, [tag], [{ duration: 0, name: 'season27_premium' }])];
    else if (['fountain_daily_free_bundle', 'vip_boost'].includes(tag)) rows = [make(tag, null, [tag])];
  }
  return rows.map(offer => ({ ...offer, remaining: 0, missingEntitlementNames: null }));
}

module.exports = { unlock, applyUnlock, loadInputs, storeOffers, backendUp, FIRST_PLAY };
