// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Party and friends behaviour follows the findings of Dauntless Revived (AGPL-3.0, UndauntedMetagame
// controllers/party.ts and docs/findings/social.md), simplified for this backend.
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
//
// Accounts, friends and parties for playing together.
//
// - On this server one id (UID-...) is at the same time the Epic id, the Phoenix id and the chat id,
//   so every id mapping is the identity.
// - Friends and blocks are kept in friends.json next to the database. The game reads the lists only at
//   login, so a new friend shows up after the next login.
// - Parties live in memory, like matchmaking: every member's game polls POST /party and GET /party/invites
//   about every 10 s, and a backend restart leaves everyone in a party of one, which the game accepts.
// - When the party leader starts a hunt, the whole party gets one "candidate" (one game server); the
//   members' games see it in their party poll and follow (controllers/matchmaking.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { GetDb } from "../db";
import { users } from "../db/schema";
import { logger } from "../logger";

// ------------------------------------------------------------------ accounts
export const IsAccountId = (Value: unknown): Value is string =>
    typeof Value === "string" && /^UID-[0-9a-fA-F-]{8,64}$/.test(Value);

export async function FindUsername(UserId: unknown): Promise<string | undefined> {
    if(!IsAccountId(UserId)) return undefined;
    const Row = await GetDb().query.users.findFirst({ where: eq(users.userId, UserId) });
    return Row?.name;
}

export async function FindAccountByName(Name: unknown): Promise<{ UserId: string, Username: string } | undefined> {
    if(typeof Name !== "string" || Name.length === 0 || Name.length > 64) return undefined;
    const Wanted = Name.trim().toLowerCase();
    const All = await GetDb().query.users.findMany();
    const Row = All.find((U) => U.name.toLowerCase() === Wanted);
    return Row ? { UserId: Row.userId, Username: Row.name } : undefined;
}

export async function FindUsernames(Ids: string[]): Promise<Map<string, string>> {
    const Out = new Map<string, string>();
    for(const Id of new Set(Ids)){
        const Name = await FindUsername(Id);
        if(Name !== undefined) Out.set(Id, Name);
    }
    return Out;
}

async function NameOr(UserId: string){
    return (await FindUsername(UserId)) ?? "Slayer";
}

// ------------------------------------------------------------------ friends (friends.json)
type FriendLink = { status: "ACCEPTED" | "PENDING", direction: "INBOUND" | "OUTBOUND", created: string };
type FriendStore = { friends: Record<string, Record<string, FriendLink>>, blocks: Record<string, string[]> };
const MAX_FRIENDS = 200, MAX_BLOCKS = 200;

let Store: FriendStore | undefined;
function StoreFile(){
    const Db = process.env.DB_FILENAME || "./data/undaunted.db";
    return path.join(path.dirname(Db), "friends.json");
}
function LoadStore(): FriendStore {
    if(Store) return Store;
    try {
        const Raw = JSON.parse(fs.readFileSync(StoreFile(), "utf8"));
        Store = { friends: Raw.friends ?? {}, blocks: Raw.blocks ?? {} };
    } catch {
        Store = { friends: {}, blocks: {} };
    }
    return Store;
}
function SaveStore(){
    try {
        const File = StoreFile();
        fs.writeFileSync(File + ".tmp", JSON.stringify(LoadStore()));
        fs.renameSync(File + ".tmp", File);
    } catch (e) {
        logger.error(`friends: could not save friends.json: ${(e as Error).message}`);
    }
}

export function IsBlockedEitherWay(A: string, B: string){
    const S = LoadStore();
    return (S.blocks[A] ?? []).includes(B) || (S.blocks[B] ?? []).includes(A);
}

export function FriendList(UserId: string){
    const Mine = LoadStore().friends[UserId] ?? {};
    return Object.entries(Mine).map(([Other, Link]) => ({ accountId: Other, status: Link.status, direction: Link.direction, created: Link.created }));
}

export function BlockList(UserId: string){
    return LoadStore().blocks[UserId] ?? [];
}

