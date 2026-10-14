// Dauntless Forever: taken unchanged from Dauntless Revived (github.com/mixutin/dauntless-revived, AGPL-3.0,
// UndauntedMetagame/src/realtime/presence.ts). Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
import { Element } from "ltx";
import type { FriendshipEvent } from "./compat";
import { logger } from "../logger";
import { Bucket, ChildNamed, EscapeXml, NS, TakeToken, TextOf } from "./xmpp";

// Friends' online status (CHAT_PRESENCE=1, with CHAT=1; docs/findings/chat.md). Harmonic's fork
// (github.com/Harmonicrain/Undaunted 895f7c7) had the idea of a presence service; this is written for our
// chat server and shares no code with that one. The 1.4.4 client never asks for a roster, never subscribes and
// never probes: it only knows what the server pushes (C:\dr\data\plans\chat\presence-friends.md, B), so:
//
// - A player's own broadcast presence (no "to") is relayed to every session of each ACCEPTED friend the
//   player has not blocked and is not blocked by, once that session has sent a presence of its own: <show>
//   and the <status> JSON exactly as the client sent them, from the player's FULL JID (the presence module
//   drops a sender without a resource, B 0x143a382b0). Every later change is relayed the same way.
// - At a session's first broadcast it gets the current presence of each friend who is online in that sense.
// - When a session ends (its <close/>, a ping timeout, a dropped socket, replacement) or broadcasts
//   type="unavailable", its friends get type="unavailable" from its full JID; if the account still has
//   another session with a presence, that presence follows, so the friend does not show as offline.
// - An accepted friend request (HTTP) pushes the client's friends-list message from xmpp-admin@<domain>
//   (FOnlineFriendsMcp::OnXmppMessageReceived 0x1408ba550 accepts only that sender) to both players, then
//   exchanges their presences; an unfriend or a block sends each the other's unavailable.
//
// The one rule that must never break: no stanza outside a room ever reaches a player from the player's own
// account, not even from a second session of it. The party's automatic kick of "offline" members only runs
// while the local player's own Phoenix presence is online (B 0x1415f7562), and the client's own presence
// arriving from the server is what could set it. Deliver() refuses such a stanza, and the chat tests check
// every stanza the server sends.
//
// A client that changes its presence too often has the changes held back (PRESENCE_BURST, then one per
// PRESENCE_REFILL_MS), and the latest state goes out at the next tick. That covers every change a session
// makes while it stays connected: its first presence, an unavailable broadcast and coming back after one
// too, so going offline and online in a loop cannot get past the limit. Only the end of a session is sent
// at once (it gets no more ticks). The friends lookup and the block checks run only when something is
// sent, and the block check only for friends who are online.

export const PRESENCE_BURST = 5;
export const PRESENCE_REFILL_MS = 2000;
// <status> is a short JSON object (about 250 characters from the real client); a longer one is not relayed
export const MAX_STATUS_LENGTH = 4096;
export const ADMIN_LOCAL = "xmpp-admin";
export const FRIEND_MESSAGE_TYPE = "com.epicgames.friends.core.apiobjects.Friend";
const SHOW_VALUES = new Set(["away", "chat", "dnd", "xa"]);

// What the client last broadcast: <show> (only the four values it writes) and <status>, as sent
export type ClientPresence = { Show?: string, Status?: string };

export type PresenceSession = {
    Id: number,
    Uid?: string,
    Domain: string,
    Resource?: string,
    Ended: boolean,
    // The client's latest broadcast (undefined: none yet, or it said unavailable). A session with one hears
    // its friends' changes.
    LastPresence?: ClientPresence,
    // What its friends were last told (undefined: offline to them). Differs from LastPresence while a
    // change is held back.
    Shown?: ClientPresence,
    // It was deaf for a while (it said unavailable): at its next announcement it hears of its friends again
    CatchUpDue?: boolean,
    PresenceTokens: Bucket,
    PresencePending: boolean
};

export type PresenceAccess = {
    // The account's ACCEPTED friends
    FriendsOf(Uid: string): string[],
    IsBlockedEitherWay(A: string, B: string): boolean
};

