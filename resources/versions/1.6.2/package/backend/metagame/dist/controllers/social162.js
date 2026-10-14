// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LAST_CANDIDATE_REJOIN_MS = exports.MAX_PARTY_SIZE = exports.IsAccountId = void 0;
exports.FindUsername = FindUsername;
exports.FindAccountByName = FindAccountByName;
exports.FindUsernames = FindUsernames;
exports.IsBlockedEitherWay = IsBlockedEitherWay;
exports.FriendList = FriendList;
exports.BlockList = BlockList;
exports.AddFriend = AddFriend;
exports.RemoveFriend = RemoveFriend;
exports.Block = Block;
exports.Unblock = Unblock;
exports.Touch = Touch;
exports.GetPartyOf = GetPartyOf;
exports.PartyReply = PartyReply;
exports.PollParty = PollParty;
exports.ListInvites = ListInvites;
exports.InviteToParty = InviteToParty;
exports.AcceptInvite = AcceptInvite;
exports.DeclineInvites = DeclineInvites;
exports.DropInvitesBetween = DropInvitesBetween;
exports.LeaveParty = LeaveParty;
exports.KickMember = KickMember;
exports.PromoteMember = PromoteMember;
exports.EvictLeader = EvictLeader;
exports.PartiesOf = PartiesOf;
exports.PartyForMatchmaking = PartyForMatchmaking;
exports.SetCandidate = SetCandidate;
exports.MarkCandidateReady = MarkCandidateReady;
exports.ClearCandidate = ClearCandidate;
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
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const drizzle_orm_1 = require("drizzle-orm");
const db_1 = require("../db");
const schema_1 = require("../db/schema");
const logger_1 = require("../logger");
// ------------------------------------------------------------------ accounts
const IsAccountId = (Value) => typeof Value === "string" && /^UID-[0-9a-fA-F-]{8,64}$/.test(Value);
exports.IsAccountId = IsAccountId;
async function FindUsername(UserId) {
    if (!(0, exports.IsAccountId)(UserId))
        return undefined;
    const Row = await (0, db_1.GetDb)().query.users.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.users.userId, UserId) });
    return Row?.name;
}
async function FindAccountByName(Name) {
    if (typeof Name !== "string" || Name.length === 0 || Name.length > 64)
        return undefined;
    const Wanted = Name.trim().toLowerCase();
    const All = await (0, db_1.GetDb)().query.users.findMany();
    const Row = All.find((U) => U.name.toLowerCase() === Wanted);
    return Row ? { UserId: Row.userId, Username: Row.name } : undefined;
}
async function FindUsernames(Ids) {
    const Out = new Map();
    for (const Id of new Set(Ids)) {
        const Name = await FindUsername(Id);
        if (Name !== undefined)
            Out.set(Id, Name);
    }
    return Out;
}
async function NameOr(UserId) {
    return (await FindUsername(UserId)) ?? "Slayer";
}
const MAX_FRIENDS = 200, MAX_BLOCKS = 200;
let Store;
function StoreFile() {
    const Db = process.env.DB_FILENAME || "./data/undaunted.db";
    return node_path_1.default.join(node_path_1.default.dirname(Db), "friends.json");
}
function LoadStore() {
    if (Store)
        return Store;
    try {
        const Raw = JSON.parse(node_fs_1.default.readFileSync(StoreFile(), "utf8"));
        Store = { friends: Raw.friends ?? {}, blocks: Raw.blocks ?? {} };
    }
    catch {
        Store = { friends: {}, blocks: {} };
    }
    return Store;
}
function SaveStore() {
    try {
        const File = StoreFile();
        node_fs_1.default.writeFileSync(File + ".tmp", JSON.stringify(LoadStore()));
        node_fs_1.default.renameSync(File + ".tmp", File);
    }
    catch (e) {
        logger_1.logger.error(`friends: could not save friends.json: ${e.message}`);
    }
}
function IsBlockedEitherWay(A, B) {
    const S = LoadStore();
    return (S.blocks[A] ?? []).includes(B) || (S.blocks[B] ?? []).includes(A);
}
function FriendList(UserId) {
    const Mine = LoadStore().friends[UserId] ?? {};
    return Object.entries(Mine).map(([Other, Link]) => ({ accountId: Other, status: Link.status, direction: Link.direction, created: Link.created }));
}
function BlockList(UserId) {
    return LoadStore().blocks[UserId] ?? [];
}
// POST friends/<me>/<other>: a new request, or accepting the other's request
async function AddFriend(Me, Other) {
    if (Me === Other || !(await FindUsername(Other)))
        return 404;
    if (IsBlockedEitherWay(Me, Other))
        return 403;
    const S = LoadStore();
    const Mine = (S.friends[Me] ??= {});
    const Theirs = (S.friends[Other] ??= {});
    const Now = new Date().toISOString();
    const Existing = Mine[Other];
    if (Existing?.status === "ACCEPTED")
        return 204;
    if (Existing?.status === "PENDING" && Existing.direction === "INBOUND") {
        Mine[Other] = { status: "ACCEPTED", direction: "INBOUND", created: Existing.created };
        Theirs[Me] = { status: "ACCEPTED", direction: "OUTBOUND", created: Theirs[Me]?.created ?? Now };
        logger_1.logger.info(`friends: ${Me} accepted ${Other}`);
    }
    else {
        if (Object.keys(Mine).length >= MAX_FRIENDS || Object.keys(Theirs).length >= MAX_FRIENDS)
            return 409;
        Mine[Other] = { status: "PENDING", direction: "OUTBOUND", created: Now };
        Theirs[Me] = { status: "PENDING", direction: "INBOUND", created: Now };
        logger_1.logger.info(`friends: ${Me} sent a friend request to ${Other}`);
    }
    SaveStore();
    return 204;
}
function RemoveFriend(Me, Other) {
    const S = LoadStore();
    if (S.friends[Me])
        delete S.friends[Me][Other];
    if (S.friends[Other])
        delete S.friends[Other][Me];
    SaveStore();
    logger_1.logger.info(`friends: ${Me} removed or declined ${Other}`);
}
function Block(Me, Other) {
    if (Me === Other)
        return;
    const S = LoadStore();
    const List = (S.blocks[Me] ??= []);
    if (!List.includes(Other) && List.length < MAX_BLOCKS)
        List.push(Other);
    RemoveFriend(Me, Other);
    DropInvitesBetween(Me, Other);
    SaveStore();
}
function Unblock(Me, Other) {
    const S = LoadStore();
    S.blocks[Me] = (S.blocks[Me] ?? []).filter((Id) => Id !== Other);
    SaveStore();
}
// ------------------------------------------------------------------ parties
exports.MAX_PARTY_SIZE = 4;
const INVITE_TTL_MS = 5 * 60 * 1000;
const MEMBER_TIMEOUT_MS = 180 * 1000;
const CANDIDATE_LINGER_MS = 60 * 1000; // a started hunt stays in the party poll this long
exports.LAST_CANDIDATE_REJOIN_MS = 15 * 60 * 1000;
const IDLE_PARTY_MS = 30 * 60 * 1000;
const MAX_INVITES_PER_SENDER = 20, INVITE_WINDOW_MS = 10 * 60 * 1000, DECLINE_COOLDOWN_MS = 2 * 60 * 1000;
const Parties = new Map();
const PartyOfUser = new Map();
const InvitesTo = new Map();
const LastSeen = new Map();
const SentTimes = new Map();
const Declined = new Map(); // "<sender>|<recipient>" -> when
let LastSweep = 0;
function Touch(UserId) { LastSeen.set(UserId, Date.now()); }
function GetPartyOf(UserId) {
    const Id = PartyOfUser.get(UserId);
    return Id === undefined ? undefined : Parties.get(Id);
}
function NewSoloParty(UserId) {
    const P = { PartyId: node_crypto_1.default.randomUUID(), LeaderId: UserId, Members: [UserId], CreatedAt: Date.now(), Candidate: null, LastCandidate: null };
    Parties.set(P.PartyId, P);
    PartyOfUser.set(UserId, P.PartyId);
    return P;
}
function EnsureParty(UserId) {
    return GetPartyOf(UserId) ?? NewSoloParty(UserId);
}
function RemoveMember(P, UserId, Why) {
    if (!P.Members.includes(UserId))
        return;
    P.Members = P.Members.filter((M) => M !== UserId);
    if (PartyOfUser.get(UserId) === P.PartyId)
        PartyOfUser.delete(UserId);
    for (const C of [P.Candidate, P.LastCandidate])
        if (C)
            C.MemberIds = C.MemberIds.filter((M) => M !== UserId);
    if (P.Members.length === 0) {
        Parties.delete(P.PartyId);
        for (const [R, L] of InvitesTo)
            InvitesTo.set(R, L.filter((I) => I.PartyId !== P.PartyId));
    }
    else if (P.LeaderId === UserId) {
        P.LeaderId = P.Members[0];
    }
    logger_1.logger.info(`party: ${UserId} left P=${P.PartyId} (${Why}); now ${P.Members.length} member(s), leader ${P.LeaderId}`);
}
function InHuntLoad(P, Member) {
    const C = P.Candidate ?? P.LastCandidate;
    return C !== null && C.MemberIds.includes(Member) && Date.now() - (C.ReadyAt ?? C.CreatedAt) < 5 * 60 * 1000;
}
function Sweep() {
    const Now = Date.now();
    if (Now - LastSweep < 5000)
        return;
    LastSweep = Now;
    for (const P of [...Parties.values()]) {
        if (P.Members.length > 1) {
            for (const M of [...P.Members]) {
                const Seen = LastSeen.get(M) ?? 0;
                if (Now - Seen > MEMBER_TIMEOUT_MS && !InHuntLoad(P, M))
                    RemoveMember(P, M, `not heard from for ${Math.round((Now - Seen) / 1000)} s`);
            }
        }
        else if (Now - (LastSeen.get(P.Members[0]) ?? P.CreatedAt) > IDLE_PARTY_MS) {
            RemoveMember(P, P.Members[0], "idle");
        }
        if (P.Candidate && P.Candidate.State === "IN_PROGRESS" && Now - (P.Candidate.ReadyAt ?? Now) > CANDIDATE_LINGER_MS) {
            P.LastCandidate = P.Candidate;
            P.Candidate = null;
        }
        if (P.Candidate && P.Candidate.State === "MATCHING" && Now - P.Candidate.CreatedAt > 3 * 60 * 1000) {
            logger_1.logger.warn(`party: candidate ${P.Candidate.CandidateId} of P=${P.PartyId} never got a server; dropped`);
            P.Candidate = null;
        }
    }
    for (const [R, L] of InvitesTo) {
        const Live = L.filter((I) => Now - I.CreatedAt < INVITE_TTL_MS && Parties.has(I.PartyId));
        if (Live.length)
            InvitesTo.set(R, Live);
        else
            InvitesTo.delete(R);
    }
}
// The solo reply is exactly what the old stub answered (the game was happy with it), unless
// PARTY_SOLO_STUB=0: then a party of one has no candidate (reads as idle).
async function PartyReply(P) {
    const Names = await Promise.all(P.Members.map(NameOr));
    if (P.Members.length === 1 && process.env.PARTY_SOLO_STUB !== "0" && P.Candidate === null) {
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
async function PollParty(UserId) {
    Touch(UserId);
    Sweep();
    return PartyReply(EnsureParty(UserId));
}
function ListInvites(UserId) {
    Touch(UserId);
    Sweep();
    const L = (InvitesTo.get(UserId) ?? []).filter((I) => !IsBlockedEitherWay(I.Sender, UserId));
    return {
        invitations: L.map((I) => ({ recipientPlayerId: I.Recipient, sendingPlayerId: I.Sender, partyId: I.PartyId, sendingPlatform: "win", sendingDisplayName: I.SenderName }))
    };
}
async function InviteToParty(Caller, Recipient) {
    Touch(Caller);
    if (!(0, exports.IsAccountId)(Recipient) || Recipient === Caller || !(await FindUsername(Recipient)))
        return { Status: 404, Body: {} };
    if (IsBlockedEitherWay(Caller, Recipient))
        return { Status: 403, Body: {} };
    const P = EnsureParty(Caller);
    if (P.LeaderId !== Caller)
        return { Status: 403, Body: {} };
    if (P.Members.includes(Recipient))
        return { Status: 200, Body: await PartyReply(P) };
    if (P.Members.length >= exports.MAX_PARTY_SIZE)
        return { Status: 409, Body: {} };
    const Now = Date.now();
    const Recent = (SentTimes.get(Caller) ?? []).filter((T) => Now - T < INVITE_WINDOW_MS);
    if (Recent.length >= MAX_INVITES_PER_SENDER)
        return { Status: 409, Body: {} };
    if (Now - (Declined.get(`${Caller}|${Recipient}`) ?? 0) < DECLINE_COOLDOWN_MS)
        return { Status: 409, Body: {} };
    Recent.push(Now);
    SentTimes.set(Caller, Recent);
    const L = (InvitesTo.get(Recipient) ?? []).filter((I) => !(I.Sender === Caller));
    L.push({ PartyId: P.PartyId, Sender: Caller, Recipient, SenderName: await NameOr(Caller), CreatedAt: Now });
    InvitesTo.set(Recipient, L.slice(-10));
    logger_1.logger.info(`party: ${Caller} invited ${Recipient} to P=${P.PartyId}`);
    return { Status: 200, Body: await PartyReply(P) };
}
// The id in the URL is the party's id (the game sends the invite's partyId); a sender's id is accepted too
async function AcceptInvite(Caller, Id) {
    Touch(Caller);
    Sweep();
    const L = InvitesTo.get(Caller) ?? [];
    const Inv = L.find((I) => I.PartyId === Id) ?? L.find((I) => I.Sender === Id) ?? (L.length === 1 ? L[0] : undefined);
    if (!Inv) {
        // a repeated accept: answer the party the caller is already in with that id
        const Mine = GetPartyOf(Caller);
        if (Mine && Mine.Members.length > 1 && (Mine.PartyId === Id || Mine.Members.includes(String(Id))))
            return { Status: 200, Body: await PartyReply(Mine) };
        return { Status: 404, Body: {} };
    }
    const Target = Parties.get(Inv.PartyId);
    if (!Target) {
        InvitesTo.set(Caller, L.filter((I) => I !== Inv));
        return { Status: 404, Body: {} };
    }
    if (Target.Members.length >= exports.MAX_PARTY_SIZE)
        return { Status: 409, Body: {} };
    const Old = GetPartyOf(Caller);
    if (Old && Old !== Target)
        RemoveMember(Old, Caller, "joined another party");
    if (!Target.Members.includes(Caller))
        Target.Members.push(Caller);
    PartyOfUser.set(Caller, Target.PartyId);
    InvitesTo.set(Caller, L.filter((I) => I.PartyId !== Target.PartyId));
    logger_1.logger.info(`party: ${Caller} joined P=${Target.PartyId} (leader ${Target.LeaderId}); ${Target.Members.length} member(s)`);
    return { Status: 200, Body: await PartyReply(Target) };
}
function DeclineInvites(Caller, Body) {
    Touch(Caller);
    const Sender = Body?.sendingPlayerId, Recipient = Body?.recipientPlayerId, PartyId = Body?.partyId;
    if (Recipient === Caller || Recipient === undefined) {
        // declining invites sent to me
        const L = InvitesTo.get(Caller) ?? [];
        const Gone = L.filter((I) => (Sender === undefined || I.Sender === Sender) && (PartyId === undefined || I.PartyId === PartyId));
        for (const I of Gone)
            Declined.set(`${I.Sender}|${Caller}`, Date.now());
        InvitesTo.set(Caller, L.filter((I) => !Gone.includes(I)));
    }
    else if ((0, exports.IsAccountId)(Recipient)) {
        // withdrawing my own invite
        InvitesTo.set(Recipient, (InvitesTo.get(Recipient) ?? []).filter((I) => I.Sender !== Caller));
    }
    return { Status: 200, Body: {} };
}
function DropInvitesBetween(A, B) {
    for (const [R, S] of [[A, B], [B, A]])
        InvitesTo.set(R, (InvitesTo.get(R) ?? []).filter((I) => I.Sender !== S));
}
function LeaveParty(Caller) {
    Touch(Caller);
    const P = GetPartyOf(Caller);
    if (P && P.Members.length > 1)
        RemoveMember(P, Caller, "left");
    return { Status: 200, Body: {} };
}
function KickMember(Caller, Member) {
    const P = GetPartyOf(Caller);
    if (!P || P.LeaderId !== Caller || !P.Members.includes(Member) || Member === Caller)
        return { Status: 403, Body: {} };
    RemoveMember(P, Member, `kicked by ${Caller}`);
    return { Status: 200, Body: {} };
}
function PromoteMember(Caller, Member) {
    const P = GetPartyOf(Caller);
    if (!P || P.LeaderId !== Caller || !P.Members.includes(Member))
        return { Status: 403, Body: {} };
    P.LeaderId = Member;
    logger_1.logger.info(`party: ${Caller} made ${Member} leader of P=${P.PartyId}`);
    return { Status: 200, Body: {} };
}
// The game's own "the leader seems offline" eviction: only honoured when we have not heard from them either
function EvictLeader(Caller, LeaderId) {
    const P = GetPartyOf(Caller);
    if (!P || P.LeaderId !== LeaderId || !P.Members.includes(Caller))
        return { Status: 403, Body: {} };
    if (Date.now() - (LastSeen.get(LeaderId) ?? 0) < 60 * 1000)
        return { Status: 409, Body: {} };
    RemoveMember(P, LeaderId, `evicted as offline by ${Caller}`);
    return { Status: 200, Body: {} };
}
async function PartiesOf(Caller, Ids) {
    Touch(Caller);
    const List = Array.isArray(Ids) ? Ids.filter(exports.IsAccountId).slice(0, 16) : [];
    const Seen = new Set();
    const Out = [];
    for (const Id of List) {
        const P = GetPartyOf(Id);
        if (P && P.Members.length > 1 && !Seen.has(P.PartyId)) {
            Seen.add(P.PartyId);
            Out.push(await PartyReply(P));
        }
    }
    return { Status: 200, Body: { parties: Out, invitations: ListInvites(Caller).invitations } };
}
// ------------------------------------------------------------------ for matchmaking
function PartyForMatchmaking(UserId) {
    Sweep();
    const P = GetPartyOf(UserId);
    return P && P.Members.length > 1 ? P : undefined;
}
function SetCandidate(P, C) { P.Candidate = C; }
function MarkCandidateReady(P, CandidateId, Host, Port) {
    const C = P.Candidate?.CandidateId === CandidateId ? P.Candidate : null;
    if (!C)
        return;
    C.State = "IN_PROGRESS";
    C.Host = Host;
    C.Port = Port;
    C.ReadyAt = Date.now();
    P.LastCandidate = C;
}
function ClearCandidate(P, CandidateId, Why) {
    if (P.Candidate?.CandidateId === CandidateId) {
        logger_1.logger.info(`party: candidate ${CandidateId} of P=${P.PartyId} cleared (${Why})`);
        P.Candidate = null;
    }
}