// POST friends/<me>/<other>: a new request, or accepting the other's request
export async function AddFriend(Me: string, Other: string): Promise<number> {
    if(Me === Other || !(await FindUsername(Other))) return 404;
    if(IsBlockedEitherWay(Me, Other)) return 403;
    const S = LoadStore();
    const Mine = (S.friends[Me] ??= {});
    const Theirs = (S.friends[Other] ??= {});
    const Now = new Date().toISOString();
    const Existing = Mine[Other];
    if(Existing?.status === "ACCEPTED") return 204;
    if(Existing?.status === "PENDING" && Existing.direction === "INBOUND"){
        Mine[Other] = { status: "ACCEPTED", direction: "INBOUND", created: Existing.created };
        Theirs[Me] = { status: "ACCEPTED", direction: "OUTBOUND", created: Theirs[Me]?.created ?? Now };
        logger.info(`friends: ${Me} accepted ${Other}`);
    } else {
        if(Object.keys(Mine).length >= MAX_FRIENDS || Object.keys(Theirs).length >= MAX_FRIENDS) return 409;
        Mine[Other] = { status: "PENDING", direction: "OUTBOUND", created: Now };
        Theirs[Me] = { status: "PENDING", direction: "INBOUND", created: Now };
        logger.info(`friends: ${Me} sent a friend request to ${Other}`);
    }
    SaveStore();
    return 204;
}

export function RemoveFriend(Me: string, Other: string){
    const S = LoadStore();
    if(S.friends[Me]) delete S.friends[Me][Other];
    if(S.friends[Other]) delete S.friends[Other][Me];
    SaveStore();
    logger.info(`friends: ${Me} removed or declined ${Other}`);
}

export function Block(Me: string, Other: string){
    if(Me === Other) return;
    const S = LoadStore();
    const List = (S.blocks[Me] ??= []);
    if(!List.includes(Other) && List.length < MAX_BLOCKS) List.push(Other);
    RemoveFriend(Me, Other);
    DropInvitesBetween(Me, Other);
    SaveStore();
}

export function Unblock(Me: string, Other: string){
    const S = LoadStore();
    S.blocks[Me] = (S.blocks[Me] ?? []).filter((Id) => Id !== Other);
    SaveStore();
}

// ------------------------------------------------------------------ parties
export const MAX_PARTY_SIZE = 4;
const INVITE_TTL_MS = 5 * 60 * 1000;
const MEMBER_TIMEOUT_MS = 180 * 1000;
const CANDIDATE_LINGER_MS = 60 * 1000;          // a started hunt stays in the party poll this long
export const LAST_CANDIDATE_REJOIN_MS = 15 * 60 * 1000;
const IDLE_PARTY_MS = 30 * 60 * 1000;
const MAX_INVITES_PER_SENDER = 20, INVITE_WINDOW_MS = 10 * 60 * 1000, DECLINE_COOLDOWN_MS = 2 * 60 * 1000;

export type PartyCandidate = {
    CandidateId: string,
    State: "MATCHING" | "IN_PROGRESS",
    GameMode: string,
    HuntId: string,
    MemberIds: string[],
    Host?: string,
    Port?: number,
    CreatedAt: number,
    ReadyAt?: number
};

export type Party = {
    PartyId: string,
    LeaderId: string,
    Members: string[],
    CreatedAt: number,
    Candidate: PartyCandidate | null,
    LastCandidate: PartyCandidate | null
};

type Invite = { PartyId: string, Sender: string, Recipient: string, SenderName: string, CreatedAt: number };
export type PartyResult = { Status: number, Body: unknown };

const Parties = new Map<string, Party>();
const PartyOfUser = new Map<string, string>();
const InvitesTo = new Map<string, Invite[]>();
const LastSeen = new Map<string, number>();
const SentTimes = new Map<string, number[]>();
const Declined = new Map<string, number>();     // "<sender>|<recipient>" -> when
let LastSweep = 0;

export function Touch(UserId: string){ LastSeen.set(UserId, Date.now()); }

export function GetPartyOf(UserId: string): Party | undefined {
    const Id = PartyOfUser.get(UserId);
    return Id === undefined ? undefined : Parties.get(Id);
}

function NewSoloParty(UserId: string): Party {
    const P: Party = { PartyId: crypto.randomUUID(), LeaderId: UserId, Members: [UserId], CreatedAt: Date.now(), Candidate: null, LastCandidate: null };
    Parties.set(P.PartyId, P);
    PartyOfUser.set(UserId, P.PartyId);
    return P;
}

