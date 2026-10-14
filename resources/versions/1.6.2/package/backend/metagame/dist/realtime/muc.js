"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MucService = exports.MESSAGE_BURST = exports.JOIN_BURST = exports.MAX_NICK_BYTES = exports.MAX_ROOMS = exports.MAX_OCCUPANTS = exports.MAX_ROOMS_PER_SESSION = void 0;
exports.RoomClassOf = RoomClassOf;
exports.FullJid = FullJid;
exports.BodyLength = BodyLength;
exports.TakeMessageToken = TakeMessageToken;
const logger_1 = require("../logger");
const chatnick_1 = require("./chatnick");
const xmpp_1 = require("./xmpp");
// Chat rooms (multi-user chat) the way the 1.4.4 client needs them (docs/findings/chat.md, "Rooms").
// Read from the game's executable (image base 0x140000000):
//
// - A room presence is the client's only if it comes from exactly "muc." + its domain (0x143a379d2).
// - Each occupant is known by the nickname it joined with: the client splits it at ":" into the name
//   (part 1, URL-decoded) and the account id (part 2), and takes the member id from <item jid> when it is
//   there (0x1408fe300, 0x1408c3500). A message is matched to its sender through that occupant's
//   presence (0x1408a83c0); without one the sender shows as "[unknown]".
// - The joiner's own presence (its account id is in the nickname, 0x143a34acd) completes the join
//   (0x143a296b0); an error presence for a pending join drops the room cleanly and reports a failed
//   join (0x143a34d80). Its own unavailable presence completes a leave (0x143a28180).
//
// So: every nickname is kept byte for byte and echoed in every "from"; every occupant presence carries
// <item jid>; occupants learn about each other in both directions; every message goes back to its sender
// too; and a refused join is an error presence, never a rewritten nickname. Two sessions of one account
// never see each other in a room: the client's self test would take the other one's presence for its own.
//
// One account is in a room with one session at most. The client keeps one room member per account id
// (UpdateMember 0x1408fe300 finds it by id and updates it, 0x1408fe3d4-0x1408fe409) and removes it by
// the account id in a leaving nickname (OnXmppRoomMemberExit 0x1408c0680: 0x1408c07a9 -> 0x1408c3500,
// TMap::Remove 0x1408c0b54 -> 0x1408e1ce0). So when a reconnected session joins a room its old session
// (a ghost of the dropped connection) is still in, the old one leaves first (reason "replaced", not told
// to the old session itself); otherwise the ghost's later leave would remove the member the new session
// had just updated, and the others would see that player's lines as "[unknown]".
//
// Who may join (docs/findings/chat.md, "Rooms"): the client names its rooms itself (builders 0x141568c20,
// 0x1415669e0, 0x1415ad14f, 0x1415bb270). City-<id>, Hunt-<id> and General<id> are open to every signed-in
// player; Party-<partyId> only to that party's members and Guild-<guildId> only to that guild's; anything
// else is refused. Membership is checked at the join, at every message (sender and recipients) and every
// 60 s; a player who lost it is removed from the room (status 307). Room messages skip recipients who
// blocked the sender.
exports.MAX_ROOMS_PER_SESSION = 8;
exports.MAX_OCCUPANTS = 128;
exports.MAX_ROOMS = 1000;
exports.MAX_NICK_BYTES = 1023;
const JOIN_BURST = 10;
exports.JOIN_BURST = JOIN_BURST;
const JOIN_REFILL_MS = 6 * 1000;
const MESSAGE_BURST = 8;
exports.MESSAGE_BURST = MESSAGE_BURST;
const MESSAGE_REFILL_MS = 1000;
const BODY_LIMIT = 2048;
const MAX_ID = 128;
// The class of a room by its local part, exactly as the client builds it (case included), or undefined
function RoomClassOf(Local) {
    const Match = /^(City-|Hunt-|General|Party-|Guild-)([A-Za-z0-9-]*)$/.exec(Local);
    if (Match === null || Match[2].length > 64 || (Match[1] !== "General" && Match[2].length === 0)) {
        return undefined;
    }
    const Class = Match[1] === "City-" || Match[1] === "Hunt-" ? "zone" : Match[1] === "General" ? "general" : Match[1] === "Party-" ? "party" : "guild";
    return { Class, Id: Match[2] };
}
const ERRORS = {
    "nick-account": { Type: "auth", Condition: "forbidden" },
    "nick-resource": { Type: "auth", Condition: "forbidden" },
    "nick-format": { Type: "auth", Condition: "forbidden" },
    "nick-name": { Type: "auth", Condition: "forbidden" },
    "not-member": { Type: "auth", Condition: "forbidden" },
    "not-allowed": { Type: "cancel", Condition: "not-allowed" },
    "conflict": { Type: "cancel", Condition: "conflict" },
    "limit": { Type: "wait", Condition: "service-unavailable" }
};
function FullJid(Session) {
    return `${Session.Uid}@${Session.Domain}/${Session.Resource}`;
}
function BodyLength(Body) {
    return [...Body].length;
}
function TakeMessageToken(Session, Now) {
    return (0, xmpp_1.TakeToken)(Session.Messages, MESSAGE_BURST, MESSAGE_REFILL_MS, Now);
}
class MucService {
    rooms = new Map();
    host;
    constructor(Host) {
        this.host = Host;
    }
    get RoomCount() {
        return this.rooms.size;
    }
    // ---- Stanzas ----
    occupantPresence(Room, Nick, Occupant, To, Options = {}) {
        const Statuses = `${Options.Self ? `<status code="110"/>` : ""}${Options.Evicted ? `<status code="307"/>` : ""}`;
        return `<presence xmlns="${xmpp_1.NS.CLIENT}"${Options.Unavailable ? ` type="unavailable"` : ""} from="${(0, xmpp_1.EscapeXml)(`${Room.Jid}/${Nick}`)}" to="${(0, xmpp_1.EscapeXml)(FullJid(To))}">`
            + `<x xmlns="${xmpp_1.NS.MUC_USER}"><item affiliation="none" role="${Options.Unavailable ? "none" : "participant"}" jid="${(0, xmpp_1.EscapeXml)(FullJid(Occupant))}"/>${Statuses}</x></presence>`;
    }
    // A refused join: the error presence, one log line per session, room class and reason every 10 minutes
    // (never keyed on the client's own text), and one dropped stanza toward the session's abuse limit
    refuse(Session, RoomJid, Local, Nick, Reason) {
        const Error_ = ERRORS[Reason];
        if (this.host.LogOnce(`join-refused|${Session.Id}|${RoomClassOf(Local)?.Class ?? "other"}|${Reason}`)) {
            logger_1.logger.info(`chat: join refused room=${(0, xmpp_1.LogText)(Local)} uid=${Session.Uid} reason=${Reason}`);
        }
        this.host.Send(Session, `<presence xmlns="${xmpp_1.NS.CLIENT}" type="error" from="${(0, xmpp_1.EscapeXml)(`${RoomJid}/${Nick}`)}" to="${(0, xmpp_1.EscapeXml)(FullJid(Session))}">`
            + `<x xmlns="${xmpp_1.NS.MUC}"/><error type="${Error_.Type}"><${Error_.Condition} xmlns="${xmpp_1.NS.STANZAS}"/></error></presence>`);
        this.host.Refused(Session);
    }
    messageError(Session, RoomJid, Id) {
        this.host.Send(Session, `<message xmlns="${xmpp_1.NS.CLIENT}" type="error"${Id !== undefined ? ` id="${(0, xmpp_1.EscapeXml)(Id)}"` : ""} from="${(0, xmpp_1.EscapeXml)(RoomJid)}" to="${(0, xmpp_1.EscapeXml)(FullJid(Session))}">`
            + `<error type="modify"><not-acceptable xmlns="${xmpp_1.NS.STANZAS}"/></error></message>`);
    }
    // ---- Joins and leaves ----
    IsMucDomain(Session, Domain) {
        const Actual = Domain.toLowerCase();
        const AccountDomain = Session.Domain.toLowerCase();
        // 1.4.4 normally uses muc.<domain>, but live clients have also emitted the
        // legacy conference.<domain> alias. Both identify the same authenticated
        // room service; never accept an alias for a different account domain.
        return Actual === `muc.${AccountDomain}` || Actual === `conference.${AccountDomain}`;
    }
    Join(Session, To) {
        const Uid = Session.Uid;
        const Nick = To.Resource ?? "";
        const RoomJid = `${To.Local}@${To.Domain}`;
        const Now = this.host.Clock();
        // Every join takes a token first, refused ones included
        if (!(0, xmpp_1.TakeToken)(Session.Joins, JOIN_BURST, JOIN_REFILL_MS, Now)) {
            this.refuse(Session, RoomJid, To.Local, Nick, "limit");
            return;
        }
        const Kind = RoomClassOf(To.Local);
        if (!this.IsMucDomain(Session, To.Domain) || Kind === undefined) {
            this.refuse(Session, RoomJid, To.Local, Nick, "not-allowed");
            return;
        }
        const Existing = this.rooms.get(RoomJid);
        const Held = Session.Rooms.get(RoomJid);
        // Party and guild rooms: members only (someone who left is also removed from the room)
        if (!this.mayUse(Uid, Kind.Class, Kind.Id)) {
            if (Existing !== undefined && Held !== undefined) {
                this.remove(Session, Existing, "evicted");
            }
            this.refuse(Session, RoomJid, To.Local, Nick, "not-member");
            return;
        }
        // Rejoin with the same nickname: this session alone gets the room again, nobody else hears of it
        if (Existing !== undefined && Held === Nick) {
            this.welcome(Session, Existing, Nick);
            logger_1.logger.info(`chat: join room=${To.Local} uid=${Uid} name=${(0, chatnick_1.NamePartOf)(Nick) ?? "?"} occupants=${this.others(Existing, Session).length} rejoin`);
            return;
        }
        if (Nick.length === 0 || Buffer.byteLength(Nick, "utf8") > exports.MAX_NICK_BYTES) {
            this.refuse(Session, RoomJid, To.Local, Nick, "nick-format");
            return;
        }
        const Check = (0, chatnick_1.CheckNickname)(Nick, Uid, Session.Resource, [this.host.UsernameOf(Uid), Session.NameAtLogin]);
        // CHAT_NICK_CHECK=log relaxes the resource, format and name rules only. Another account's id is
        // refused in both modes: a real client always builds its nickname from its own id (0x1408b5aeb).
        if (!Check.Ok) {
            if (this.host.NickCheck === "enforce" || Check.Reason === "nick-account") {
                this.refuse(Session, RoomJid, To.Local, Nick, Check.Reason);
                return;
            }
            if (this.host.LogOnce(`nick-log|${Session.Id}|${To.Local}`)) {
                logger_1.logger.warn(`chat: join nickname not checked room=${To.Local} uid=${Uid} reason=${Check.Reason} (CHAT_NICK_CHECK=log)`);
            }
        }
        // A different nickname in a room this session is already in: leave with the old one first
        if (Existing !== undefined && Held !== undefined) {
            this.remove(Session, Existing, "left");
        }
        const Room = this.rooms.get(RoomJid);
        // The occupants of other accounts. An older session of this account is replaced below, so it
        // neither conflicts nor counts toward the room's limit.
        const OtherAccounts = [...(Room?.Occupants ?? [])].filter(([Other]) => Other !== Session && Other.Uid !== Uid);
        if (OtherAccounts.some(([, OtherNick]) => OtherNick === Nick)) {
            this.refuse(Session, RoomJid, To.Local, Nick, "conflict");
            return;
        }
        if (Session.Rooms.size >= exports.MAX_ROOMS_PER_SESSION || OtherAccounts.length >= exports.MAX_OCCUPANTS || (Room === undefined && this.rooms.size >= exports.MAX_ROOMS)) {
            this.refuse(Session, RoomJid, To.Local, Nick, "limit");
            return;
        }
        const Joined = Room ?? { Jid: RoomJid, Local: To.Local, Class: Kind.Class, ClassId: Kind.Id, Occupants: new Map() };
        // 0. This account's older session in the room (normally the ghost of a dropped connection) leaves
        // first, told to the others but not to itself (see the top of this file)
        for (const Other of [...Joined.Occupants.keys()]) {
            if (Other !== Session && Other.Uid === Uid) {
                this.remove(Other, Joined, "replaced");
            }
        }
        const Others = this.others(Joined, Session);
        this.rooms.set(RoomJid, Joined);
        // 1. The joiner hears of everyone already there; 2. they hear of the joiner; 3. the joiner's own
        // presence last, which completes the join on its screen
        for (const [Other, OtherNick] of Others) {
            this.host.Send(Session, this.occupantPresence(Joined, OtherNick, Other, Session));
        }
        for (const [Other] of Others) {
            this.host.Send(Other, this.occupantPresence(Joined, Nick, Session, Other));
        }
        Joined.Occupants.set(Session, Nick);
        Session.Rooms.set(RoomJid, Nick);
        this.host.Send(Session, this.occupantPresence(Joined, Nick, Session, Session, { Self: true }));
        logger_1.logger.info(`chat: join room=${To.Local} uid=${Uid} name=${Check.Ok ? Check.Name : ((0, chatnick_1.NamePartOf)(Nick) ?? "?")} occupants=${Others.length}`);
    }
    mayUse(Uid, Class, Id) {
        switch (Class) {
            case "party": return this.host.Access.PartyIdOf(Uid) === Id;
            case "guild": return this.host.Access.IsGuildMember(Uid, Id);
            default: return true;
        }
    }
    stillAllowed(Session, Room) {
        return Session.Uid !== undefined && this.mayUse(Session.Uid, Room.Class, Room.ClassId);
    }
    // Party and guild rooms: anyone who left the party or guild (a kick, a stale client) is removed. The
    // client normally leaves by itself when its party or guild changes (0x1415ad136, 0x1415bb270).
    Sweep() {
        for (const Room of [...this.rooms.values()]) {
            if (Room.Class !== "party" && Room.Class !== "guild") {
                continue;
            }
            for (const Occupant of [...Room.Occupants.keys()]) {
                if (!this.stillAllowed(Occupant, Room)) {
                    this.remove(Occupant, Room, "evicted");
                }
            }
        }
    }
    // Everyone in the room this session may see: not the session itself, not its own account's others
    others(Room, Session) {
        return [...Room.Occupants].filter(([Other]) => Other !== Session && Other.Uid !== Session.Uid);
    }
    welcome(Session, Room, Nick) {
        for (const [Other, OtherNick] of this.others(Room, Session)) {
            this.host.Send(Session, this.occupantPresence(Room, OtherNick, Other, Session));
        }
        this.host.Send(Session, this.occupantPresence(Room, Nick, Session, Session, { Self: true }));
    }
    Leave(Session, To) {
        const RoomJid = `${To.Local}@${To.Domain}`;
        const Room = this.rooms.get(RoomJid);
        if (Room === undefined || !Room.Occupants.has(Session)) {
            // Not in it (after a refused join, or a restart of the metagame): confirm the leave anyway, so the
            // client's room does not stay waiting for it
            if (this.IsMucDomain(Session, To.Domain) && To.Resource !== undefined && To.Resource.length > 0) {
                this.host.Send(Session, `<presence xmlns="${xmpp_1.NS.CLIENT}" type="unavailable" from="${(0, xmpp_1.EscapeXml)(`${RoomJid}/${To.Resource}`)}" to="${(0, xmpp_1.EscapeXml)(FullJid(Session))}">`
                    + `<x xmlns="${xmpp_1.NS.MUC_USER}"><item affiliation="none" role="none" jid="${(0, xmpp_1.EscapeXml)(FullJid(Session))}"/><status code="110"/></x></presence>`);
            }
            return;
        }
        this.remove(Session, Room, "left");
    }
    // A broadcast unavailable, or the end of the session
    LeaveAll(Session, Reason) {
        for (const RoomJid of [...Session.Rooms.keys()]) {
            const Room = this.rooms.get(RoomJid);
            if (Room !== undefined) {
                this.remove(Session, Room, Reason);
            }
        }
        Session.Rooms.clear();
    }
    remove(Session, Room, Reason) {
        const Nick = Room.Occupants.get(Session);
        if (Nick === undefined) {
            return;
        }
        const Evicted = Reason === "evicted";
        for (const [Other] of this.others(Room, Session)) {
            this.host.Send(Other, this.occupantPresence(Room, Nick, Session, Other, { Unavailable: true, Evicted }));
        }
        Room.Occupants.delete(Session);
        Session.Rooms.delete(Room.Jid);
        if (!Session.Ended && (Reason === "left" || Reason === "evicted")) {
            this.host.Send(Session, this.occupantPresence(Room, Nick, Session, Session, { Unavailable: true, Self: true, Evicted }));
        }
        if (Room.Occupants.size === 0) {
            this.rooms.delete(Room.Jid);
        }
        logger_1.logger.info(`chat: leave room=${Room.Local} uid=${Session.Uid} reason=${Reason}`);
    }
    // ---- Room messages ----
    GroupChat(Session, To, Node) {
        const RoomJid = `${To.Local}@${To.Domain}`;
        const IdAttr = typeof Node.attrs.id === "string" ? Node.attrs.id : undefined;
        const Id = IdAttr !== undefined && IdAttr.length <= MAX_ID ? IdAttr : undefined;
        const BodyNode = (0, xmpp_1.ChildNamed)(Node, "body");
        // A subject change alone is ignored
        if (BodyNode === undefined && (0, xmpp_1.ChildNamed)(Node, "subject") !== undefined) {
            return;
        }
        const Room = this.rooms.get(RoomJid);
        const Nick = Room?.Occupants.get(Session);
        const Body = (0, xmpp_1.TextOf)(BodyNode);
        const Length = BodyLength(Body);
        if (Room === undefined || Nick === undefined || Length === 0 || Length > BODY_LIMIT) {
            this.messageError(Session, RoomJid, Id);
            return;
        }
        if (!this.stillAllowed(Session, Room)) {
            this.messageError(Session, RoomJid, Id);
            this.remove(Session, Room, "evicted");
            return;
        }
        if (!TakeMessageToken(Session, this.host.Clock())) {
            if (this.host.LogOnce(`message-rate|${Session.Id}`, 60 * 1000)) {
                logger_1.logger.warn(`chat: message limit c=${Session.Id} uid=${Session.Uid} room=${Room.Local}`);
            }
            this.messageError(Session, RoomJid, Id);
            return;
        }
        const From = (0, xmpp_1.EscapeXml)(`${Room.Jid}/${Nick}`);
        const Text = (0, xmpp_1.EscapeXml)(Body);
        const Recipients = [...Room.Occupants.keys()].filter((Recipient) => Recipient === Session || Recipient.Uid !== Session.Uid);
        const Blockers = this.host.Access.BlockersAmong(Session.Uid, Recipients.map((Recipient) => Recipient.Uid));
        let Delivered = 0;
        let Blocked = 0;
        for (const Recipient of Recipients) {
            // A recipient who left the party or guild is removed instead of served
            if (Recipient !== Session && !this.stillAllowed(Recipient, Room)) {
                this.remove(Recipient, Room, "evicted");
                continue;
            }
            if (Blockers.has(Recipient.Uid)) {
                Blocked++;
                continue;
            }
            this.host.Send(Recipient, `<message xmlns="${xmpp_1.NS.CLIENT}" type="groupchat"${Id !== undefined ? ` id="${(0, xmpp_1.EscapeXml)(Id)}"` : ""} from="${From}" to="${(0, xmpp_1.EscapeXml)(FullJid(Recipient))}"><body>${Text}</body></message>`);
            Delivered++;
        }
        logger_1.logger.info(`chat: message room=${Room.Local} uid=${Session.Uid} len=${Length} to=${Delivered}${Blocked > 0 ? ` blocked=${Blocked}` : ""}`);
    }
    // Dauntless Forever (DF-ONLINE-1): a line from the server to everyone in chat (the host closing the game, say).
    // Each player gets it once: in the zone room they are in (city or hunt), else in another room they are in.
    Announce(Text) {
        const Body = (0, xmpp_1.EscapeXml)(String(Text).slice(0, 300));
        const Rank = (Room) => { const K = RoomClassOf(Room.Local); return K === undefined ? 9 : K.Class === "zone" ? 0 : K.Class === "general" ? 1 : K.Class === "party" ? 2 : 3; };
        const Done = new Set();
        let Sent = 0;
        for (const Room of [...this.rooms.values()].sort((A, B) => Rank(A) - Rank(B))) {
            const From = (0, xmpp_1.EscapeXml)(`${Room.Jid}/Server`);
            for (const Recipient of Room.Occupants.keys()) {
                if (Done.has(Recipient))
                    continue;
                Done.add(Recipient);
                this.host.Send(Recipient, `<message xmlns="${xmpp_1.NS.CLIENT}" type="groupchat" from="${From}" to="${(0, xmpp_1.EscapeXml)(FullJid(Recipient))}"><body>${Body}</body></message>`);
                Sent++;
            }
        }
        logger_1.logger.info(`chat: announcement to ${Sent} player(s)`);
        return Sent;
    }
}
exports.MucService = MucService;
