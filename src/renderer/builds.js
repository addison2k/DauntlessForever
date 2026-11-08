// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// builds.js (renderer) - the Builds page: a loadout of real gear (weapon, four armour pieces, lantern, omnicell, cells)
// with the perks it adds up to, drawn from the game's own gear data (builds-data-*.js) and the game's own icons
// (build-icons/). Saved builds live in the launcher's data folder (main/builds.js); the inventory is read, never written.
'use strict';
(function () {
  const L = window.launcher; if (!L || !L.buildsLocal) return;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const DATA = window.DFBuildsData || {};
  const SLOTS = ['weapon', 'bond', 'part', 'part2', 'part3', 'head', 'chest', 'arms', 'legs', 'lantern', 'omnicell'];
  const SLOT_NAME = { weapon: 'Weapon', bond: 'Bonded weapon', part: 'Special', part2: 'Mod', part3: 'Mod', head: 'Head', chest: 'Chest', arms: 'Arms', legs: 'Legs', lantern: 'Lantern', omnicell: 'Omnicell' };
  const PART_SLOTS = ['part', 'part2', 'part3'];
  // which part fits which slot: melee weapons take a Special and a Mod; repeaters a Chamber, a Grip and a Mod (barrels and prisms are cosmetic and stay out)
  function partCat(p) { const t = p.partType || '', n = ' ' + p.name; if (/_Special$/.test(t)) return 'part'; if (/_Passive$/.test(t)) return 'part2'; if (/DP_Mod$/.test(t)) return 'part3'; if (/ Chamber$/.test(n)) return 'part'; if (/ Grip$/.test(n)) return 'part2'; return ''; }
  function partLabel(key, w) { const rep = w && w.kind === 'repeaters'; return key === 'part' ? (rep ? 'Chamber' : 'Special') : key === 'part2' ? (rep ? 'Grip' : 'Mod') : 'Mod'; }
  const WEAPON_KINDS = { sword: 'Sword', hammer: 'Hammer', axe: 'Axe', chainblades: 'Chain Blades', pike: 'War Pike', strikers: 'Aether Strikers', repeaters: 'Repeaters', bow: 'Bow' };
  const ELEMENTS = ['Blaze', 'Frost', 'Shock', 'Terra', 'Radiant', 'Umbral', 'Neutral'];
  const CELL_TYPES = ['Power', 'Technique', 'Mobility', 'Defence', 'Utility'];
  const GENERIC = { weapon: 'ico_equip_Weapon_NoIcon', head: 'ico_armour_generic', chest: 'ico_armour_generic', arms: 'ico_armour_generic', legs: 'ico_armour_generic', lantern: 'ico_lantern_simple', omnicell: 'icon_omnicell_generic', part: 'ico_equip_Weapon_NoIcon' };
  const S = { ver: '1.14.7', data: null, byId: new Map(), cells: new Map(), characters: [], owned: null, saved: [], tab: 'editor', picker: null, note: '' };
  let editor = blank('1.14.7'), loaded = false;

  function blank(ver) { return { id: '', name: '', notes: '', version: ver, slots: Object.fromEntries(SLOTS.map(k => [k, ''])), cells: {}, locks: [] }; }
  function note(s, err) { const n = $('build-message'); n.textContent = s || ''; n.classList.toggle('err', !!err); }
  function item(id) { return S.byId.get(id) || null; }
  function cell(id) { return S.cells.get(id) || null; }
  function iconUrl(it, kind) { const name = (it && it.icon) || GENERIC[kind] || 'ico_equip_Weapon_NoIcon'; return 'build-icons/' + name + '.png'; }
  function kindOfSlot(key) { return key === 'weapon' || key === 'bond' ? Object.keys(WEAPON_KINDS) : PART_SLOTS.includes(key) ? ['part'] : [key]; }
  function owned(it) {
    if (!it || !S.owned) return null;
    if (S.owned.gear.has(it.id)) return true;
    if (Number(S.owned.items[it.id]) > 0) return true;
    return false;
  }
  function ownedCell(c) { if (!c || !S.owned) return null; if (Number(S.owned.items[c.id]) > 0 || S.owned.gear.has(c.id)) return true; return S.owned.cellsKnown ? false : null; }
  function cellRanks(c) { const m = /^\+(\d)/.exec(c.name || ''); return m ? Number(m[1]) : 1; }
  function cellPerk(c) { return (c.perkName || c.name || '').replace(/^\+\d\s*/, '').replace(/\s*Cell$/i, ''); }
  function perkType(name) { const p = (S.data.perks || []).find(x => x.name === name); return p ? p.type : ''; }

  // ------------------------------------------------------------------ data + inventory
  function loadData(ver) {
    S.ver = ver; S.data = DATA[ver] || { items: [], cells: [], perks: [] };
    S.data = { ...S.data, cells: S.data.cells.filter(c => !/^\+[12]\s/.test(c.name)) };   // rank 3 only: nobody builds with +1 and +2 cells
    S.byId = new Map(S.data.items.map(i => [i.id, i])); S.cells = new Map(S.data.cells.map(c => [c.id, c]));
  }
  async function readInventory() {
    S.owned = null; S.characters = [];
    try {
      const r = await L.items(S.ver);
      S.characters = (r && r.save && r.save.ok && r.save.characters) || [];
    } catch { S.characters = []; }
    const sel = $('build-character'); const prev = sel.value; sel.replaceChildren();
    sel.add(new Option('No character (nothing marked)', 'none'));
    for (const c of S.characters) sel.add(new Option(c.name || c.id, c.id));
    sel.value = S.characters.some(c => c.id === prev) ? prev : (S.characters[0] ? S.characters[0].id : 'none');
    pickCharacter();
  }
  function pickCharacter() {
    const c = S.characters.find(x => x.id === $('build-character').value);
    S.owned = c ? { items: c.items || {}, gear: new Set((c.gear || []).map(g => g.id)), cellsKnown: Object.keys(c.items || {}).some(k => /^CELL/i.test(k)) } : null;
    render();
  }

  // ------------------------------------------------------------------ the loadout
  function totals() {
    const perks = new Map(); let ownedN = 0, missingN = 0, unknownN = 0; const uniques = [];
    for (const key of SLOTS) {
      const it = item(editor.slots[key]); if (!it) continue;
      const o = owned(it); if (o === true) ownedN++; else if (o === false) missingN++; else unknownN++;
      for (const p of it.perks || []) { const t = perks.get(p.name) || { ranks: 0, type: p.type }; t.ranks += p.ranks; perks.set(p.name, t); }
      for (const u of it.unique || []) if (u.text) uniques.push({ from: it.name, text: u.text });
      for (const cid of editor.cells[key] || []) { const c = cell(cid); if (!c) continue; const n = cellPerk(c); const t = perks.get(n) || { ranks: 0, type: c.type || perkType(n) }; t.ranks += cellRanks(c); perks.set(n, t); }
    }
    return { perks: [...perks.entries()].sort((a, b) => b[1].ranks - a[1].ranks || a[0].localeCompare(b[0])), ownedN, missingN, unknownN, uniques };
  }
  function card(key) {
    const it = item(editor.slots[key]); const kind = it ? it.kind : (key === 'bond' ? 'weapon' : PART_SLOTS.includes(key) ? 'part' : key);
    const wpn = item(editor.slots.weapon);
    const c = el('div', 'bld-card' + (it ? '' : ' empty') + (editor.locks.includes(key) ? ' locked' : ''));
    const head = el('div', 'bld-card-head');
    const img = el('img', 'bld-icon'); img.src = iconUrl(it, kind); img.alt = ''; img.loading = 'lazy'; img.onerror = () => { img.onerror = null; img.src = iconUrl(null, kind); }; head.append(img);
    const txt = el('div', 'bld-card-text');
    txt.append(el('div', 'bld-slot', PART_SLOTS.includes(key) ? partLabel(key, wpn) : SLOT_NAME[key]));
    const noBond = key === 'bond' && !it && !(wpn && wpn.rarity === 'Epic');   // only a legendary weapon (rarity Epic in the catalog) takes a bond
    txt.append(el('div', 'bld-name', it ? it.name : noBond ? (wpn ? 'Not legendary' : 'Legendary only') : 'Choose'));
    if (noBond) c.classList.add('nobond');
    const meta = el('div', 'bld-meta');
    if (it && key === 'weapon') meta.append(el('span', 'bld-beh', WEAPON_KINDS[it.kind] || ''));
    if (it && PART_SLOTS.includes(key) && it.weapon) meta.append(el('span', 'bld-beh', WEAPON_KINDS[it.weapon] || ''));
    if (it && key === 'bond') meta.append(el('span', 'bld-beh', 'bonded: its perk and effect count'));
    if (it && it.element) meta.append(el('span', 'bld-el el-' + it.element.toLowerCase(), it.element));
    if (it && it.behemoth) meta.append(el('span', 'bld-beh', it.behemoth));
    if (it) { const o = owned(it); meta.append(el('span', 'bld-own ' + (o === true ? 'yes' : o === false ? 'no' : 'unk'), o === true ? 'owned' : o === false ? 'not owned' : 'not checked')); }
    txt.append(meta); head.append(txt);
    const acts = el('div', 'bld-acts');
    const lock = el('button', 'bld-lock', editor.locks.includes(key) ? 'Locked' : 'Lock'); lock.type = 'button'; lock.title = 'A locked slot is left alone by Fill';
    lock.onclick = (e) => { e.stopPropagation(); const i = editor.locks.indexOf(key); if (i >= 0) editor.locks.splice(i, 1); else editor.locks.push(key); render(); };
    acts.append(lock);
    if (it) { const x = el('button', 'bld-x', 'Remove'); x.type = 'button'; x.onclick = (e) => { e.stopPropagation(); editor.slots[key] = ''; editor.cells[key] = []; render(); }; acts.append(x); }
    head.append(acts);
    head.onclick = () => openPicker(key);
    c.append(head);
    if (it && (it.perks || []).length) { const row = el('div', 'bld-perks'); for (const p of it.perks) row.append(el('span', 'bld-perk pt-' + (p.type || '').toLowerCase(), '+' + p.ranks + ' ' + p.name)); c.append(row); }
    if (it && (it.unique || []).length) c.append(el('div', 'bld-unique', it.unique.map(u => u.text).join(' ')));
    if (it && key !== 'bond' && (it.slots || []).length) {   // a bonded weapon lends its perk and effect, not its cell slots
      const row = el('div', 'bld-cells'); const chosen = editor.cells[key] || [];
      it.slots.forEach((type, i) => {
        const cc = cell(chosen[i]); const b = el('button', 'bld-cellslot' + (cc ? ' on' : '') + ' ct-' + type.toLowerCase()); b.type = 'button';
        const ci = el('img'); ci.src = 'build-icons/' + (cc ? (cc.icon || 'ico_cell_filled') : 'ico_cell_' + (type === 'Defence' ? 'defense' : type === 'Any' ? 'power' : type.toLowerCase()) + '_empty') + '.png'; ci.alt = '';
        b.append(ci, el('span', '', cc ? cc.name : type + ' cell'));
        b.onclick = (e) => { e.stopPropagation(); openCellPicker(key, i, type); };
        row.append(b);
      });
      c.append(row);
    }
    return c;
  }
  function renderLoadout() {
    const w = $('build-col-weapon'), a = $('build-col-armour'), s = $('build-summary'); w.replaceChildren(); a.replaceChildren(); s.replaceChildren();
    const wpn = item(editor.slots.weapon); const rep = !!(wpn && wpn.kind === 'repeaters');
    for (const k of ['weapon', 'bond', 'part', 'part2'].concat(rep ? ['part3'] : []).concat(['lantern', 'omnicell'])) w.append(card(k));
    for (const k of ['head', 'chest', 'arms', 'legs']) a.append(card(k));
    const t = totals();
    s.append(el('h2', 'bld-h2', 'Perks'));
    if (!t.perks.length) s.append(el('p', 'small', 'Pick gear and cells; the perks add up here.'));
    for (const [name, v] of t.perks) {
      const row = el('div', 'bld-total pt-' + (v.type || perkType(name) || '').toLowerCase());
      row.append(el('span', 'bld-total-n', '+' + v.ranks), el('span', 'bld-total-name', name));
      const bar = el('div', 'bld-bar'); for (let i = 0; i < 6; i++) bar.append(el('i', i < v.ranks ? 'on' : '')); row.append(bar);
      if (v.ranks > 6) row.append(el('span', 'bld-over', 'over 6'));
      s.append(row);
    }
    const inv = el('p', 'small bld-inv'); inv.textContent = S.owned ? 'This character: ' + t.ownedN + ' owned, ' + t.missingN + ' not owned' + (t.unknownN ? ', ' + t.unknownN + ' not checked' : '') : 'Pick a character to see what is owned.'; s.append(inv);
    if (t.uniques.length) { s.append(el('h2', 'bld-h2', 'Unique effects')); for (const u of t.uniques) { const p = el('p', 'bld-ueff'); p.append(el('b', '', u.from + ': '), u.text); s.append(p); } }
  }

  // ------------------------------------------------------------------ pickers
  function openPicker(key) {
    const kinds = kindOfSlot(key); let list = S.data.items.filter(i => kinds.includes(i.kind));
    const w = item(editor.slots.weapon);
    if (PART_SLOTS.includes(key)) list = list.filter(p => !p.tracker && partCat(p) === key && (!w || !p.weapon || p.weapon === w.kind));   // parts of the equipped weapon's type, for this slot; trackers, barrels and prisms stay out
    if (key === 'bond') { if (!w || w.rarity !== 'Epic') { note('Only a legendary weapon takes a bonded weapon.'); return; } list = list.filter(x => x.kind === w.kind && x.id !== w.id && x.rarity !== 'Epic'); }   // a bonded weapon is a non-legendary weapon of the same type
    showPicker(PART_SLOTS.includes(key) ? partLabel(key, w) : SLOT_NAME[key], list, (it) => { editor.slots[key] = it ? it.id : ''; editor.cells[key] = []; if (key === 'weapon') { for (const pk of PART_SLOTS) { const p = item(editor.slots[pk]); if (p && p.weapon && (!it || p.weapon !== it.kind)) editor.slots[pk] = ''; } const bd = item(editor.slots.bond); if (bd && (!it || bd.kind !== it.kind)) editor.slots.bond = ''; } closePicker(); render(); }, { gear: true, key });
  }
  function openCellPicker(key, index, type) {
    const list = S.data.cells.filter(c => type === 'Any' || !c.type || c.type === type);
    showPicker((type === 'Any' ? 'Any' : type) + ' cell', list, (c) => { const arr = editor.cells[key] = editor.cells[key] || []; arr[index] = c ? c.id : ''; closePicker(); render(); }, { gear: false, key });
  }
  function showPicker(title, list, onPick, opts) {
    S.picker = { title, list, onPick, opts, q: '', kind: '' }; $('build-picker').hidden = false; $('build-picker-title').textContent = title; $('build-picker-search').value = '';
    const kf = $('build-picker-kind'); kf.hidden = !(opts.gear && opts.key === 'weapon'); kf.replaceChildren(); if (!kf.hidden) { kf.add(new Option('Every weapon type', '')); for (const [k, n] of Object.entries(WEAPON_KINDS)) if (list.some(i => i.kind === k)) kf.add(new Option(n, k)); }
    drawPicker(); $('build-picker-search').focus();
  }
  function closePicker() { S.picker = null; $('build-picker').hidden = true; }
  function drawPicker() {
    const p = S.picker; if (!p) return; const box = $('build-picker-list'); box.replaceChildren();
    const q = $('build-picker-search').value.trim().toLowerCase(); const kind = $('build-picker-kind').hidden ? '' : $('build-picker-kind').value;
    let list = p.list.filter(x => (!kind || x.kind === kind) && (!q || (x.name + ' ' + x.id + ' ' + (x.behemoth || '') + ' ' + (x.element || '') + ' ' + (x.perks || []).map(pp => pp.name).join(' ')).toLowerCase().includes(q)));
    const rank = (x) => { const o = p.opts.gear ? owned(x) : ownedCell(x); return o === true ? 0 : o === null ? 1 : 2; };
    list = list.sort((a, b) => rank(a) - rank(b) || (b.tier || 0) - (a.tier || 0) || a.name.localeCompare(b.name)).slice(0, 400);
    const none = el('button', 'bld-row bld-row-none'); none.type = 'button'; none.textContent = 'Leave empty'; none.onclick = () => p.onPick(null); box.append(none);
    for (const x of list) {
      const row = el('button', 'bld-row'); row.type = 'button';
      const img = el('img'); img.src = p.opts.gear ? iconUrl(x, x.kind) : 'build-icons/' + (x.icon || 'ico_cell_filled') + '.png'; img.alt = ''; img.loading = 'lazy'; img.onerror = () => { img.onerror = null; img.src = iconUrl(null, p.opts.gear ? x.kind : 'omnicell'); }; row.append(img);
      const t = el('div', 'bld-row-text'); t.append(el('div', 'bld-row-name', x.name));
      const m = el('div', 'bld-row-meta');
      if (x.element) m.append(el('span', 'bld-el el-' + x.element.toLowerCase(), x.element));
      if (x.behemoth) m.append(el('span', 'bld-beh', x.behemoth));
      if (x.type && !p.opts.gear) m.append(el('span', 'bld-perk pt-' + x.type.toLowerCase(), x.type));
      for (const pp of (x.perks || [])) m.append(el('span', 'bld-perk pt-' + (pp.type || '').toLowerCase(), '+' + pp.ranks + ' ' + pp.name));
      if (x.desc && !p.opts.gear) m.append(el('span', 'bld-desc', x.desc));
      t.append(m); row.append(t);
      const o = p.opts.gear ? owned(x) : ownedCell(x); row.append(el('span', 'bld-own ' + (o === true ? 'yes' : o === false ? 'no' : 'unk'), o === true ? 'owned' : o === false ? 'not owned' : ''));
      row.onclick = () => p.onPick(x); box.append(row);
    }
    if (!list.length) box.append(el('p', 'small', 'Nothing matches.'));
  }

  // ------------------------------------------------------------------ fill
  function fill() {
    const elq = $('build-fill-element').value, wk = $('build-fill-weapon').value, allowMissing = $('build-allow-missing').checked; let n = 0;
    for (const key of SLOTS) {
      if (editor.slots[key] || editor.locks.includes(key) || key === 'bond') continue;
      const kinds = key === 'weapon' ? (wk ? [wk] : Object.keys(WEAPON_KINDS)) : [key];
      const elemental = key === 'weapon' || ['head', 'chest', 'arms', 'legs'].includes(key);
      const w = item(editor.slots.weapon);
      if (key === 'part3' && !(w && w.kind === 'repeaters')) continue;
      let cands = S.data.items.filter(i => kinds.includes(i.kind) && (!elq || !elemental || i.element === elq) && (!PART_SLOTS.includes(key) || (!i.tracker && w && i.weapon === w.kind && partCat(i) === key)));
      const own = cands.filter(i => owned(i) === true);
      if (own.length) cands = own; else if (!allowMissing && S.owned) continue;
      cands.sort((a, b) => (b.tier || 0) - (a.tier || 0) || (b.perks || []).length - (a.perks || []).length || a.name.localeCompare(b.name));
      if (cands[0]) { editor.slots[key] = cands[0].id; editor.cells[key] = []; n++; }
    }
    $('build-fill-note').textContent = n ? n + ' slot(s) filled from ' + (S.owned ? 'what this character owns' : 'the catalog') + '. Cells are left for you to pick.' : 'Nothing to fill: every open slot is locked, taken, or nothing owned matches (tick "allow gear this character does not own").';
    render();
  }

  // ------------------------------------------------------------------ save, share, my builds
  function snapshot() { editor.name = $('build-name').value.trim().slice(0, 90); editor.notes = $('build-notes').value.trim().slice(0, 280); editor.version = S.ver; return editor; }
  async function save() {
    snapshot(); if (!editor.name) { note('Give the build a name first.', true); $('build-name').focus(); return; }
    const r = await L.buildsLocal('put', editor); if (!r || !r.ok) return note((r && r.error) || 'Could not save.', true);
    S.saved = r.builds || []; const mine = S.saved.find(b => b.name === editor.name && b.version === editor.version); if (mine) editor.id = mine.id;
    note('Saved "' + editor.name + '".');
  }
  function shareCode(b) { return 'DFB2.' + btoa(unescape(encodeURIComponent(JSON.stringify({ format: 'dauntless-forever-build-v2', build: { name: b.name, notes: b.notes, version: b.version, slots: b.slots, cells: b.cells } })))); }
  function parseCode(text) {
    text = String(text || '').trim();
    try {
      if (text.startsWith('DFB2.')) { const j = JSON.parse(decodeURIComponent(escape(atob(text.slice(5))))); return j && j.build ? j.build : null; }
      const j = JSON.parse(text); const b = j && j.build ? j.build : j;   // the v1 share (the first Builds page) is plain JSON
      if (b && b.slots) { if (Array.isArray(b.cells)) { b.cells = { weapon: b.cells.slice(0, 2), head: [b.cells[2]], chest: [b.cells[3]], arms: [b.cells[4]], legs: [b.cells[5]] }; } return b; }
    } catch {}
    return null;
  }
  // ------------------------------------------------------------------ DF-BUILDS-IMPORT: a reforged.dauntless-builder.com link
  // The site packs a build into its URL as a Sqids id: 25 numbers (format version, flags, weapon, surged, 2 weapon cells,
  // 3 parts, bond weapon, then name/surged/cell for head, torso, arms, legs, lantern + cell, omnicell), each number an
  // index into the site's name tables (builds-dbnames.js). Those names are matched to our items by name.
  const DB_ALPHABETS = ['h1tiFLYU5eO6rSEfg_JdlVHvMz0NToujK9-ncwXp7P24axkRWsAG3bBImyD8CZQq', 'MNWboUQG19y_Oja2ZEh4liLfst053FTCkpBVrw~Ix.7dJDnmugeKYS6-vcR8zqHAPX'];
  function sqShuffle(s) { const a = s.split(''); for (let i = 0, j = a.length - 1; j > 0; i++, j--) { const r = (i * j + a[i].codePointAt(0) + a[j].codePointAt(0)) % a.length; [a[i], a[r]] = [a[r], a[i]]; } return a.join(''); }
  function sqDecode(id, alphabetIn) {
    const alphabet = sqShuffle(alphabetIn); const out = []; if (!id) return out;
    for (const c of id) if (!alphabet.includes(c)) return out;
    const off = alphabet.indexOf(id[0]); let alpha = (alphabet.slice(off) + alphabet.slice(0, off)).split('').reverse().join('');
    let rest = id.slice(1);
    while (rest.length) { const sep = alpha[0]; const chunks = rest.split(sep); if (chunks[0] === '') return out; const digits = alpha.slice(1); out.push(chunks[0].split('').reduce((n, ch) => n * digits.length + digits.indexOf(ch), 0)); if (chunks.length > 1) alpha = sqShuffle(alpha); rest = chunks.slice(1).join(sep); }
    return out;
  }
  const DIACRITICS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g'), CURLY = new RegExp('[' + String.fromCharCode(0x2018) + String.fromCharCode(0x2019) + ']', 'g');
  const normName = (s) => String(s || '').normalize('NFKD').replace(DIACRITICS, '').replace(CURLY, "'").toLowerCase().replace(/[^a-z0-9+ ']/g, '').trim();
  function fromDauntlessBuilder(text) {
    const m = /\/b\/([A-Za-z0-9_.\-~]{40,})/.exec(String(text || '')) || /^([A-Za-z0-9_.\-~]{40,})$/.exec(String(text || '').trim());
    if (!m) return null;
    const names = window.DFBuilderNames; if (!names) return { error: 'The dauntless-builder name tables are not loaded.' };
    let nums = []; for (const a of DB_ALPHABETS) { nums = sqDecode(m[1], a); if (nums.length >= 25 && nums[0] >= 7 && nums[0] <= 9) break; nums = []; }
    if (nums.length < 25) return { error: 'That link is an older dauntless-builder build the launcher cannot read yet. Open it on the site, press Share there and paste the new link.' };
    const data = DATA['1.14.7']; if (!data) return { error: 'No 1.14.7 data.' };
    const byName = new Map(); for (const i of data.items) byName.set(normName(i.name) + '|' + (WEAPON_KINDS[i.kind] ? 'weapon' : i.kind), i);
    const cellsByName = new Map(); for (const c of data.cells) cellsByName.set(normName(c.name), c);
    const tbl = (t, n) => (n && names[t] && names[t][String(n)]) || '';
    const missing = [];
    const pick = (t, n, kind) => { const nm = tbl(t, n); if (!nm) return ''; const it = byName.get(normName(nm) + '|' + kind); if (!it) { missing.push(nm); return ''; } return it.id; };
    const pickCell = (n) => { const nm = tbl('Cells', n); if (!nm) return ''; const c = cellsByName.get(normName(nm).replace(/^\+[12] /, '+3 ')); if (!c) { missing.push(nm); return ''; } return c.id; };
    const b = blank('1.14.7');
    b.slots.weapon = pick('Weapons', nums[2], 'weapon');
    const w = data.items.find(i => i.id === b.slots.weapon);
    b.cells.weapon = [pickCell(nums[4]), pickCell(nums[5])];
    if (w) {   // parts: the site stores special/chamber, mod/grip, mod; we keep one part, the first that exists for this weapon
      const PT = { sword: 'Parts:Sword', hammer: 'Parts:Hammer', axe: 'Parts:Axe', chainblades: 'Parts:Chainblades', pike: 'Parts:Warpike', strikers: 'Parts:Aetherstrikers', repeaters: 'Parts:Repeater' }[w.kind];
      [[nums[6], 'part'], [nums[7], 'part2'], [nums[8], 'part3']].forEach(([n, slot]) => { const nm = tbl(PT, n); if (!nm || nm === 'REMOVED') return; const p = data.items.find(i => i.kind === 'part' && i.weapon === w.kind && normName(i.name) === normName(nm)); if (p) b.slots[partCat(p) || slot] = p.id; else missing.push(nm); });
      if (nums[9]) { const bond = pick('Weapons', nums[9], 'weapon'); const bw = data.items.find(i => i.id === bond); if (bw && bw.kind === w.kind) b.slots.bond = bond; }
    }
    b.slots.head = pick('Armours', nums[10], 'head'); b.cells.head = [pickCell(nums[12])];
    b.slots.chest = pick('Armours', nums[13], 'chest'); b.cells.chest = [pickCell(nums[15])];
    b.slots.arms = pick('Armours', nums[16], 'arms'); b.cells.arms = [pickCell(nums[18])];
    b.slots.legs = pick('Armours', nums[19], 'legs'); b.cells.legs = [pickCell(nums[21])];
    b.slots.lantern = pick('Lanterns', nums[22], 'lantern'); b.cells.lantern = [pickCell(nums[23])];
    b.slots.omnicell = pick('Omnicells', nums[24], 'omnicell');
    b.name = 'From dauntless-builder' + (w ? ': ' + w.name : '');
    return { build: b, missing: [...new Set(missing)] };
  }
  async function copyText(s) { try { await navigator.clipboard.writeText(s); return true; } catch { return false; } }
  async function loadSaved() { try { const r = await L.buildsLocal('list'); S.saved = (r && r.builds) || []; } catch { S.saved = []; } }
  function renderMine() {
    const box = $('build-mine-list'); box.replaceChildren();
    const list = [...S.saved].sort((a, b) => (b.likes || 0) - (a.likes || 0) || (b.createdAt || 0) - (a.createdAt || 0));
    if (!list.length) box.append(el('p', 'small', 'No saved builds yet. Make one on the Builder tab and press Save build.'));
    for (const b of list) {
      const row = el('div', 'bld-saved');
      const t = el('div', 'bld-saved-text'); t.append(el('div', 'bld-row-name', b.name + '  (' + b.version + ')'));
      const pieces = SLOTS.map(k => b.slots && b.slots[k]).filter(Boolean).map(id => (DATA[b.version] && (DATA[b.version].items.find(i => i.id === id) || {}).name) || id);
      t.append(el('div', 'small', pieces.join(', ') || 'empty')); if (b.notes) t.append(el('div', 'small', b.notes)); row.append(t);
      const acts = el('div', 'bld-saved-acts');
      const like = el('button', 'ghost hm-small' + (b.likes ? ' on' : ''), b.likes ? 'Liked' : 'Like'); like.onclick = async () => { const r = await L.buildsLocal('like', b.id); if (r && r.ok) { S.saved = r.builds; renderMine(); } };
      const load = el('button', 'primary-sm', 'Open'); load.onclick = () => { editor = { ...blank(b.version), ...JSON.parse(JSON.stringify(b)) }; editor.cells = editor.cells && !Array.isArray(editor.cells) ? editor.cells : {}; if (b.version !== S.ver) { $('build-version').value = b.version; switchVersion(true); } showTab('editor'); };
      const code = el('button', 'ghost hm-small', 'Copy code'); code.onclick = async () => { note((await copyText(shareCode(b))) ? 'Share code copied.' : 'Could not copy.', false); };
      const del = el('button', 'ghost hm-small danger', 'Delete'); del.onclick = async () => { if (!confirm('Delete "' + b.name + '"?')) return; const r = await L.buildsLocal('delete', b.id); if (r && r.ok) { S.saved = r.builds; renderMine(); } };
      acts.append(like, load, code, del); row.append(acts); box.append(row);
    }
  }
  function renderCatalog() {
    const box = $('build-catalog-list'); box.replaceChildren();
    const q = $('build-catalog-search').value.trim().toLowerCase(), kind = $('build-catalog-kind').value, onlyOwned = $('build-catalog-owned').checked;
    let list = S.data.items.filter(i => !i.tracker && (!kind || i.kind === kind || (kind === 'weapon' && WEAPON_KINDS[i.kind])) && (!q || (i.name + ' ' + i.id + ' ' + (i.behemoth || '') + ' ' + (i.element || '')).toLowerCase().includes(q)) && (!onlyOwned || owned(i) === true));
    list = list.slice(0, 300);
    for (const x of list) {
      const row = el('div', 'bld-row static');
      const img = el('img'); img.src = iconUrl(x, x.kind); img.alt = ''; img.loading = 'lazy'; img.onerror = () => { img.onerror = null; img.src = iconUrl(null, x.kind); }; row.append(img);
      const t = el('div', 'bld-row-text'); t.append(el('div', 'bld-row-name', x.name)); const m = el('div', 'bld-row-meta');
      m.append(el('span', 'bld-beh', (WEAPON_KINDS[x.kind] || SLOT_NAME[x.kind] || x.kind) + (x.behemoth ? ' - ' + x.behemoth : '')));
      if (x.element) m.append(el('span', 'bld-el el-' + x.element.toLowerCase(), x.element));
      for (const pp of (x.perks || [])) m.append(el('span', 'bld-perk pt-' + (pp.type || '').toLowerCase(), '+' + pp.ranks + ' ' + pp.name));
      if (x.slots && x.slots.length) m.append(el('span', 'bld-desc', 'cells: ' + x.slots.join(', ')));
      if (x.kind === 'part') m.append(el('span', 'bld-desc', { part: 'special / chamber', part2: 'mod / grip', part3: 'repeater mod' }[partCat(x)] || 'cosmetic part'));
      t.append(m); row.append(t);
      const o = owned(x); row.append(el('span', 'bld-own ' + (o === true ? 'yes' : o === false ? 'no' : 'unk'), o === true ? 'owned' : o === false ? 'not owned' : ''));
      box.append(row);
    }
    $('build-catalog-count').textContent = list.length + ' shown';
  }

  // ------------------------------------------------------------------ page plumbing
  function render() {
    const sc = document.querySelector('.content'); const top = sc ? sc.scrollTop : 0;
    $('build-name').value = editor.name || ''; $('build-notes').value = editor.notes || '';
    if (S.tab === 'editor') renderLoadout(); else if (S.tab === 'mine') renderMine(); else renderCatalog();
    const n = $('build-data-note'); n.hidden = !(S.data && S.data.note); n.textContent = (S.data && S.data.note) || '';
    if (sc) sc.scrollTop = top;
  }
  function showTab(tab) { S.tab = tab; for (const k of ['editor', 'catalog', 'mine']) { $('build-panel-' + k).hidden = k !== tab; $('build-tab-' + k).classList.toggle('is-active', k === tab); } closePicker(); render(); }
  async function switchVersion(keepEditor) {
    loadData($('build-version').value); if (!keepEditor) editor = blank(S.ver);
    const ks = $('build-fill-weapon'); ks.replaceChildren(); ks.add(new Option('any weapon', '')); for (const [k, n] of Object.entries(WEAPON_KINDS)) if (S.data.items.some(i => i.kind === k)) ks.add(new Option(n, k));
    await readInventory();
  }
  function wire() {
    document.body.append($('build-picker'));   // the page column is a transformed box, so a fixed overlay inside it sits off centre; on <body> it covers the window
    $('build-version').onchange = () => switchVersion(false);
    $('build-character').onchange = pickCharacter; $('build-refresh').onclick = () => readInventory();
    for (const b of document.querySelectorAll('.builds-tab')) b.onclick = () => { snapshot(); showTab(b.dataset.buildTab); };
    $('build-save').onclick = save;
    $('build-clear').onclick = () => { editor = blank(S.ver); $('build-fill-note').textContent = ''; render(); };
    $('build-share').onclick = async () => { snapshot(); note((await copyText(shareCode(editor))) ? 'Share code copied. Paste it anywhere; Import on My builds reads it.' : 'Could not copy.', false); };
    $('build-fill').onclick = fill;
    $('build-picker-search').oninput = drawPicker; $('build-picker-kind').onchange = drawPicker; $('build-picker-close').onclick = closePicker;
    $('build-picker').addEventListener('click', (e) => { if (e.target === $('build-picker')) closePicker(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.picker) closePicker(); });
    for (const id of ['build-catalog-search', 'build-catalog-kind', 'build-catalog-owned']) $(id).addEventListener(id === 'build-catalog-search' ? 'input' : 'change', renderCatalog);
    const doImport = (src) => {
      const txt = $(src).value;
      if (/dauntless-builder|\/b\/|^[A-Za-z0-9_.\-~]{40,}$/.test(txt.trim())) {   // a link from reforged.dauntless-builder.com
        const r = fromDauntlessBuilder(txt); if (!r) return note('That is not a build link.', true); if (r.error) return note(r.error, true);
        editor = r.build; $(src).value = ''; if (S.ver !== '1.14.7') { $('build-version').value = '1.14.7'; switchVersion(true).then(() => showTab('editor')); } else showTab('editor');
        note(r.missing.length ? 'Build read from dauntless-builder. Not in this version of the game, left empty: ' + r.missing.join(', ') + '. Press Save build to keep it.' : 'Build read from dauntless-builder. Press Save build to keep it.'); return;
      }
      const b = parseCode(txt); if (!b) return note('That is not a build code.', true); if (!DATA[b.version]) return note('That build is for ' + b.version + ', which has no data here.', true); editor = { ...blank(b.version), ...b, id: '' }; if (!editor.cells || Array.isArray(editor.cells)) editor.cells = {}; $(src).value = ''; if (b.version !== S.ver) { $('build-version').value = b.version; switchVersion(true).then(() => showTab('editor')); } else showTab('editor'); note('Build loaded into the Builder. Press Save build to keep it.'); };
    $('build-import').onclick = () => doImport('build-import-text'); $('build-import2').onclick = () => doImport('build-import-text2');
    for (const id of ['build-import-text', 'build-import-text2']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') doImport(id); });
    const kc = $('build-catalog-kind'); kc.add(new Option('Everything', '')); kc.add(new Option('Weapons', 'weapon')); for (const k of ['head', 'chest', 'arms', 'legs', 'lantern', 'omnicell', 'part']) kc.add(new Option(SLOT_NAME[k], k));
    const ef = $('build-fill-element'); ef.add(new Option('any element', '')); for (const e of ELEMENTS) ef.add(new Option(e, e));
  }
  async function init() {
    if (loaded) return; loaded = true; wire();
    const want = $('build-version').value; if (!DATA[want]) $('build-version').value = Object.keys(DATA)[0] || '1.14.7';
    await loadSaved(); await switchVersion(false);
  }
  // app.js sets #build-version to the Play page's version and fires change before the page shows; before init that is harmless
  document.addEventListener('page:shown', (e) => { if (e.detail === 'builds') init(); });
})();