function EnsureParty(UserId: string): Party {
    return GetPartyOf(UserId) ?? NewSoloParty(UserId);
}

function RemoveMember(P: Party, UserId: string, Why: string){
    if(!P.Members.includes(UserId)) return;
    P.Members = P.Members.filter((M) => M !== UserId);
    if(PartyOfUser.get(UserId) === P.PartyId) PartyOfUser.delete(UserId);
    for(const C of [P.Candidate, P.LastCandidate]) if(C) C.MemberIds = C.MemberIds.filter((M) => M !== UserId);
    if(P.Members.length === 0){
        Parties.delete(P.PartyId);
        for(const [R, L] of InvitesTo) InvitesTo.set(R, L.filter((I) => I.PartyId !== P.PartyId));
    } else if(P.LeaderId === UserId){
        P.LeaderId = P.Members[0];
    }
    logger.info(`party: ${UserId} left P=${P.PartyId} (${Why}); now ${P.Members.length} member(s), leader ${P.LeaderId}`);
}

function InHuntLoad(P: Party, Member: string){
    const C = P.Candidate ?? P.LastCandidate;
    return C !== null && C.MemberIds.includes(Member) && Date.now() - (C.ReadyAt ?? C.CreatedAt) < 5 * 60 * 1000;
}

function Sweep(){
    const Now = Date.now();
    if(Now - LastSweep < 5000) return;
    LastSweep = Now;
    for(const P of [...Parties.values()]){
        if(P.Members.length > 1){
            for(const M of [...P.Members]){
                const Seen = LastSeen.get(M) ?? 0;
                if(Now - Seen > MEMBER_TIMEOUT_MS && !InHuntLoad(P, M)) RemoveMember(P, M, `not heard from for ${Math.round((Now - Seen) / 1000)} s`);
            }
        } else if(Now - (LastSeen.get(P.Members[0]) ?? P.CreatedAt) > IDLE_PARTY_MS){
            RemoveMember(P, P.Members[0], "idle");
        }
        if(P.Candidate && P.Candidate.State === "IN_PROGRESS" && Now - (P.Candidate.ReadyAt ?? Now) > CANDIDATE_LINGER_MS){
            P.LastCandidate = P.Candidate;
            P.Candidate = null;
        }
        if(P.Candidate && P.Candidate.State === "MATCHING" && Now - P.Candidate.CreatedAt > 3 * 60 * 1000){
            logger.warn(`party: candidate ${P.Candidate.CandidateId} of P=${P.PartyId} never got a server; dropped`);
            P.Candidate = null;
        }
    }
    for(const [R, L] of InvitesTo){
        const Live = L.filter((I) => Now - I.CreatedAt < INVITE_TTL_MS && Parties.has(I.PartyId));
        if(Live.length) InvitesTo.set(R, Live); else InvitesTo.delete(R);
    }
}

// The solo reply is exactly what the old stub answered (the game was happy with it), unless
// PARTY_SOLO_STUB=0: then a party of one has no candidate (reads as idle).
export async function PartyReply(P: Party){
    const Names = await Promise.all(P.Members.map(NameOr));
    if(P.Members.length === 1 && process.env.PARTY_SOLO_STUB !== "0" && P.Candidate === null){
        return {
            candidateId: "CANDIDATE_ID_LOL",
            candidateState: "QUEUED_FOR_START",
            gauntletLevel: null,
            leaderPlayerId: P.LeaderId,
            partyId: P.PartyId,
            playerHuntId: null,
            playerStates: [{ consoleSessionId: null, displayName: Names[0], isMemberOfCandidate: true, platform: "win", playerId: P.Members[0] }]
        };
    }
    const C = P.Candidate;
    return {
        partyId: P.PartyId,
        leaderPlayerId: P.LeaderId,
        playerIds: [...P.Members],
        playerStates: P.Members.map((M, I) => ({
            playerId: M, isMemberOfCandidate: C !== null && C.MemberIds.includes(M), platform: "win", displayName: Names[I], consoleSessionId: null
        })),
        candidateState: C?.State ?? null,
        candidateId: C?.CandidateId ?? null,
        playerHuntId: C?.HuntId ?? null,
        gauntletLevel: null
    };
}

