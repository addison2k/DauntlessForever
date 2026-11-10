// SPDX-License-Identifier: AGPL-3.0-only
// DF-EVENTSTORE-1147 (Nov 9): Honest Ozz's Event Store for 1.14.7.
// The client asks GET /product/skus/public?requiredTags=seasonal_event when Ozz's Event Store opens.
// eventstore1147-data.json has one shelf per event (EVENT_FROSTFALL ...). A shelf is open while the launcher's
// Events page has schedule:<event> on (events1147.chosen()). Offers are priced in the event's own coin
// (CURRENCY_EVENT_FROSTFALL, shown by the client as id_currency_event_frostfall, an EventStore currency of the
// game's currency table). Purchase flow (token -> notification, atomic, balance check) follows store-rams1147.js.
'use strict';
const crypto = require('crypto');
const data = require('./eventstore1147-data.json');
const PREFIX = 'eventstore1147_';   // purchase tokens only
const SKU_OK = /^[A-Za-z0-9_-]{3,120}$/, COIN_OK = /^CURRENCY_[A-Z0-9_]+$/, LABEL_OK = /^(id_currency_[a-z0-9_]+|CURRENCY_PRESTIGE)$/, EVENT_OK = /^[A-Za-z0-9_]{1,80}$/;
const TAGS = ['SEASONALEVENTS', 'seasonal_event'];   // default shelf tags (Honest Ozz's Event Store)
// DF-STYLIST-1147 (Nov 10): a shelf may name its own tags (Stylist2k's Vault asks for season_store), may have no event
// (always open), and an offer may be an account entitlement (hair styles, hair colours, face paints) instead of an item.
const clone = (x) => JSON.parse(JSON.stringify(x)), hash = (x) => crypto.createHash('sha256').update(x).digest('hex');
function error(message, status = 409) { const e = Error(message); e.status = status; return e; }
function tags(v) { if (Array.isArray(v)) return v.flatMap(tags); if (typeof v !== 'string') return []; try { const a = JSON.parse(v); if (Array.isArray(a)) return a.flatMap(tags); } catch {} return v.split(/[,;|]/).map((t) => t.trim().toLowerCase()).filter(Boolean); }
const curName = (v) => String(v || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || '(none)';
// ---------------------------------------------------------------- offers (built once at start)
function build() {
  const out = [], seen = new Set();
  for (const s of data.shelves || []) {
    if (!s || (s.event && !EVENT_OK.test(s.event)) || !COIN_OK.test(s.coin || '') || !LABEL_OK.test(s.label || '') || !/^[a-z0-9_]{1,60}$/.test(s.skuPrefix || '')) continue;
    const stags = Array.isArray(s.tags) && s.tags.length ? s.tags.filter((t) => typeof t === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(t)) : TAGS;
    const coinName = typeof s.coinName === 'string' ? s.coinName : 'event coins';
    let n = 0;
    for (const x of s.offers || []) {
      // x.sku (optional): a row of the game's store picture table (UI/Store/StoreItemsTable), so the tile has its picture.
      // x.items (optional): a bundle; otherwise x.catalogId x x.quantity.
      if (!x) continue;
      if (typeof x.entitlement === 'string') {                         // an account unlock, no item
        if (!/^[A-Za-z0-9_-]{2,100}$/.test(x.entitlement) || !Number.isSafeInteger(x.price) || x.price < 0) continue;
        const sku = typeof x.sku === 'string' && x.sku ? x.sku : s.skuPrefix + x.entitlement.toLowerCase().replace(/-/g, '_');
        if (!SKU_OK.test(sku) || seen.has(sku)) continue;
        seen.add(sku); n++;
        const xt = Array.isArray(x.tags) ? x.tags.filter((t) => typeof t === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(t)) : [];   // the screen's tab and type tags
        out.push({ sku, event: s.event || '', tags: [...stags, ...xt], coin: s.coin, label: s.label, name: String(x.name || x.entitlement), price: x.price, repeatable: false, priority: n,
          description: (x.kind ? x.kind + '. ' : '') + 'Costs ' + x.price + ' ' + coinName + '.', items: [], entitlement: x.entitlement });
        continue;
      }
      const q = Number.isSafeInteger(x.quantity) && x.quantity > 0 ? x.quantity : 1;
      const items = (Array.isArray(x.items) ? x.items : [{ catalogId: x.catalogId, quantity: q }])
        .filter((i) => i && typeof i.catalogId === 'string' && /^[A-Z0-9_]{2,100}$/.test(i.catalogId))
        .map((i) => ({ catalogId: i.catalogId, quantity: Number.isSafeInteger(i.quantity) && i.quantity > 0 ? i.quantity : 1 }));
      if (!items.length || (Array.isArray(x.items) && items.length !== x.items.length)) continue;
      const sku = typeof x.sku === 'string' && x.sku ? x.sku : s.skuPrefix + items[0].catalogId.toLowerCase();
      if (!SKU_OK.test(sku) || seen.has(sku) || !Number.isSafeInteger(x.price) || x.price < 0) continue;
      seen.add(sku); n++;
      out.push({ sku, event: s.event || '', tags: stags, coin: s.coin, label: s.label, name: String(x.name || items[0].catalogId), price: x.price, repeatable: !!x.repeatable, priority: n,
        description: (x.repeatable && items.length === 1 && q > 1 ? q + ' charges. ' : '') + 'Costs ' + x.price + ' ' + coinName + '.', items });
    }
  }
  return out;
}
const offers = build(), bySku = new Map(offers.map((o) => [o.sku, o]));
const shelves = [...new Map(offers.map((o) => [o.coin + '|' + o.label, { event: o.event, coin: o.coin, label: o.label }])).values()];
const hasEnt = (p, name) => (p?.entitlements || []).some((e) => e && e.name === name);
// ---------------------------------------------------------------- ownership
function quantity(inv, id) { const list = (inv.stackedItems || []).filter((i) => i.catalogId === id); if (list.length > 1 || list.some((i) => !Number.isSafeInteger(i.quantity) || i.quantity < 0)) throw error('Invalid or duplicate saved stack: ' + id); return list[0]?.quantity || 0; }
function ownedSet(inv) { const s = new Set(); for (const i of inv.instancedItems || []) s.add(i.catalogId); for (const i of inv.stackedItems || []) if (i.quantity > 0) s.add(i.catalogId); return s; }
const owned = (o, set, p) => o.entitlement ? hasEnt(p, o.entitlement) : !o.repeatable && o.items.every((i) => set.has(i.catalogId));
function publicOffer(o, set, signed, p) {
  const own = owned(o, set, p);
  return { id: o.sku, displayName: o.name, displayDescription: o.description, displayPriority: o.priority, tags: [...o.tags],
    prices: [{ currencyId: o.label, price: o.price, salesPrice: o.price, multiPrice: null }],
    items: o.items.map((i) => ({ catalogId: i.catalogId, quantity: i.quantity })), entitlements: o.entitlement ? [{ name: o.entitlement, duration: 0 }] : [], skuProgression: [], images: {},
    maxAllowed: o.repeatable ? 99 : 1, remaining: signed && !own ? 1 : 0, duplicateInstancedItems: o.repeatable ? [] : o.items.filter((i) => set.has(i.catalogId)).map((i) => i.catalogId), loadoutSlots: null,
    availableFrom: null, availableTo: null, timeAvailabilityReason: null, platformOfferId: null, missingEntitlementNames: null, scheduledTags: null };
}
// ---------------------------------------------------------------- module
function create(ctx, options = {}) {
  const now = options.now || Date.now, next = ctx.next || (() => null), ok = (json, note) => ({ status: 200, json, note }), empty = { stackedItems: [], instancedItems: [] };
  const chosen = () => { try { return ctx.chosenEvents ? ctx.chosenEvents() : []; } catch { return []; } };
  const isOpen = (o) => !o.event || chosen().includes(o.event);
  const session = (req) => { const t = ctx.bearerOf(req); return t && ctx.sessions.has(t) ? ctx.playerFor(req) : null; };
  const player = (req) => { const p = session(req); if (!p) throw error('Signed-in player session required', 403); return p; };
  const character = (p) => p?.characters?.find((c) => typeof c.id === 'string')?.id;
  const inventory = (p) => p?.inventory?.[character(p)] || empty;
  function meta(p) { p.mega1147 ??= {}; return p.mega1147.eventStore ??= { tokens: {} }; }
  function atomic(p, fn) { const before = clone(p); try { const r = fn(); ctx.saveState(); return r; } catch (e) { for (const k of Object.keys(p)) delete p[k]; Object.assign(p, before); throw e; } }
  function eligible(p, o) { if (!isOpen(o)) throw error('This event is not running', 410); if (!character(p)) throw error('Saved character required'); const inv = inventory(p); if (owned(o, ownedSet(inv), p)) throw error('Item is already owned'); if (quantity(inv, o.coin) < o.price) throw error('Not enough ' + (o.coin === 'CURRENCY_NOTES' ? 'Rams' : 'event coins')); }
  function issue(p, o, cur) {
    eligible(p, o);
    return atomic(p, () => {
      const m = meta(p);
      for (const [k, t] of Object.entries(m.tokens)) if (now() - t.at > 7 * 86400000) delete m.tokens[k];
      if (Object.values(m.tokens).filter((t) => !t.done && now() - t.at <= 600000).length >= 50) throw error('Too many pending event store purchases', 429);
      const token = PREFIX + crypto.randomBytes(32).toString('hex');
      m.tokens[hash(token)] = { sku: o.sku, character: character(p), price: o.price, coin: o.coin, currency: curName(cur), at: now(), done: false };
      return ok({ purchaseToken: token }, 'eventstore1147: token for ' + o.sku + ' (' + o.price + ' ' + o.coin + '), client currency ' + curName(cur));
    });
  }
  function redeem(p, token, cur) {
    const t = p.mega1147?.eventStore?.tokens?.[hash(token)];
    if (!t || t.character !== character(p)) throw error('Event store purchase belongs to another account or character', 403);
    if (t.done) return { status: 204, note: 'eventstore1147: ' + t.sku + ' already paid (same token)' };
    if (now() - t.at > 600000) throw error('Event store purchase expired', 410);
    const o = bySku.get(t.sku); if (!o || o.price !== t.price || o.coin !== t.coin) throw error('Event store offer changed');
    eligible(p, o);
    return atomic(p, () => {
      const inv = ctx.inventoryOf(p, t.character), held = inv.stackedItems.find((i) => i.catalogId === o.coin);
      if (!held || held.quantity < t.price) throw error('Not enough ' + (o.coin === 'CURRENCY_NOTES' ? 'Rams' : 'event coins'));
      held.quantity -= t.price;
      if (o.entitlement) {
        if (!hasEnt(p, o.entitlement)) { p.entitlements ??= []; p.entitlements.push({ name: o.entitlement, duration: 0, activatedDate: null }); }
        t.done = true;
        return { status: 204, note: 'eventstore1147: ' + o.sku + ' (entitlement ' + o.entitlement + ') bought for ' + t.price + ' ' + o.coin + ', ' + held.quantity + ' left' };
      }
      const set = ownedSet(inv);
      for (const i of o.items) {
        if (!o.repeatable && set.has(i.catalogId)) continue;
        const n = (o.repeatable ? quantity(inv, i.catalogId) : 0) + i.quantity;
        if (!Number.isSafeInteger(n) || n > 2147483647) throw error('Event store quantity overflow');
        const s = inv.stackedItems.find((x) => x.catalogId === i.catalogId);
        if (s) s.quantity = o.repeatable ? n : Math.max(s.quantity, i.quantity); else inv.stackedItems.push({ catalogId: i.catalogId, quantity: n });
      }
      t.done = true;
      return { status: 204, note: 'eventstore1147: ' + o.sku + ' bought for ' + t.price + ' ' + o.coin + ' (client currency ' + curName(cur) + '), ' + held.quantity + ' left' };
    });
  }
  // The balance shows each open event's real coin under its CURRENCY_ id and its id_currency_ label.
  function withCoins(obj, p) {
    if (!obj || typeof obj !== 'object' || !p || !character(p)) return obj;
    const inv = inventory(p);
    for (const s of shelves) { const n = quantity(inv, s.coin); obj[s.coin] = n; obj[s.label] = n; }
    return obj;
  }
  function handle(c) {
    if (c.service !== 'store') return next(c);
    const pathname = c.path.replace(/\/$/, '');
    if (c.method === 'GET' && pathname === '/product/skus/public') {
      const required = c.url.searchParams.getAll('requiredTags').flatMap(tags), base = next(c);
      if (!required.length) return base;
      const added = offers.filter((o) => isOpen(o) && required.every((t) => o.tags.map((x) => x.toLowerCase()).includes(t)));
      if (!added.length) return base;
      const p = session(c.req), set = ownedSet(inventory(p)), signed = !!p && !!character(p);
      const kept = Array.isArray(base?.json) ? base.json.filter((o) => !bySku.has(o?.id)) : [];
      return { ...(base || {}), status: 200, json: [...kept, ...added.map((o) => publicOffer(o, set, signed, p))], note: ((base && base.note) ? base.note + '; ' : '') + 'eventstore1147: ' + added.length + ' offer(s) for ' + required.join(',') };
    }
    if (c.method === 'GET' && pathname === '/balance') {
      const base = next(c), p = session(c.req);
      if (!p || !base || !base.json || typeof base.json !== 'object' || Array.isArray(base.json)) return base;
      return { ...base, json: withCoins(clone(base.json), p), note: (base.note ? base.note + '; ' : '') + 'eventstore1147: event coins in the balance' };
    }
    if (c.method === 'POST' && pathname === '/reconcile') {
      const base = next(c), p = session(c.req);
      if (!p || !base || !base.json || typeof base.json !== 'object' || !base.json.balances) return base;
      const j = clone(base.json); withCoins(j.balances, p);
      return { ...base, json: j, note: (base.note ? base.note + '; ' : '') + 'eventstore1147: event coins in the balance' };
    }
    const single = /^\/product\/sku\/(.+)$/.exec(pathname), token = /^\/token\/([^/]+)\/(.+)$/.exec(pathname);
    if (c.method === 'GET' && single && bySku.has(single[1])) { const p = session(c.req); return ok(publicOffer(bySku.get(single[1]), ownedSet(inventory(p)), !!p && !!character(p), p)); }
    if (c.method === 'GET' && token && bySku.has(token[2])) return issue(player(c.req), bySku.get(token[2]), token[1]);
    if (c.method === 'POST' && pathname.startsWith('/notification/')) {
      const t = [c.url.searchParams.get('token'), c.url.searchParams.get('purchaseToken'), c.body?.token, c.body?.purchaseToken].find((t) => typeof t === 'string' && t.startsWith(PREFIX));
      if (t) return redeem(player(c.req), t, pathname.slice('/notification/'.length));
    }
    return next(c);
  }
  return { handle };
}
module.exports = { create, offers, publicOffer };
