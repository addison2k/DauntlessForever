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
  const S = { board: null, ver: '1.14.7', data: null, byId: new Map(), cells: new Map(), characters: [], owned: null, saved: [], tab: 'editor', picker: null, note: '' };
  let editor = blank('1.14.7'), loaded = false;

  function blank(ver) { return { id: '', name: '', notes: '', version: ver, slots: Object.fromEntries(SLOTS.map(k => [k, ''])), cells: {}, locks: [] }; }
  function note(s, err) { for (const id of ['build-message', 'build-board-message']) { const n = $(id); if (n) { n.textContent = s || ''; n.classList.toggle('err', !!err); } } }
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

  // ------------------------------------------------------------------ the +1 to +6 box (DF-PERKTIP)
  // Every perk's own words at each rank, from the game's tables (builds-perkranks-*.js). It hangs off document.body,
  // not the card: the page column is transformed, so a child box lands in the wrong place (same reason as the picker).
  function perkRanksFor(idOrName) {
    const table = (window.DFPerkRanks || {})[S.ver]; if (!table || !idOrName) return null;
    if (table[idOrName]) return table[idOrName];
    const p = (S.data.perks || []).find(x => x.name === idOrName);   // the summary and cells know the name, not the id
    return (p && table[p.id]) || null;
  }
  function tipBox() { let b = $('bld-tip'); if (!b) { b = el('div', 'bld-tip'); b.id = 'bld-tip'; b.hidden = true; document.body.append(b); } return b; }
  function hideTip() { const b = $('bld-tip'); if (b) { b.hidden = true; b.replaceChildren(); } }
  function fillTip(b, title, entry, atRank) {
    b.replaceChildren();
    b.append(el('div', 'bld-tip-h', title));
    const have = Math.max(0, Number(atRank) || 0);
    for (let r = 1; r <= 6; r++) {
      const lines = entry.ranks[String(r)]; if (!lines || !lines.length) continue;
      const row = el('div', 'bld-tip-r' + (r === Math.min(have, 6) ? ' is-now' : ''));
      row.append(el('span', 'bld-tip-n', '+' + r));
      const tx = el('span', 'bld-tip-t'); for (const ln of lines) tx.append(el('div', '', ln)); row.append(tx);
      b.append(row);
    }
    if (have > 6) b.append(el('div', 'bld-tip-f', 'You have +' + have + '; the game counts +6.'));
  }
  function placeTip(b, target) {
    b.hidden = false; b.style.left = '0px'; b.style.top = '0px';
    const r = target.getBoundingClientRect(), box = b.getBoundingClientRect(), gap = 8;
    let x = r.right + gap; if (x + box.width > window.innerWidth - 6) x = r.left - gap - box.width;
    if (x < 6) x = Math.max(6, Math.min(r.left, window.innerWidth - box.width - 6));
    let y = r.top + (r.height - box.height) / 2;
    y = Math.max(6, Math.min(y, window.innerHeight - box.height - 6));
    b.style.left = Math.round(x) + 'px'; b.style.top = Math.round(y) + 'px';
  }
  // any pill, any row, any cell: hover or keyboard focus shows the box, leaving or Escape hides it
  function withTip(node, idOrName, title, atRank) {
    const entry = perkRanksFor(idOrName); if (!entry) return node;
    node.classList.add('has-tip');
    const show = () => { const b = tipBox(); fillTip(b, title || entry.name || String(idOrName), entry, atRank); placeTip(b, node); };
    node.addEventListener('mouseenter', show);
    node.addEventListener('focus', show);
    node.addEventListener('mouseleave', hideTip);
    node.addEventListener('blur', hideTip);
    return node;
  }


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
    if (it && (it.perks || []).length) { const row = el('div', 'bld-perks'); for (const p of it.perks) row.append(withTip(el('span', 'bld-perk pt-' + (p.type || '').toLowerCase(), '+' + p.ranks + ' ' + p.name), p.id || p.name, p.name, p.ranks)); c.append(row); }
    if (it && (it.unique || []).length) c.append(el('div', 'bld-unique', it.unique.map(u => u.text).join(' ')));
    if (it && key !== 'bond' && (it.slots || []).length) {   // a bonded weapon lends its perk and effect, not its cell slots
      const row = el('div', 'bld-cells'); const chosen = editor.cells[key] || [];
      it.slots.forEach((type, i) => {
        const cc = cell(chosen[i]); const b = el('button', 'bld-cellslot' + (cc ? ' on' : '') + ' ct-' + type.toLowerCase()); b.type = 'button';
        const ci = el('img'); ci.src = 'build-icons/' + (cc ? (cc.icon || 'ico_cell_filled') : 'ico_cell_' + (type === 'Defence' ? 'defense' : type === 'Any' ? 'power' : type.toLowerCase()) + '_empty') + '.png'; ci.alt = '';
        b.append(ci, el('span', '', cc ? cc.name : type + ' cell'));
        if (cc) withTip(b, cellPerk(cc), cellPerk(cc), cellRanks(cc));   // a filled cell slot shows its perk's +1 to +6
        b.onclick = (e) => { e.stopPropagation(); hideTip(); openCellPicker(key, i, type); };
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
      withTip(row, name, name, v.ranks);
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
  function closePicker() { S.picker = null; $('build-picker').hidden = true; hideTip(); }
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
      for (const pp of (x.perks || [])) m.append(withTip(el('span', 'bld-perk pt-' + (pp.type || '').toLowerCase(), '+' + pp.ranks + ' ' + pp.name), pp.id || pp.name, pp.name, pp.ranks));
      if (x.desc && !p.opts.gear) m.append(el('span', 'bld-desc', x.desc));
      t.append(m); row.append(t);
      const o = p.opts.gear ? owned(x) : ownedCell(x); row.append(el('span', 'bld-own ' + (o === true ? 'yes' : o === false ? 'no' : 'unk'), o === true ? 'owned' : o === false ? 'not owned' : ''));
      if (!p.opts.gear) withTip(row, cellPerk(x), cellPerk(x), cellRanks(x));   // in the cell picker every cell shows its perk's +1 to +6
      row.onclick = () => { hideTip(); p.onPick(x); }; box.append(row);
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
  // ------------------------------------------------------------------ Community: the build rankings board (DF-BOARD)
  // Everything here goes through the df-builds service on the Friends VPS. The tab is hidden until that service
  // answers its health route, so a launcher can ship before the service is up. The wire format is the DFB2 share
  // code the page already makes, so Open is the same path as Import.
  const COMM = { sort: 'top', weaponKind: '', element: '', mine: false, page: 1, pages: 1, total: 0, builds: [], busy: false, loaded: false, error: '' };
  function boardOn() { return !!(S.board && S.board.cap && L.socialBoardList); }
  function showBoardBits() {
    const nav = $('meta-nav'), pub = $('build-publish');
    if (nav) nav.hidden = !boardOn();
    if (pub) pub.hidden = !boardOn();
    if (!boardOn() && (S.tab === 'community' || S.tab === 'meta')) { showTab('editor'); if (onBoardPage() && typeof showPage === 'function') showPage('builds'); }
  }
  function weaponKindOf(b) { const w = (DATA[b.version] && DATA[b.version].items.find(i => i.id === (b.slots && b.slots.weapon))) || null; return w ? w.kind : ''; }
  function elementOf(b) {
    const counts = new Map();
    for (const k of SLOTS) { const it = (DATA[b.version] && DATA[b.version].items.find(i => i.id === (b.slots && b.slots[k]))) || null; if (it && it.element) counts.set(it.element, (counts.get(it.element) || 0) + 1); }
    let best = '', n = 0; for (const [e, c] of counts) if (c > n) { best = e; n = c; }
    return best;
  }
  // DF-BOARD-META: Meta and Community live on their own page (nav "Meta"); the Builder lives on the Builds page.
  // The Builds page is shown before a build goes into the editor: app.js sets the version when that page shows, which
  // would clear a build put there first.
  function onBoardPage() { const p = $('page-meta'); return !!(p && !p.hidden); }
  function goBuilds() { const p = $('page-builds'); if (p && p.hidden && typeof showPage === 'function') showPage('builds'); }
  function goBoard(tab) { if (!onBoardPage() && typeof showPage === 'function') { S.tab = tab; showPage('meta'); } else showTab(tab); }
  async function commLoad(page) {
    if (!boardOn() || COMM.busy) return;
    COMM.busy = true; COMM.error = ''; renderCommunity();
    try {
      const r = await L.socialBoardList({ sort: COMM.sort, weaponKind: COMM.weaponKind, element: COMM.element, mine: COMM.mine, page: page || COMM.page });
      if (r && r.ok) { COMM.builds = r.builds || []; COMM.page = r.page || 1; COMM.pages = r.pages || 1; COMM.total = r.total || 0; COMM.loaded = true; }
      else COMM.error = (r && r.error) || 'The board did not answer.';
    } catch (e) { COMM.error = e.message; }
    COMM.busy = false; renderCommunity();
  }
  async function commVote(b, row) {
    const r = await L.socialBoardVote(b.id, !b.voted);
    if (!r || !r.ok) return note((r && r.error) || 'That vote did not go through.', true);
    b.votes = r.votes; b.voted = r.voted; META.loaded = false; renderCommunity();
  }
  async function commRemove(b) {
    if (!confirm('Take "' + b.name + '" off the board?')) return;
    const r = await L.socialBoardRemove(b.id);
    if (!r || !r.ok) return note((r && r.error) || 'It is still there.', true);
    note('Taken off the board.'); commLoad(COMM.page);
  }
  function commOpen(b) {
    goBuilds();
    const got = parseCode(b.code);
    if (!got) return note('That build could not be read.', true);
    if (!DATA[got.version]) return note('That build is for ' + got.version + ', which has no data here.', true);
    editor = { ...blank(got.version), ...got, id: '' };
    if (!editor.cells || Array.isArray(editor.cells)) editor.cells = {};
    if (got.version !== S.ver) { $('build-version').value = got.version; switchVersion(true).then(() => showTab('editor')); } else showTab('editor');
    note('Loaded into the Builder. Press Save build to keep your own copy.');
  }
  async function commPublish() {
    if (!boardOn()) return note('The build board is not running yet.', true);
    snapshot();
    if (!SLOTS.some(k => editor.slots[k])) return note('Put some gear in the build first.', true);
    if (!editor.name) return note('Give the build a name first.', true);
    const r = await L.socialBoardPublish({ code: shareCode(editor), name: editor.name, notes: editor.notes, version: editor.version, weaponKind: weaponKindOf(editor), element: elementOf(editor) });
    if (!r || !r.ok) return note((r && r.error) || 'It did not go up.', true);
    note('Published. It is on the Community tab now.'); META.loaded = false;
    COMM.page = 1; COMM.sort = 'new'; const s = $('build-comm-sort'); if (s) s.value = 'new';
    goBoard('community'); commLoad(1);
  }
  // ------------------------------------------------------------------ DF-BOARD-META (Nov 8): weapon strip, gear strip, Meta tab
  // The weapon strip replaces the weapon dropdown (still in the page, hidden, so its value stays the one source):
  // ALL, then one picture per weapon the version has. The gear strip shows a build's gear as pictures on every board
  // row. The Meta tab asks the board for the top build of each weapon (sort top, page 1, first row) and shows one
  // card per weapon; it is read-only and goes through the same list route as the Community tab.
  const WPN_ART = k => 'build-icons/wpnclass_' + k + '.png';
  const WPN_SHORT = { chainblades: 'Chains', strikers: 'Strikers', pike: 'War Pike' };
  function boardKinds() { const d = DATA['1.14.7'] || S.data; return Object.keys(WEAPON_KINDS).filter(k => d && d.items.some(i => i.kind === k)); }
  function renderWeaponStrip() {
    const box = $('build-comm-weapons'); if (!box) return; box.replaceChildren();
    const pick = (k) => { COMM.weaponKind = k; const s = $('build-comm-weapon'); if (s) s.value = k; renderWeaponStrip(); commLoad(1); };
    const all = el('button', 'bld-wbtn all' + (COMM.weaponKind ? '' : ' on'), ''); all.type = 'button'; all.title = 'Every weapon';
    all.append(el('span', 'bld-wall', 'ALL'), el('span', 'bld-wname', 'All builds')); all.onclick = () => pick(''); box.append(all);
    for (const k of boardKinds()) {
      const b = el('button', 'bld-wbtn' + (COMM.weaponKind === k ? ' on' : ''), ''); b.type = 'button'; b.title = WEAPON_KINDS[k];
      const img = el('img'); img.src = WPN_ART(k); img.alt = ''; b.append(img, el('span', 'bld-wname', WPN_SHORT[k] || WEAPON_KINDS[k])); b.onclick = () => pick(k); box.append(b);
    }
  }
  function gearStrip(b) {
    const got = parseCode(b.code); const d = got && DATA[got.version]; const strip = el('div', 'bld-gear');
    if (!d) return strip;
    for (const k of ['weapon', 'head', 'chest', 'arms', 'legs', 'lantern', 'omnicell']) {
      const id = got.slots && got.slots[k]; if (!id) continue;
      const it = d.items.find(i => i.id === id); if (!it) continue;
      const img = el('img'); img.src = iconUrl(it, it.kind); img.alt = it.name; img.title = it.name; img.loading = 'lazy';
      img.onerror = () => { img.onerror = null; img.src = iconUrl(null, it.kind); }; strip.append(img);
    }
    return strip;
  }
  const META = { busy: false, loaded: false, error: '', top: {} };
  async function metaLoad() {
    if (!boardOn() || META.busy) return;
    META.busy = true; META.error = ''; renderMeta();
    try {
      const kinds = boardKinds();
      const rs = await Promise.all(kinds.map(k => L.socialBoardList({ sort: 'top', weaponKind: k, element: '', mine: false, page: 1 }).catch(() => null)));
      META.top = {}; let ok = 0;
      kinds.forEach((k, n) => { const r = rs[n]; if (r && r.ok) { ok++; META.top[k] = (r.builds || [])[0] || null; } });
      if (!ok) META.error = 'The board did not answer.';
      META.loaded = true;
    } catch (e) { META.error = e.message; }
    META.busy = false; renderMeta();
  }
  async function metaVote(b) {
    const r = await L.socialBoardVote(b.id, !b.voted);
    if (!r || !r.ok) return note((r && r.error) || 'That vote did not go through.', true);
    b.votes = r.votes; b.voted = r.voted; renderMeta();
  }
  function renderMeta() {
    const box = $('build-meta-grid'); if (!box) return; box.replaceChildren();
    if (META.error) { box.append(el('p', 'small err', META.error)); return; }
    if (META.busy && !META.loaded) { box.append(el('p', 'small', 'Loading...')); return; }
    for (const k of boardKinds()) {
      const b = META.top[k], card = el('div', 'bld-meta-card' + (b ? '' : ' empty'));
      const head = el('div', 'bld-meta-head'); const img = el('img', 'bld-meta-art'); img.src = WPN_ART(k); img.alt = '';
      const ht = el('div', 'bld-meta-ht'); ht.append(el('div', 'bld-slot', 'Top ' + WEAPON_KINDS[k] + ' build'), el('div', 'bld-name', b ? b.name : 'Nobody yet'));
      head.append(img, ht); card.append(head);
      if (!b) {
        card.append(el('p', 'small', 'No ' + WEAPON_KINDS[k] + ' build on the board. Make one on the Builder tab and press Publish this build.'));
        box.append(card); continue;
      }
      const m = el('div', 'bld-row-meta'); m.append(el('span', 'bld-beh', 'by ' + b.author));
      if (b.element) m.append(el('span', 'bld-el el-' + b.element.toLowerCase(), b.element));
      m.append(el('span', 'bld-beh', b.votes + ' vote' + (b.votes === 1 ? '' : 's'))); card.append(m);
      card.append(gearStrip(b));
      if (b.notes) card.append(el('div', 'small bld-meta-notes', b.notes));
      const acts = el('div', 'bld-meta-acts');
      const open = el('button', 'primary-sm', 'Open'); open.type = 'button'; open.onclick = () => commOpen(b);
      const vote = el('button', 'ghost hm-small' + (b.voted ? ' on' : ''), b.voted ? 'Voted' : 'Upvote'); vote.type = 'button'; vote.onclick = () => metaVote(b);
      const more = el('button', 'ghost hm-small', 'All ' + WEAPON_KINDS[k] + ' builds'); more.type = 'button';
      more.onclick = () => { COMM.weaponKind = k; COMM.sort = 'top'; const s = $('build-comm-sort'); if (s) s.value = 'top'; const w = $('build-comm-weapon'); if (w) w.value = k; showTab('community'); commLoad(1); };
      acts.append(open, vote, more); card.append(acts); box.append(card);
    }
  }
  function renderCommunity() {
    const box = $('build-comm-list'); if (!box) return; box.replaceChildren();
    $('build-comm-count').textContent = COMM.busy ? 'Loading...' : COMM.total ? COMM.total + ' build' + (COMM.total === 1 ? '' : 's') : '';
    $('build-comm-page').textContent = COMM.pages > 1 ? 'Page ' + COMM.page + ' of ' + COMM.pages : '';
    $('build-comm-prev').disabled = COMM.page <= 1; $('build-comm-next').disabled = COMM.page >= COMM.pages;
    const pager = $('build-comm-prev').parentElement; if (pager) pager.hidden = COMM.pages <= 1;   // one page needs no Back and More
    if (COMM.error) { box.append(el('p', 'small err', COMM.error)); return; }
    if (COMM.busy && !COMM.builds.length) { box.append(el('p', 'small', 'Loading...')); return; }
    if (!COMM.builds.length) { box.append(el('p', 'small', COMM.mine ? 'You have not published anything yet. Make a build on the Builder tab and press Publish this build.' : 'Nothing on the board yet. Be the first: Builder tab, then Publish this build.')); return; }
    for (const b of COMM.builds) {
      const row = el('div', 'bld-saved');
      const vote = el('button', 'bld-vote' + (b.voted ? ' on' : ''), ''); vote.type = 'button';
      vote.append(el('span', 'bld-vote-caret', '^'), el('span', 'bld-vote-n', String(b.votes)));
      vote.title = b.voted ? 'Take your vote back' : 'Upvote this build';
      vote.onclick = () => commVote(b, row);
      row.append(vote);
      if (b.weaponKind && WEAPON_KINDS[b.weaponKind]) { const wi = el('img', 'bld-row-wpn'); wi.src = WPN_ART(b.weaponKind); wi.alt = ''; wi.title = WEAPON_KINDS[b.weaponKind]; row.append(wi); }
      const t = el('div', 'bld-saved-text');
      t.append(el('div', 'bld-row-name', b.name + '  (' + b.version + ')'));
      const m = el('div', 'bld-row-meta');
      m.append(el('span', 'bld-beh', 'by ' + b.author));
      if (b.weaponKind) m.append(el('span', 'bld-beh', WEAPON_KINDS[b.weaponKind] || b.weaponKind));
      if (b.element) m.append(el('span', 'bld-el el-' + b.element.toLowerCase(), b.element));
      t.append(m);
      if (b.notes) t.append(el('div', 'small', b.notes));
      t.append(gearStrip(b));
      row.append(t);
      const acts = el('div', 'bld-saved-acts');
      const open = el('button', 'primary-sm', 'Open'); open.onclick = () => commOpen(b); acts.append(open);
      const code = el('button', 'ghost hm-small', 'Copy code'); code.onclick = async () => { note((await copyText(b.code)) ? 'Share code copied.' : 'Could not copy.', false); }; acts.append(code);
      if (b.mine) { const rm = el('button', 'ghost hm-small danger', 'Remove'); rm.onclick = () => commRemove(b); acts.append(rm); }
      row.append(acts); box.append(row);
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
    if (S.tab === 'editor') renderLoadout(); else if (S.tab === 'mine') renderMine(); else if (S.tab === 'community') { renderWeaponStrip(); renderCommunity(); if (!COMM.loaded && !COMM.busy) commLoad(1); } else if (S.tab === 'meta') { renderMeta(); if (!META.loaded && !META.busy) metaLoad(); } else renderCatalog();
    const n = $('build-data-note'); n.hidden = !(S.data && S.data.note); n.textContent = (S.data && S.data.note) || '';
    if (sc) sc.scrollTop = top;
  }
  function showTab(tab) { S.tab = tab; for (const k of ['editor', 'catalog', 'mine', 'meta', 'community']) { const p = $('build-panel-' + k), b = $('build-tab-' + k); if (p) p.hidden = k !== tab; if (b) b.classList.toggle('is-active', k === tab); } closePicker(); render(); }
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
    $('build-publish').onclick = commPublish;
    const cs = $('build-comm-sort'); cs.add(new Option('Top', 'top')); cs.add(new Option('New', 'new')); cs.add(new Option('By weapon', 'weapon'));
    const cw = $('build-comm-weapon'); cw.add(new Option('any weapon', '')); for (const [k, n] of Object.entries(WEAPON_KINDS)) cw.add(new Option(n, k));
    const ce = $('build-comm-element'); ce.add(new Option('any element', '')); for (const e of ELEMENTS) ce.add(new Option(e, e));
    for (const id of ['build-comm-sort', 'build-comm-weapon', 'build-comm-element', 'build-comm-mine']) $(id).addEventListener('change', () => {
      COMM.sort = $('build-comm-sort').value; COMM.weaponKind = $('build-comm-weapon').value; COMM.element = $('build-comm-element').value; COMM.mine = $('build-comm-mine').checked; commLoad(1);
    });
    $('build-comm-refresh').onclick = () => commLoad(COMM.page);
    $('build-comm-prev').onclick = () => commLoad(Math.max(1, COMM.page - 1));
    $('build-comm-next').onclick = () => commLoad(Math.min(COMM.pages, COMM.page + 1));
    if (L.socialState) { L.socialState().then((s) => { S.board = s && s.board; showBoardBits(); }).catch(() => {}); }
    if (L.onSocialUpdate) L.onSocialUpdate((s) => { const was = boardOn(); S.board = s && s.board; if (boardOn() !== was) showBoardBits(); });
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
  document.addEventListener('page:shown', async (e) => {
    if (e.detail !== 'builds' && e.detail !== 'meta') return;
    await init();
    const board = S.tab === 'meta' || S.tab === 'community';
    if (e.detail === 'meta') showTab(board ? S.tab : 'meta');
    else showTab(board ? 'editor' : S.tab);
  });
  // the Meta nav item shows as soon as the board answers, before either page was opened
  if (L.socialState) L.socialState().then((s) => { S.board = s && s.board; showBoardBits(); }).catch(() => {});
  if (L.onSocialUpdate) L.onSocialUpdate((s) => { const was = boardOn(); S.board = s && s.board; if (boardOn() !== was) showBoardBits(); });
})();
