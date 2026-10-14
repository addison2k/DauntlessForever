"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACCOUNT_ID_RULE = exports.KeyRevocations = exports.ValidateMetagameJWTAndGetPayload = void 0;
exports.IsAccountIdShape = IsAccountIdShape;
exports.FindUsernameForUserId = FindUsernameForUserId;
exports.AddFriendshipListener = AddFriendshipListener;
exports.NotifyFriendship = NotifyFriendship;
exports.ListFriends = ListFriends;
exports.IsBlockedEitherWay = IsBlockedEitherWay;
exports.BlockersAmong = BlockersAmong;
exports.GetPartyOf = GetPartyOf;
exports.IsGuildMember = IsGuildMember;
exports.ParseOnOff = ParseOnOff;
exports.ChatPresence = ChatPresence;
exports.ClientAddressOf = ClientAddressOf;
exports.IsTrustedGatewayRequest = IsTrustedGatewayRequest;
// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
//
// compat.ts - what the chat server (chat.ts, muc.ts, presence.ts: taken from Dauntless Revived,
// github.com/mixutin/dauntless-revived, AGPL-3.0) expects from the rest of the metagame, answered from
// this backend: accounts from the users table, friends/blocks/parties from controllers/social162.ts.
// There is no gateway here: the game connects straight to the metagame's port (61000), on this PC or
// through the Dauntless Forever relay.
const node_events_1 = require("node:events");
const node_net_1 = __importDefault(require("node:net"));
const drizzle_orm_1 = require("drizzle-orm");
const db_1 = require("../db");
const schema_1 = require("../db/schema");
const social162_1 = require("../controllers/social162");
var auth_1 = require("../controllers/auth");
Object.defineProperty(exports, "ValidateMetagameJWTAndGetPayload", { enumerable: true, get: function () { return auth_1.ValidateMetagameJWTAndGetPayload; } });
// ---- key revocation (Revived rotates player keys; nothing here does yet)
exports.KeyRevocations = new node_events_1.EventEmitter();
// ---- accounts
exports.ACCOUNT_ID_RULE = /^[A-Za-z0-9_-]{1,64}$/;
function IsAccountIdShape(Value) {
    return typeof Value === "string" && exports.ACCOUNT_ID_RULE.test(Value);
}
// The chat server asks for names synchronously; better-sqlite3 answers synchronously.
function FindUsernameForUserId(UserId) {
    if (!IsAccountIdShape(UserId))
        return undefined;
    try {
        const Row = (0, db_1.GetDb)().select({ name: schema_1.users.name }).from(schema_1.users).where((0, drizzle_orm_1.eq)(schema_1.users.userId, UserId)).get();
        return Row?.name;
    }
    catch {
        return undefined;
    }
}
const FriendshipListeners = new Set();
function AddFriendshipListener(Listener) {
    FriendshipListeners.add(Listener);
    return () => { FriendshipListeners.delete(Listener); };
}
// social162 can call this when a friendship starts or ends, so online friends update without a relog
function NotifyFriendship(Event) {
    for (const Listener of FriendshipListeners) {
        try {
            Listener(Event);
        }
        catch { /* a listener never breaks the caller */ }
    }
}
function ListFriends(AccountId, IncludePending) {
    return (0, social162_1.FriendList)(AccountId).filter((F) => F.status === "ACCEPTED" || (IncludePending && F.status === "PENDING"));
}
function IsBlockedEitherWay(A, B) { return (0, social162_1.IsBlockedEitherWay)(A, B); }
function BlockersAmong(Sender, Recipients) {
    return new Set([...new Set(Recipients)].filter((Id) => Id !== Sender && (0, social162_1.BlockList)(Id).includes(Sender)));
}
function GetPartyOf(UserId) { return (0, social162_1.GetPartyOf)(UserId); }
// Guilds are not stored by this backend yet: guild rooms admit nobody
function IsGuildMember(_AccountId, _GuildId) { return false; }
// ---- switches
function ParseOnOff(Raw) {
    const Value = Raw.toLowerCase();
    if (["1", "true", "on", "yes"].includes(Value))
        return true;
    if (["0", "false", "off", "no"].includes(Value))
        return false;
    return undefined;
}
function ChatPresence() {
    return ParseOnOff((process.env.CHAT_PRESENCE ?? "").trim()) ?? true;
}
// ---- where a connection comes from (no gateway: always the TCP peer)
function ClientAddressOf(req) {
    const Raw = req.socket?.remoteAddress;
    if (typeof Raw !== "string")
        return "unknown";
    const Plain = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(Raw)?.[1] ?? Raw;
    return node_net_1.default.isIP(Plain) !== 0 ? Plain.toLowerCase() : "unknown";
}
function IsTrustedGatewayRequest(_req) { return false; }