export type PresenceHost = {
    // The account's bound sessions
    SessionsOf(Uid: string): readonly PresenceSession[],
    // Every session
    Sessions(): Iterable<PresenceSession>,
    Send(Session: PresenceSession, Stanza: string): void,
    Clock(): number,
    LogOnce(Key: string, WindowMs?: number): boolean
};

function SameAccount(A: string | undefined, B: string | undefined){
    return A !== undefined && B !== undefined && A.toLowerCase() === B.toLowerCase();
}

function FullJidOf(Session: PresenceSession){
    return `${Session.Uid}@${Session.Domain}/${Session.Resource}`;
}

function IsOnline(Session: PresenceSession){
    return !Session.Ended && Session.Uid !== undefined && Session.Resource !== undefined;
}

// It sent a presence of its own and has not said unavailable since: it hears its friends' changes
function Listening(Session: PresenceSession){
    return Session.LastPresence !== undefined;
}

export class FriendPresence {
    private readonly host: PresenceHost;
    private readonly access: PresenceAccess;

    constructor(Host: PresenceHost, Access: PresenceAccess){
        this.host = Host;
        this.access = Access;
    }

    // ---- Who sees whom ----

    // The online sessions of the account's ACCEPTED friends who have not blocked it and are not blocked by
    // it. One friends lookup; the block check only for friends with a session online. Never one of the
    // account's own sessions.
    private friendSessions(Uid: string): PresenceSession[] {
        try{
            const Sessions: PresenceSession[] = [];

            for(const Friend of new Set(this.access.FriendsOf(Uid))){
                const Online = SameAccount(Friend, Uid) ? [] : this.host.SessionsOf(Friend).filter(IsOnline);

                if(Online.length > 0 && !this.access.IsBlockedEitherWay(Uid, Friend)){
                    Sessions.push(...Online);
                }
            }

            return Sessions;
        }
        catch(error){
            if(this.host.LogOnce(`presence-friends|${Uid}`, 60 * 1000)){
                logger.warn(error, `chat: presence: could not read the friends of ${Uid}; nothing relayed`);
            }

            return [];
        }
    }

    // Those who hear the account's changes: friends' sessions that sent a presence of their own (a session
    // that has not sent one yet hears of its friends when its own is announced)
    private audience(Uid: string): PresenceSession[] {
        return this.friendSessions(Uid).filter(Listening);
    }

    private listening(Uid: string): PresenceSession[] {
        return this.host.SessionsOf(Uid).filter((Each) => IsOnline(Each) && Listening(Each));
    }

    private shown(Uid: string): PresenceSession[] {
        return this.host.SessionsOf(Uid).filter((Each) => IsOnline(Each) && Each.Shown !== undefined);
    }

    // ---- Sending ----

    // Every stanza of this module goes through here: none reaches a session of the account it names as its sender
    private deliver(FromUid: string | undefined, To: PresenceSession, Stanza: string): void {
        if(FromUid === undefined || To.Uid === undefined || SameAccount(FromUid, To.Uid)){
            if(this.host.LogOnce(`presence-self|${To.Uid}`, 60 * 1000)){
                logger.error(`chat: presence: refused to send c=${To.Id} a stanza from its own account`);
            }

            return;
        }

        this.host.Send(To, Stanza);
    }

    // The presence friends were last told of (Shown)
    private presenceStanza(From: PresenceSession, To: PresenceSession): string {
        const Told = From.Shown ?? {};

        return `<presence xmlns="${NS.CLIENT}" from="${EscapeXml(FullJidOf(From))}" to="${EscapeXml(FullJidOf(To))}">`
            + (Told.Show !== undefined ? `<show>${Told.Show}</show>` : "")
            + (Told.Status !== undefined ? `<status>${EscapeXml(Told.Status)}</status>` : "")
            + `</presence>`;
    }

