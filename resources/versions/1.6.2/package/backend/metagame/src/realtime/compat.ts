// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
//
// compat.ts - what the chat server (chat.ts, muc.ts, presence.ts: taken from Dauntless Revived,
// github.com/mixutin/dauntless-revived, AGPL-3.0) expects from the rest of the metagame, answered from
// this backend: accounts from the users table, friends/blocks/parties from controllers/social162.ts.
// There is no gateway here: the game connects straight to the metagame's port (61000), on this PC or
// through the Dauntless Forever relay.
import { EventEmitter } from "node:events";
import net from "node:net";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import { GetDb } from "../db";
import { users } from "../db/schema";
import { BlockList, FriendList, GetPartyOf as PartyOf, IsBlockedEitherWay as Blocked } from "../controllers/social162";

export { ValidateMetagameJWTAndGetPayload } from "../controllers/auth";

// ---- key revocation (Revived rotates player keys; nothing here does yet)
export const KeyRevocations = new EventEmitter();

// ---- accounts
export const ACCOUNT_ID_RULE = /^[A-Za-z0-9_-]{1,64}$/;
export function IsAccountIdShape(Value: unknown): Value is string {
    return typeof Value === "string" && ACCOUNT_ID_RULE.test(Value);
}

// The chat server asks for names synchronously; better-sqlite3 answers synchronously.
export function FindUsernameForUserId(UserId: string): string | undefined {
    if(!IsAccountIdShape(UserId)) return undefined;
    try {
        const Row = GetDb().select({ name: users.name }).from(users).where(eq(users.userId, UserId)).get();
        return Row?.name;
    } catch {
        return undefined;
    }
}

// ---- friends, blocks, parties, guilds
export type FriendshipEvent =
    | { Kind: "accepted", Requester: string, Accepter: string, CreatedAt: number }
    | { Kind: "ended", A: string, B: string, Why: "removed" | "blocked" };

const FriendshipListeners = new Set<(Event: FriendshipEvent) => void>();
export function AddFriendshipListener(Listener: (Event: FriendshipEvent) => void): () => void {
    FriendshipListeners.add(Listener);
    return () => { FriendshipListeners.delete(Listener); };
}
// social162 can call this when a friendship starts or ends, so online friends update without a relog
export function NotifyFriendship(Event: FriendshipEvent){
    for(const Listener of FriendshipListeners){
        try { Listener(Event); } catch { /* a listener never breaks the caller */ }
    }
}

export function ListFriends(AccountId: string, IncludePending: boolean){
    return FriendList(AccountId).filter((F) => F.status === "ACCEPTED" || (IncludePending && F.status === "PENDING"));
}
export function IsBlockedEitherWay(A: string, B: string){ return Blocked(A, B); }
export function BlockersAmong(Sender: string, Recipients: string[]): Set<string> {
    return new Set([...new Set(Recipients)].filter((Id) => Id !== Sender && BlockList(Id).includes(Sender)));
}
export function GetPartyOf(UserId: string){ return PartyOf(UserId); }
// Guilds are not stored by this backend yet: guild rooms admit nobody
export function IsGuildMember(_AccountId: string, _GuildId: string): boolean { return false; }

// ---- switches
export function ParseOnOff(Raw: string): boolean | undefined {
    const Value = Raw.toLowerCase();
    if(["1", "true", "on", "yes"].includes(Value)) return true;
    if(["0", "false", "off", "no"].includes(Value)) return false;
    return undefined;
}
export function ChatPresence(): boolean {
    return ParseOnOff((process.env.CHAT_PRESENCE ?? "").trim()) ?? true;
}

// ---- where a connection comes from (no gateway: always the TCP peer)
export function ClientAddressOf(req: Request){
    const Raw = req.socket?.remoteAddress;
    if(typeof Raw !== "string") return "unknown";
    const Plain = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(Raw)?.[1] ?? Raw;
    return net.isIP(Plain) !== 0 ? Plain.toLowerCase() : "unknown";
}
export function IsTrustedGatewayRequest(_req: Request){ return false; }