export async function PollParty(UserId: string){
    Touch(UserId);
    Sweep();
    return PartyReply(EnsureParty(UserId));
}

export function ListInvites(UserId: string){
    Touch(UserId);
    Sweep();
    const L = (InvitesTo.get(UserId) ?? []).filter((I) => !IsBlockedEitherWay(I.Sender, UserId));
    return {
        invitations: L.map((I) => ({ recipientPlayerId: I.Recipient, sendingPlayerId: I.Sender, partyId: I.PartyId, sendingPlatform: "win", sendingDisplayName: I.SenderName }))
    };
}

export async function InviteToParty(Caller: string, Recipient: unknown): Promise<PartyResult> {
    Touch(Caller);
    if(!IsAccountId(Recipient) || Recipient === Caller || !(await FindUsername(Recipient))) return { Status: 404, Body: {} };
    if(IsBlockedEitherWay(Caller, Recipient)) return { Status: 403, Body: {} };
    const P = EnsureParty(Caller);
    if(P.LeaderId !== Caller) return { Status: 403, Body: {} };
    if(P.Members.includes(Recipient)) return { Status: 200, Body: await PartyReply(P) };
    if(P.Members.length >= MAX_PARTY_SIZE) return { Status: 409, Body: {} };
    const Now = Date.now();
    const Recent = (SentTimes.get(Caller) ?? []).filter((T) => Now - T < INVITE_WINDOW_MS);
    if(Recent.length >= MAX_INVITES_PER_SENDER) return { Status: 409, Body: {} };
    if(Now - (Declined.get(`${Caller}|${Recipient}`) ?? 0) < DECLINE_COOLDOWN_MS) return { Status: 409, Body: {} };
    Recent.push(Now); SentTimes.set(Caller, Recent);
    const L = (InvitesTo.get(Recipient) ?? []).filter((I) => !(I.Sender === Caller));
    L.push({ PartyId: P.PartyId, Sender: Caller, Recipient, SenderName: await NameOr(Caller), CreatedAt: Now });
    InvitesTo.set(Recipient, L.slice(-10));
    logger.info(`party: ${Caller} invited ${Recipient} to P=${P.PartyId}`);
    return { Status: 200, Body: await PartyReply(P) };
}

// The id in the URL is the party's id (the game sends the invite's partyId); a sender's id is accepted too
export async function AcceptInvite(Caller: string, Id: unknown): Promise<PartyResult> {
    Touch(Caller);
    Sweep();
    const L = InvitesTo.get(Caller) ?? [];
    const Inv = L.find((I) => I.PartyId === Id) ?? L.find((I) => I.Sender === Id) ?? (L.length === 1 ? L[0] : undefined);
    if(!Inv){
        // a repeated accept: answer the party the caller is already in with that id
        const Mine = GetPartyOf(Caller);
        if(Mine && Mine.Members.length > 1 && (Mine.PartyId === Id || Mine.Members.includes(String(Id)))) return { Status: 200, Body: await PartyReply(Mine) };
        return { Status: 404, Body: {} };
    }
    const Target = Parties.get(Inv.PartyId);
    if(!Target){ InvitesTo.set(Caller, L.filter((I) => I !== Inv)); return { Status: 404, Body: {} }; }
    if(Target.Members.length >= MAX_PARTY_SIZE) return { Status: 409, Body: {} };
    const Old = GetPartyOf(Caller);
    if(Old && Old !== Target) RemoveMember(Old, Caller, "joined another party");
    if(!Target.Members.includes(Caller)) Target.Members.push(Caller);
    PartyOfUser.set(Caller, Target.PartyId);
    InvitesTo.set(Caller, L.filter((I) => I.PartyId !== Target.PartyId));
    logger.info(`party: ${Caller} joined P=${Target.PartyId} (leader ${Target.LeaderId}); ${Target.Members.length} member(s)`);
    return { Status: 200, Body: await PartyReply(Target) };
}