    private unavailableStanza(From: PresenceSession, To: PresenceSession): string {
        return `<presence xmlns="${NS.CLIENT}" type="unavailable" from="${EscapeXml(FullJidOf(From))}" to="${EscapeXml(FullJidOf(To))}"/>`;
    }

    // The friends-list push: {"type", "payload", "timestamp"} in the body of a plain message from xmpp-admin
    private friendMessage(To: PresenceSession, Other: string, Direction: "INBOUND" | "OUTBOUND", CreatedAt: number): string {
        const Now = new Date(this.host.Clock()).toISOString();
        const Body = JSON.stringify({
            type: FRIEND_MESSAGE_TYPE,
            payload: { accountId: Other, status: "ACCEPTED", direction: Direction, created: new Date(CreatedAt > 0 ? CreatedAt : this.host.Clock()).toISOString() },
            timestamp: Now
        });

        return `<message xmlns="${NS.CLIENT}" from="${ADMIN_LOCAL}@${EscapeXml(To.Domain)}" to="${EscapeXml(FullJidOf(To))}"><body>${EscapeXml(Body)}</body></message>`;
    }

    // ---- Announcing a session's state ----

    // A change of a session that stays connected: sent now if the session has a token left, else held back
    // for the tick (only the latest state is sent then)
    private announce(Session: PresenceSession): void {
        if(TakeToken(Session.PresenceTokens, PRESENCE_BURST, PRESENCE_REFILL_MS, this.host.Clock())){
            this.flush(Session);
        }
        else{
            Session.PresencePending = true;
        }
    }

    // Tells the session's friends what changed since they were last told (Shown -> LastPresence)
    private flush(Session: PresenceSession): void {
        const Now = Session.LastPresence;
        const Before = Session.Shown;

        Session.PresencePending = false;

        if(Now === undefined){
            if(Before !== undefined){
                this.wentOffline(Session, "unavailable");
            }

            return;
        }

        const Friends = this.friendSessions(Session.Uid!);
        const Audience = Friends.filter(Listening);
        let Heard = 0;

        // It hears of its friends who are online, as they are shown to everyone
        if(Before === undefined || Session.CatchUpDue === true){
            for(const Friend of Friends.filter((Each) => Each.Shown !== undefined)){
                this.deliver(Friend.Uid, Session, this.presenceStanza(Friend, Session));
                Heard++;
            }

            Session.CatchUpDue = false;
        }

        if(Before !== undefined && Before.Show === Now.Show && Before.Status === Now.Status){
            // Back to what its friends were last told (a change and its undoing, both held back)
            return;
        }

        Session.Shown = Now;

        for(const To of Audience){
            this.deliver(Session.Uid, To, this.presenceStanza(Session, To));
        }

        if(Before === undefined){
            logger.info(`chat: presence c=${Session.Id} uid=${Session.Uid} online: told ${Audience.length} friend session(s), heard of ${Heard}`);
        }
        else{
            logger.debug(`chat: presence c=${Session.Id} changed: relayed to ${Audience.length} friend session(s)`);
        }
    }

    // Its friends see it go; if the account has another session they were shown, that one's presence follows
    private wentOffline(Session: PresenceSession, Why: string): void {
        Session.Shown = undefined;

        const Audience = this.audience(Session.Uid!);

        for(const To of Audience){
            this.deliver(Session.Uid, To, this.unavailableStanza(Session, To));
        }

        const Other = this.host.SessionsOf(Session.Uid!).find((Each) => Each !== Session && IsOnline(Each) && Each.Shown !== undefined);

        if(Other !== undefined){
            for(const To of Audience){
                this.deliver(Other.Uid, To, this.presenceStanza(Other, To));
            }
        }

        logger.info(`chat: presence c=${Session.Id} uid=${Session.Uid} offline (${Why}): told ${Audience.length} friend session(s)${Other !== undefined ? `; c=${Other.Id} is still online` : ""}`);
    }

    // ---- The chat server's events ----

