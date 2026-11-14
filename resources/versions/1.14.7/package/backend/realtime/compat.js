// Dauntless Forever - Dauntless 1.14.7 offline backend
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
//
// compat.js (DF-CHAT-1147) - what the chat server (chat.js, muc.js, presence.js: from Dauntless Revived,
// github.com/mixutin/dauntless-revived, AGPL-3.0, by way of the 1.6.2 package) expects from the backend,
// answered from recorder-1147.js: accounts and names from state.players, parties from the party service.
// The recorder calls bind() once with its lookups. 1.14.7 keeps no friends or blocks yet: empty.
'use strict';
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const net = require('node:net');

let B = null;   // { playerByAccount(id) -> player|null, accountFromToken(token) -> accountId|null, partyIdOf(accountId) -> id|null }
function bind(lookups) { B = lookups; }

const KeyRevocations = new EventEmitter();
const ACCOUNT_ID_RULE = /^[A-Za-z0-9_-]{1,64}$/;
function IsAccountIdShape(v) { return typeof v === 'string' && ACCOUNT_ID_RULE.test(v); }

// The game logs in to chat with SASL PLAIN: its account id and a token it already holds. Accepted: a session
// token this backend handed out (PUT /gamesession), or the sign-in token whose account is that id.
function ValidateMetagameJWTAndGetPayload(token) {
  const id = B && B.accountFromToken(String(token || ''));
  if (!id) { const e = new Error('not a token of this backend'); e.name = 'JsonWebTokenError'; throw e; }
  return { userId: id };
}
function FindUsernameForUserId(id) {
  if (!IsAccountIdShape(id) || !B) return undefined;
  const p = B.playerByAccount(id);
  return p ? (p.username || 'Slayer') : undefined;
}
const FriendshipListeners = new Set();
function AddFriendshipListener(l) { FriendshipListeners.add(l); return () => FriendshipListeners.delete(l); }
function NotifyFriendship(ev) { for (const l of FriendshipListeners) { try { l(ev); } catch (e) { /* never breaks the caller */ } } }
function ListFriends() { return []; }
function IsBlockedEitherWay() { return false; }
function BlockersAmong() { return new Set(); }
function GetPartyOf(id) { const p = B && B.partyIdOf(id); return p ? { PartyId: p } : undefined; }
function IsGuildMember() { return false; }   // no guilds here: guild rooms admit nobody

function ParseOnOff(raw) {
  const v = String(raw || '').toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(v)) return true;
  if (['0', 'false', 'off', 'no'].includes(v)) return false;
  return undefined;
}
function ChatPresence() { return ParseOnOff((process.env.CHAT_PRESENCE || '').trim()) ?? false; }   // no friends store: off
function ClientAddressOf(req) {
  const raw = req.socket && req.socket.remoteAddress;
  if (typeof raw !== 'string') return 'unknown';
  const plain = (/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(raw) || [])[1] || raw;
  return net.isIP(plain) !== 0 ? plain.toLowerCase() : 'unknown';
}
function IsTrustedGatewayRequest() { return false; }

// Bidirectional per-process stand-in ID mapping (real sign-in UID <-> 32-hex public stand-in).
// Keeps real Epic/sign-in UIDs private on the wire while letting whispers, invites, and account lookups resolve cleanly.
const HEX32_RE = /^[0-9a-fA-F]{32}$/;
let standInSecret = crypto.randomBytes(32);
const realToStandIn = new Map();
const standInToReal = new Map();

function canonicalUidKey(uid) {
  const s = typeof uid === 'string' ? uid.trim() : '';
  if (!s || !IsAccountIdShape(s)) return '';
  return HEX32_RE.test(s) ? s.toLowerCase() : s;
}

function StandInFor(uid) {
  const key = canonicalUidKey(uid);
  if (!key) return '';
  const existing = realToStandIn.get(key);
  if (existing) return existing;
  let counter = 0;
  let standIn = '';
  do {
    const input = counter === 0 ? key : `${key}#${counter}`;
    standIn = crypto.createHmac('sha256', standInSecret).update(input).digest('hex').slice(0, 32);
    counter++;
  } while (
    standIn === key ||
    (standInToReal.has(standIn) && standInToReal.get(standIn) !== key) ||
    realToStandIn.has(standIn)
  );
  realToStandIn.set(key, standIn);
  standInToReal.set(standIn, key);
  return standIn;
}

function RealUidFor(standIn) {
  const s = typeof standIn === 'string' ? standIn.trim().toLowerCase() : '';
  if (!s || !HEX32_RE.test(s)) return null;
  return standInToReal.get(s) || null;
}

function replaceCaseInsensitive(haystack, needle, replacement) {
  if (!needle) return haystack;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return haystack.replace(new RegExp(escaped, 'gi'), replacement);
}

function MaskNickname(nick, uid, standIn) {
  const s = typeof nick === 'string' ? nick : '';
  const id = standIn || StandInFor(uid);
  if (!s || !uid || !id) return s;
  const colon = s.indexOf(':');
  let out = s;
  if (colon !== -1) {
    const prefix = s.slice(0, colon);
    const rest = s.slice(colon + 1);
    if (rest.slice(0, uid.length).toLowerCase() === uid.toLowerCase() && rest[uid.length] === ':') {
      out = `${prefix}:${id}${rest.slice(uid.length)}`;
    }
  }
  return replaceCaseInsensitive(out, uid, id);
}

function MaskJid(session, standIn) {
  const id = standIn || StandInFor(session && session.Uid);
  if (!session || !id) return '';
  return `${id}@${session.Domain}/${session.Resource}`;
}

function ScrubStanzaLeak(stanza, uid, standIn) {
  if (typeof stanza !== 'string' || !uid || uid.length < 6 || !standIn || uid.toLowerCase() === standIn.toLowerCase()) {
    return stanza;
  }
  if (!stanza.toLowerCase().includes(uid.toLowerCase())) return stanza;
  try {
    require('../logger').logger.warn('chat: privacy guard scrubbed unexpected real uid occurrence before send');
  } catch (e) { /* standalone unit tests without logger */ }
  return replaceCaseInsensitive(stanza, uid, standIn);
}

function ResetStandInsForTest(secret) {
  standInSecret = Buffer.isBuffer(secret) ? secret : crypto.randomBytes(32);
  realToStandIn.clear();
  standInToReal.clear();
}

module.exports = { bind, KeyRevocations, ACCOUNT_ID_RULE, IsAccountIdShape, ValidateMetagameJWTAndGetPayload, FindUsernameForUserId,
  AddFriendshipListener, NotifyFriendship, ListFriends, IsBlockedEitherWay, BlockersAmong, GetPartyOf, IsGuildMember,
  ParseOnOff, ChatPresence, ClientAddressOf, IsTrustedGatewayRequest,
  StandInFor, RealUidFor, MaskNickname, MaskJid, ScrubStanzaLeak, ResetStandInsForTest };