export function DeclineInvites(Caller: string, Body: any): PartyResult {
    Touch(Caller);
    const Sender = Body?.sendingPlayerId, Recipient = Body?.recipientPlayerId, PartyId = Body?.partyId;
    if(Recipient === Caller || Recipient === undefined){
        // declining invites sent to me
        const L = InvitesTo.get(Caller) ?? [];
        const Gone = L.filter((I) => (Sender === undefined || I.Sender === Sender) && (PartyId === undefined || I.PartyId === PartyId));
        for(const I of Gone) Declined.set(`${I.Sender}|${Caller}`, Date.now());
        InvitesTo.set(Caller, L.filter((I) => !Gone.includes(I)));
    } else if(IsAccountId(Recipient)){
        // withdrawing my own invite
        InvitesTo.set(Recipient, (InvitesTo.get(Recipient) ?? []).filter((I) => I.Sender !== Caller));
    }
    return { Status: 200, Body: {} };
}

export function DropInvitesBetween(A: string, B: string){
    for(const [R, S] of [[A, B], [B, A]]) InvitesTo.set(R, (InvitesTo.get(R) ?? []).filter((I) => I.Sender !== S));
}

export function LeaveParty(Caller: string): PartyResult {
    Touch(Caller);
    const P = GetPartyOf(Caller);
    if(P && P.Members.length > 1) RemoveMember(P, Caller, "left");
    return { Status: 200, Body: {} };
}

export function KickMember(Caller: string, Member: string): PartyResult {
    const P = GetPartyOf(Caller);
    if(!P || P.LeaderId !== Caller || !P.Members.includes(Member) || Member === Caller) return { Status: 403, Body: {} };
    RemoveMember(P, Member, `kicked by ${Caller}`);
    return { Status: 200, Body: {} };
}

export function PromoteMember(Caller: string, Member: string): PartyResult {
    const P = GetPartyOf(Caller);
    if(!P || P.LeaderId !== Caller || !P.Members.includes(Member)) return { Status: 403, Body: {} };
    P.LeaderId = Member;
    logger.info(`party: ${Caller} made ${Member} leader of P=${P.PartyId}`);
    return { Status: 200, Body: {} };
}

// The game's own "the leader seems offline" eviction: only honoured when we have not heard from them either
export function EvictLeader(Caller: string, LeaderId: string): PartyResult {
    const P = GetPartyOf(Caller);
    if(!P || P.LeaderId !== LeaderId || !P.Members.includes(Caller)) return { Status: 403, Body: {} };
    if(Date.now() - (LastSeen.get(LeaderId) ?? 0) < 60 * 1000) return { Status: 409, Body: {} };
    RemoveMember(P, LeaderId, `evicted as offline by ${Caller}`);
    return { Status: 200, Body: {} };
}

export async function PartiesOf(Caller: string, Ids: unknown): Promise<PartyResult> {
    Touch(Caller);
    const List = Array.isArray(Ids) ? Ids.filter(IsAccountId).slice(0, 16) : [];
    const Seen = new Set<string>();
    const Out = [];
    for(const Id of List){
        const P = GetPartyOf(Id);
        if(P && P.Members.length > 1 && !Seen.has(P.PartyId)){ Seen.add(P.PartyId); Out.push(await PartyReply(P)); }
    }
    return { Status: 200, Body: { parties: Out, invitations: ListInvites(Caller).invitations } };
}

// ------------------------------------------------------------------ for matchmaking
export function PartyForMatchmaking(UserId: string): Party | undefined {
    Sweep();
    const P = GetPartyOf(UserId);
    return P && P.Members.length > 1 ? P : undefined;
}

export function SetCandidate(P: Party, C: PartyCandidate){ P.Candidate = C; }

export function MarkCandidateReady(P: Party, CandidateId: string, Host: string, Port: number){
    const C = P.Candidate?.CandidateId === CandidateId ? P.Candidate : null;
    if(!C) return;
    C.State = "IN_PROGRESS"; C.Host = Host; C.Port = Port; C.ReadyAt = Date.now();
    P.LastCandidate = C;
}

export function ClearCandidate(P: Party, CandidateId: string, Why: string){
    if(P.Candidate?.CandidateId === CandidateId){
        logger.info(`party: candidate ${CandidateId} of P=${P.PartyId} cleared (${Why})`);
        P.Candidate = null;
    }
}