    // A broadcast presence (no "to", no type) from a bound session
    Broadcast(Session: PresenceSession, Node: Element): void {
        if(!IsOnline(Session)){
            return;
        }

        const Show = TextOf(ChildNamed(Node, "show")).trim();
        let Status = TextOf(ChildNamed(Node, "status"));

        if(Status.length > MAX_STATUS_LENGTH){
            if(this.host.LogOnce(`presence-long|${Session.Id}`)){
                logger.info(`chat: presence c=${Session.Id} status of ${Status.length} characters not relayed`);
            }

            Status = "";
        }

        const Next: ClientPresence = { Show: SHOW_VALUES.has(Show) ? Show : undefined, Status: Status.length > 0 ? Status : undefined };
        const Previous = Session.LastPresence;

        Session.LastPresence = Next;

        if(Previous !== undefined && Previous.Show === Next.Show && Previous.Status === Next.Status){
            return;
        }

        this.announce(Session);
    }

    // The session went offline: an unavailable broadcast from a session that stays connected (held back
    // like any other change when it comes too often), or the end of the session (sent at once; by then it
    // is no longer among the account's sessions)
    Unavailable(Session: PresenceSession, Why: string): void {
        if(Session.Uid === undefined || Session.Resource === undefined || (Session.LastPresence === undefined && Session.Shown === undefined)){
            return;
        }

        Session.LastPresence = undefined;

        if(!Session.Ended){
            Session.CatchUpDue = true;
            this.announce(Session);
            return;
        }

        Session.PresencePending = false;

        if(Session.Shown !== undefined){
            this.wentOffline(Session, Why);
        }
    }

    // Held-back changes whose turn has come (the chat server's 1 s tick)
    Tick(): void {
        const Now = this.host.Clock();

        for(const Session of this.host.Sessions()){
            if(Session.PresencePending && IsOnline(Session) && TakeToken(Session.PresenceTokens, PRESENCE_BURST, PRESENCE_REFILL_MS, Now)){
                this.flush(Session);
            }
        }
    }

    // A friendship began or ended over HTTP (controllers/friends.ts)
    Friendship(Event: FriendshipEvent): void {
        if(Event.Kind === "accepted"){
            this.accepted(Event.Requester, Event.Accepter, Event.CreatedAt);
        }
        else{
            this.ended(Event.A, Event.B);
        }
    }

    private accepted(Requester: string, Accepter: string, CreatedAt: number): void {
        if(SameAccount(Requester, Accepter) || this.access.IsBlockedEitherWay(Requester, Accepter)){
            return;
        }

        const OfRequester = this.host.SessionsOf(Requester).filter(IsOnline);
        const OfAccepter = this.host.SessionsOf(Accepter).filter(IsOnline);

        // The list entry to every session first, then the presences between the sessions that are online
        // for presence: each shown session's presence to each listening one (the others hear of the new
        // friend when their own presence is announced)
        for(const To of OfAccepter){
            this.deliver(ADMIN_LOCAL, To, this.friendMessage(To, Requester, "INBOUND", CreatedAt));
        }

        for(const To of OfRequester){
            this.deliver(ADMIN_LOCAL, To, this.friendMessage(To, Accepter, "OUTBOUND", CreatedAt));
        }

        for(const [From, To] of [[this.shown(Requester), this.listening(Accepter)], [this.shown(Accepter), this.listening(Requester)]]){
            for(const Sender of From){
                for(const Receiver of To){
                    this.deliver(Sender.Uid, Receiver, this.presenceStanza(Sender, Receiver));
                }
            }
        }

        if(OfRequester.length + OfAccepter.length > 0){
            logger.info(`chat: presence: ${Requester} and ${Accepter} are friends now: told ${OfRequester.length} and ${OfAccepter.length} session(s)`);
        }
    }

    // Each sees the other go, once; after that neither is in the other's audience
    private ended(A: string, B: string): void {
        for(const [From, To] of [[this.shown(A), this.listening(B)], [this.shown(B), this.listening(A)]]){
            for(const Sender of From){
                for(const Receiver of To){
                    this.deliver(Sender.Uid, Receiver, this.unavailableStanza(Sender, Receiver));
                }
            }
        }
    }
}
