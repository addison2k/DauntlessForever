// Dauntless Forever: taken from Dauntless Revived (github.com/mixutin/dauntless-revived, AGPL-3.0,
// UndauntedMetagame/src/realtime/chat.ts). Changes: lookups come from ./compat (this backend's accounts,
// friends and parties), and AttachChat serves chat on the metagame's own port (61000) so it also works
// through the Dauntless Forever relay. Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
import crypto from "node:crypto";
import { createServer, IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import type { Request } from "express";
import { Element } from "ltx";
import WebSocket, { RawData, WebSocketServer } from "ws";
import {
    AddFriendshipListener, BlockersAmong, ChatPresence, ClientAddressOf, FindUsernameForUserId, GetPartyOf, IsAccountIdShape,
    IsBlockedEitherWay, IsGuildMember, IsTrustedGatewayRequest, KeyRevocations, ListFriends, ParseOnOff, ValidateMetagameJWTAndGetPayload
} from "./compat";
import { logger } from "../logger";
import { BodyLength, JOIN_BURST, MESSAGE_BURST, MucService, NickCheckMode, RoomAccess, TakeMessageToken } from "./muc";
import { ClientPresence, FriendPresence, PRESENCE_BURST, PresenceAccess } from "./presence";
import {
    AttrOf, Bucket, ChildNamed, DEFAULT_DOMAIN, EscapeXml, HasMarkupDeclaration, IsXmppDomain, LocalName, NewBucket, NS,
    ParseFrame, ParseJid, RedactFrame, TakeToken, TextOf
} from "./xmpp";

// The game's chat connection (roadmap 3.10; docs/findings/chat.md): XMPP over WebSocket, in the metagame's
// own process, on its own loopback port (CHAT_PORT, default 61099). In public mode the path is launcher
// relay -> gateway :443 -> 127.0.0.1:61099; on a dev PC the game connects straight to it.
//
// A player logs in with the same signed token as the metagame (SASL PLAIN), never with an account id
// alone. No stanza, token, SASL payload or message text is logged; CHAT_TRACE=1 logs frames with those
// redacted.
//
// Safety rules, because the game reconnects on its next tick when an established connection drops:
// - every socket and server has an error listener, and every stanza handler is guarded, so bad input
//   can never take the metagame down;
// - a logged-in connection is never closed over bad input: bad stanzas are dropped and counted, and the
//   stanza errors of docs/findings/chat.md are answered. Only the client's <close/>, a ping timeout,
//   replacement, shutdown, an oversized frame, output it does not read, or sustained abuse end one.
//   Replacement, abuse, an oversized frame and unread output hold that account's next login back for
//   60 s, so the game backs off 15-45 s instead of looping. A ping timeout does not: one reconnect
//   after it is not a loop.
// - before login a connection gets a few frames only, and nothing it sends may make the server hold more
//   than OUTPUT_LIMIT of unsent output for it.
//
// Pings: the client answers a server ping only from its game-thread tick (the handler 0x143a2a690
// queues it; FXmppPingStrophe::Tick 0x143a3eb90 builds the reply while logged in, 0x143a3ed99), which a
// long map load holds up. Its own limits (PingInterval 60, PingTimeout 30, MaxPingRetries 1: the
// constructor at 0x143a1f367-0x143a1f37b) let about 150 s of silence pass, and so does the server:
// pinged after 50 s, ended after another 100 s without an answer.

const FRAME_LIMIT = 32768;
export const BODY_LIMIT = 2048;
// Shared by every region; leave headroom beyond the realm's 100+ concurrent players.
const MAX_SOCKETS = 512;
// Connections that have not bound yet (not logged in, or logged in and not bound), per address
const MAX_UNBOUND_PER_ADDRESS = 8;
const MAX_FRAMES_BEFORE_LOGIN = 4;
const LOGIN_DEADLINE_MS = 15 * 1000;
// From the login: the game binds right after <success/>
const BIND_DEADLINE_MS = 10 * 1000;
const BIND_TIMEOUT_LIMIT = 3;
const BIND_TIMEOUT_WINDOW_MS = 10 * 60 * 1000;
const SASL_FAILURE_LIMIT = 10;
const SASL_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const SASL_THROTTLE_MS = 10 * 60 * 1000;
const UID_THROTTLE_MS = 60 * 1000;
const IDLE_PING_MS = 50 * 1000;
const PING_TIMEOUT_MS = 100 * 1000;
const STANZA_BURST = 60;
const STANZA_REFILL_MS = 1000 / 30;
const ABUSE_DROPS = 100;
const ABUSE_WINDOW_MS = 60 * 1000;
const LOG_ONCE_MS = 10 * 60 * 1000;
const LOG_ONCE_MAX = 10000;
const OUTPUT_LIMIT = 256 * 1024;
const MAX_RESOURCE = 256;
const MAX_ID = 128;
const MAX_SESSIONS_PER_ACCOUNT = 2;
// Bound or not: two bound sessions (a live one and a ghost) and one login in progress
const MAX_CONNECTIONS_PER_ACCOUNT = 3;
const GHOST_PING_MS = 10 * 1000;
const SWEEP_MS = 60 * 1000;
const CONTROL_CHARACTER = /\p{Cc}/u;

export type ChatOptions = {
    Trace?: boolean,
    NickCheck?: NickCheckMode,
    // Tests: other party, guild and block lookups
    Access?: RoomAccess,
    // Tests: a controllable clock, and no timer of its own (the test calls Tick)
    Clock?: () => number,
    AutoTick?: boolean,
    // Tests: a smaller cap on one connection's unsent output (bytes)
    OutputLimit?: number,
    // Friends' online status (realtime/presence.ts); by default CHAT_PRESENCE when the server is made
    Presence?: boolean,
    // Tests: other friends and block lookups for presence
    Friends?: PresenceAccess
};

// Tests only: every stanza the server sends, with the account of the session it goes to. The chat tests
// check that none outside a room comes from the receiving account (test/chatinvariant.ts).
let OutputObserver: ((Uid: string | undefined, Stanza: string) => void) | undefined;

export function ObserveChatOutputForTests(Observer?: (Uid: string | undefined, Stanza: string) => void){
    OutputObserver = Observer;
}

type EndReason = "close" | "socket" | "ping-timeout" | "replaced" | "abuse" | "size" | "backlog" | "shutdown" | "timeout" | "refused";

export type ChatSession = {
    Id: number,
    Socket: WebSocket,
    Address: string,
    Via: "gateway" | "direct",
    OpenedAt: number,
    Domain: string,
    Uid?: string,
    NameAtLogin?: string,
    LoggedInAt?: number,
    Resource?: string,
    Ended: boolean,
    // Frames received before login, and whether a SASL attempt failed
    EarlyFrames: number,
    LoginFailed: boolean,
    // Output was held back because the client does not read it; the session ends at the next check
    Backlogged: boolean,
    LastInbound: number,
    PingId?: string,
    PingDeadline?: number,
    Stanzas: Bucket,
    Drops: number[],
    LastDropLog: number,
    Namespaces: Set<string>,
    Available: boolean,
    // CHAT_PRESENCE=1: the last broadcast presence, what friends were last told of it, and held-back changes
    // (realtime/presence.ts)
    LastPresence?: ClientPresence,
    Shown?: ClientPresence,
    CatchUpDue?: boolean,
    PresenceTokens: Bucket,
    PresencePending: boolean,
    // Bare room JID -> the nickname held there
    Rooms: Map<string, string>,
    Joins: Bucket,
    Messages: Bucket
};

export function FullJidOf(Session: ChatSession): string {
    return `${Session.Uid}@${Session.Domain}/${Session.Resource}`;
}

function ErrorName(Error_: unknown): string {
    return Error_ instanceof Error ? Error_.name : typeof Error_;
}

export class ChatServer {
    private readonly http: HttpServer;
    private readonly ws: WebSocketServer;
    private readonly clients = new Set<ChatSession>();
    // Bound sessions per account, oldest first
    private readonly byUid = new Map<string, ChatSession[]>();
    private readonly saslFailures = new Map<string, number[]>();
    private readonly throttledAddresses = new Map<string, number>();
    private readonly throttledUids = new Map<string, number>();
    // Log keys -> when last logged, oldest first (at most LOG_ONCE_MAX)
    private readonly loggedOnce = new Map<string, number>();
    // Times one account's logins did not bind in time
    private readonly bindTimeouts = new Map<string, number[]>();
    private readonly clock: () => number;
    private readonly trace: boolean;
    private readonly nickCheck: NickCheckMode;
    private readonly outputLimit: number;
    private readonly muc: MucService;
    // Friends' online status, only with CHAT_PRESENCE=1
    private readonly friendPresence?: FriendPresence;
    private readonly stopFriendshipListener?: () => void;
    private readonly ticker?: NodeJS.Timeout;
    private readonly revokeKey=(uid:string)=>{for(const session of this.clients)if(session.Uid===uid)this.end(session,'replaced');};
    private nextId = 1;
    private nextPing = 1;
    private lastSweep = 0;

    constructor(Options: ChatOptions = {}) {
        KeyRevocations.on("revoke",this.revokeKey);
        this.clock = Options.Clock ?? (() => Date.now());
        this.trace = Options.Trace === true;
        this.nickCheck = Options.NickCheck ?? "enforce";
        this.outputLimit = Options.OutputLimit ?? OUTPUT_LIMIT;
        this.muc = new MucService({
            Access: Options.Access ?? {
                PartyIdOf: (Uid) => GetPartyOf(Uid)?.PartyId,
                IsGuildMember: (Uid, GuildId) => IsGuildMember(Uid, GuildId),
                BlockersAmong: (Sender, Recipients) => BlockersAmong(Sender, Recipients)
            },
            Send: (Session, Stanza) => this.send(Session as ChatSession, Stanza),
            Clock: () => this.clock(),
            LogOnce: (Key, WindowMs) => this.logOnce(Key, WindowMs),
            Refused: (Session) => this.drop(Session as ChatSession, "refused"),
            UsernameOf: (Uid) => FindUsernameForUserId(Uid),
            NickCheck: this.nickCheck
        });

        if(Options.Presence ?? ChatPresence()){
            this.friendPresence = new FriendPresence({
                SessionsOf: (Uid) => this.byUid.get(Uid) ?? [],
                Sessions: () => this.clients,
                Send: (Session, Stanza) => this.send(Session as ChatSession, Stanza),
                Clock: () => this.clock(),
                LogOnce: (Key, WindowMs) => this.logOnce(Key, WindowMs)
            }, Options.Friends ?? {
                FriendsOf: (Uid) => ListFriends(Uid, false).map((Friend) => Friend.accountId),
                IsBlockedEitherWay: (A, B) => IsBlockedEitherWay(A, B)
            });
            this.stopFriendshipListener = AddFriendshipListener((Event) => this.friendPresence?.Friendship(Event));
        }
        this.http = createServer((_req, res) => { res.writeHead(404); res.end(); });
        this.http.on("clientError", (_error, socket) => socket.destroy());
        this.http.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head));
        this.ws = new WebSocketServer({ noServer: true, maxPayload: FRAME_LIMIT, perMessageDeflate: false, clientTracking: false });
        this.ws.on("error", (error) => logger.error(`chat: WebSocket server error (${ErrorName(error)})`));

        if(Options.AutoTick !== false){
            this.ticker = setInterval(() => this.Tick(), 1000);
            this.ticker.unref();
        }
    }

    get port(): number {
        const address = this.http.address();
        return typeof address === "object" && address !== null ? address.port : 0;
    }

    // The most unsent output any one connection holds, in bytes (tests)
    get LargestBacklog(): number {
        return Math.max(0, ...[...this.clients].map((Session) => Session.Socket.bufferedAmount));
    }

    async listen(port: number, host = "127.0.0.1"): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this.http.once("error", reject);
            this.http.listen(port, host, () => { this.http.removeListener("error", reject); resolve(); });
        });
        this.http.on("error", (error) => logger.error(`chat: listener error (${ErrorName(error)})`));
        logger.info(`chat: listening on ${host}:${this.port} (nick check ${this.nickCheck})`);
        logger.info(this.friendPresence !== undefined
            ? `chat: friends' online status on (CHAT_PRESENCE=1): each player's presence goes to their online friends, never back to the player`
            : `chat: friends' online status off: no presence is sent outside rooms`);
    }

    // Dauntless Forever: take WebSocket upgrades on an existing HTTP server (the metagame's own port)
    attach(server: HttpServer): void {
        server.on("upgrade", (req, socket, head) => this.upgrade(req, socket as Duplex, head));
        logger.info(`chat: on the metagame's port (nick check ${this.nickCheck}); friends' online status ${this.friendPresence !== undefined ? "on" : "off"}`);
    }

    // Shutdown: <close/> to every session, then whatever is still open is cut after 1 s
    async close(): Promise<void> {
        KeyRevocations.off("revoke",this.revokeKey);
        if(this.ticker !== undefined){
            clearInterval(this.ticker);
        }

        this.stopFriendshipListener?.();

        const Open = [...this.clients];

        for(const Session of Open){
            this.end(Session, "shutdown");
        }

        await new Promise<void>((resolve) => {
            const Deadline = setTimeout(done, 1000);
            const Check = setInterval(() => { if(Open.every((Session) => Session.Socket.readyState === WebSocket.CLOSED)) done(); }, 20);

            function done(){
                clearTimeout(Deadline);
                clearInterval(Check);
                resolve();
            }
        });

        for(const Session of Open){
            Session.Socket.terminate();
        }

        await new Promise<void>((resolve) => this.ws.close(() => resolve()));
        await new Promise<void>((resolve) => this.http.listening ? this.http.close(() => resolve()) : resolve());
    }

    // The deadlines, pings and sweeps. A 1 s timer calls it; tests call it with their own clock.
    Tick(): void {
        const Now = this.clock();

        for(const Session of [...this.clients]){
            if(Session.Ended){
                continue;
            }

            if(this.isBacklogged(Session)){
                this.end(Session, "backlog");
            }
            else if(Session.Uid === undefined && Now - Session.OpenedAt >= LOGIN_DEADLINE_MS){
                this.end(Session, "timeout");
            }
            else if(Session.Uid !== undefined && Session.Resource === undefined && Now - (Session.LoggedInAt ?? Session.OpenedAt) >= BIND_DEADLINE_MS){
                this.bindTimedOut(Session.Uid, Now);
                this.end(Session, "timeout");
            }
            else if(Session.Resource !== undefined){
                if(Session.PingDeadline !== undefined){
                    if(Now >= Session.PingDeadline){
                        this.end(Session, "ping-timeout");
                    }
                }
                else if(Now - Session.LastInbound >= IDLE_PING_MS){
                    this.ping(Session, PING_TIMEOUT_MS);
                }
            }
        }

        if(Now - this.lastSweep >= SWEEP_MS){
            this.lastSweep = Now;
            this.muc.Sweep();
        }

        this.friendPresence?.Tick();
        this.prune(Now);
    }

    // ---- Connections ----

    private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
        socket.on("error", () => socket.destroy());

        const Request_ = req as unknown as Request;
        const Address = ClientAddressOf(Request_);
        const Via = IsTrustedGatewayRequest(Request_) ? "gateway" : "direct";
        // Not bound yet: still logging in, or logged in and not bound
        const Unbound = [...this.clients].filter((Session) => Session.Address === Address && Session.Resource === undefined).length;

        if(this.clients.size >= MAX_SOCKETS || Unbound >= MAX_UNBOUND_PER_ADDRESS){
            if(this.logOnce(`busy|${Address}`)){
                logger.warn(`chat: refused a connection from=${Address} via=${Via} (${this.clients.size >= MAX_SOCKETS ? "too many connections" : "too many logins in progress from this address"})`);
            }

            socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
            return;
        }

        try{
            this.ws.handleUpgrade(req, socket, head, (Socket) => this.connected(Socket, Address, Via));
        }
        catch(error){
            logger.warn(`chat: upgrade failed (${ErrorName(error)})`);
            socket.destroy();
        }
    }

    private connected(Socket: WebSocket, Address: string, Via: "gateway" | "direct"): void {
        const Now = this.clock();
        const Session: ChatSession = {
            Id: this.nextId++,
            Socket: Socket,
            Address: Address,
            Via: Via,
            OpenedAt: Now,
            Domain: DEFAULT_DOMAIN,
            Ended: false,
            EarlyFrames: 0,
            LoginFailed: false,
            Backlogged: false,
            LastInbound: Now,
            Stanzas: NewBucket(STANZA_BURST, Now),
            Drops: [],
            LastDropLog: 0,
            Namespaces: new Set(),
            Available: false,
            PresenceTokens: NewBucket(PRESENCE_BURST, Now),
            PresencePending: false,
            Rooms: new Map(),
            Joins: NewBucket(JOIN_BURST, Now),
            Messages: NewBucket(MESSAGE_BURST, Now)
        };

        this.clients.add(Session);
        logger.info(`chat: connect c=${Session.Id} from=${Address} via=${Via}`);

        // An oversized frame (1009), invalid UTF-8 in a text frame (1007) or a bad opcode: ws emits this
        // and closes the socket. Without a listener Node would throw and stop the whole metagame.
        Socket.on("error", (error: Error & { code?: string }) => {
            if(!Session.Ended) logger.warn(`chat: socket error c=${Session.Id} (${ErrorName(error)})`);
            if(error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"){
                this.countFailure(Session.Address, this.clock());
                this.end(Session, "size");
            }
            else{
                this.end(Session, "socket");
            }
        });
        Socket.on("close", () => this.end(Session, "socket"));
        // Text and binary frames alike are read as UTF-8 (the game sends text)
        Socket.on("message", (Data: RawData) => {
            try{
                this.frame(Session, (Buffer.isBuffer(Data) ? Data : Array.isArray(Data) ? Buffer.concat(Data) : Buffer.from(Data)).toString("utf8"));
            }
            catch(error){
                logger.error(`chat: stanza handler failed c=${Session.Id} (${ErrorName(error)})`);
            }
        });
    }

    // A client that does not read its output (it stopped, or floods us without reading) gets no more once
    // OUTPUT_LIMIT bytes wait unsent; the session ends at the next frame or tick. Ending it here would
    // change rooms in the middle of a fan-out.
    private send(Session: ChatSession, Stanza: string): void {
        if(Session.Socket.readyState !== WebSocket.OPEN){
            return;
        }

        if(!Session.Ended && (Session.Backlogged || Session.Socket.bufferedAmount > this.outputLimit)){
            Session.Backlogged = true;
            return;
        }

        if(this.trace){
            logger.info(`chat: trace c=${Session.Id} out ${RedactFrame(Stanza)}`);
        }

        OutputObserver?.(Session.Uid, Stanza);
        Session.Socket.send(Stanza);
    }

    private isBacklogged(Session: ChatSession): boolean {
        return Session.Backlogged || Session.Socket.bufferedAmount > this.outputLimit;
    }

    // Ends a session once. Replacement, abuse, an oversized frame and unread output hold that account's
    // next login back for 60 s (the game then backs off instead of reconnecting at once); a ping timeout
    // does not.
    private end(Session: ChatSession, Reason: EndReason): void {
        if(Session.Ended){
            return;
        }

        const Now = this.clock();

        Session.Ended = true;
        this.clients.delete(Session);
        this.muc.LeaveAll(Session, Reason === "replaced" ? "replaced" : "disconnect");

        if(Session.Uid !== undefined && Session.Resource !== undefined){
            const List = (this.byUid.get(Session.Uid) ?? []).filter((Other) => Other !== Session);

            if(List.length > 0) this.byUid.set(Session.Uid, List); else this.byUid.delete(Session.Uid);

            if(Reason === "replaced" || Reason === "abuse" || Reason === "size" || Reason === "backlog"){
                this.throttledUids.set(Session.Uid, Now + UID_THROTTLE_MS);
            }

            // Its friends see it go offline (at shutdown every session ends anyway)
            if(Reason !== "shutdown"){
                this.friendPresence?.Unavailable(Session, Reason);
            }
        }

        logger.info(`chat: closed c=${Session.Id} uid=${Session.Uid ?? "-"} reason=${Reason} after=${Math.round((Now - Session.OpenedAt) / 1000)}s`);

        if(Session.Socket.readyState === WebSocket.OPEN){
            if(Reason === "close" || Reason === "shutdown" || Reason === "replaced"){
                this.send(Session, `<close xmlns="${NS.FRAMING}"/>`);
                Session.Socket.close(1000);
            }
            else if(Reason === "size"){
                Session.Socket.close(1009);
            }
            else{
                Session.Socket.terminate();
            }
        }
    }

    private ping(Session: ChatSession, TimeoutMs: number): void {
        Session.PingId = `sp${this.nextPing++}`;
        Session.PingDeadline = this.clock() + TimeoutMs;
        this.send(Session, `<iq xmlns="${NS.CLIENT}" type="get" id="${Session.PingId}" from="${EscapeXml(Session.Domain)}" to="${EscapeXml(FullJidOf(Session))}"><ping xmlns="${NS.PING}"/></iq>`);
    }

    // ---- Throttles and log limits ----

    // At most LOG_ONCE_MAX keys are kept; past that the oldest goes first
    private logOnce(Key: string, WindowMs = LOG_ONCE_MS): boolean {
        const Now = this.clock();
        const Last = this.loggedOnce.get(Key);

        if(Last !== undefined && Now - Last < WindowMs){
            return false;
        }

        this.loggedOnce.delete(Key);

        while(this.loggedOnce.size >= LOG_ONCE_MAX){
            this.loggedOnce.delete(this.loggedOnce.keys().next().value!);
        }

        this.loggedOnce.set(Key, Now);
        return true;
    }

    // Three logins of one account in 10 minutes that never bound: its logins wait 60 s
    private bindTimedOut(Uid: string, Now: number): void {
        const Recent = (this.bindTimeouts.get(Uid) ?? []).filter((At) => Now - At < BIND_TIMEOUT_WINDOW_MS);

        Recent.push(Now);
        this.bindTimeouts.set(Uid, Recent);

        if(Recent.length >= BIND_TIMEOUT_LIMIT){
            this.throttledUids.set(Uid, Now + UID_THROTTLE_MS);
        }
    }

    private countFailure(Address: string, Now: number): void {
        const Recent = (this.saslFailures.get(Address) ?? []).filter((At) => Now - At < SASL_FAILURE_WINDOW_MS);

        Recent.push(Now);
        this.saslFailures.set(Address, Recent);

        if(Recent.length >= SASL_FAILURE_LIMIT){
            this.throttledAddresses.set(Address, Now + SASL_THROTTLE_MS);
        }
    }

    private prune(Now: number): void {
        for(const [Key, Until] of this.throttledAddresses) if(Until <= Now) this.throttledAddresses.delete(Key);
        for(const [Key, Until] of this.throttledUids) if(Until <= Now) this.throttledUids.delete(Key);
        for(const [Key, At] of this.loggedOnce) if(Now - At >= LOG_ONCE_MS) this.loggedOnce.delete(Key);
        for(const [Key, Times] of this.bindTimeouts){
            if(Times.every((At) => Now - At >= BIND_TIMEOUT_WINDOW_MS)) this.bindTimeouts.delete(Key);
        }
        for(const [Key, Times] of this.saslFailures){
            const Recent = Times.filter((At) => Now - At < SASL_FAILURE_WINDOW_MS);

            if(Recent.length > 0) this.saslFailures.set(Key, Recent); else this.saslFailures.delete(Key);
        }
    }

    private drop(Session: ChatSession, Reason: "parse" | "rate" | "unknown" | "refused"): void {
        const Now = this.clock();

        Session.Drops = Session.Drops.filter((At) => Now - At < ABUSE_WINDOW_MS);
        Session.Drops.push(Now);

        if(Now - Session.LastDropLog >= 60 * 1000){
            Session.LastDropLog = Now;
            logger.info(`chat: dropped c=${Session.Id} reason=${Reason}`);
        }

        if(Session.Drops.length > ABUSE_DROPS){
            this.end(Session, "abuse");
        }
    }

    // ---- Stanzas ----

    private frame(Session: ChatSession, Raw: string): void {
        if(Session.Ended){
            return;
        }

        const Now = this.clock();

        Session.LastInbound = Now;
        Session.PingDeadline = undefined;
        Session.PingId = undefined;

        if(this.trace){
            logger.info(`chat: trace c=${Session.Id} in ${RedactFrame(Raw)}`);
        }

        if(this.isBacklogged(Session)){
            this.end(Session, "backlog");
            return;
        }

        // Before login the game sends <open>, <auth> and, after a refused login, its legacy login: a few
        // frames at most
        if(Session.Uid === undefined && ++Session.EarlyFrames > MAX_FRAMES_BEFORE_LOGIN){
            this.countFailure(Session.Address, Now);
            this.end(Session, "refused");
            return;
        }

        if(Session.Uid !== undefined && !TakeToken(Session.Stanzas, STANZA_BURST, STANZA_REFILL_MS, Now)){
            this.drop(Session, "rate");
            return;
        }

        // No DTDs or processing instructions, ever. Before login that ends the connection; after it the
        // frame is dropped (the game never sends one, and closing would start a reconnect loop).
        if(HasMarkupDeclaration(Raw)){
            if(Session.Uid === undefined){
                this.send(Session, `<stream:error xmlns:stream="${NS.STREAMS}"><restricted-xml xmlns="${NS.STREAM_ERRORS}"/></stream:error>`);
                this.end(Session, "refused");
            }
            else{
                this.drop(Session, "parse");
            }

            return;
        }

        const Node = ParseFrame(Raw);

        if(Node === undefined){
            if(Session.Uid === undefined) this.end(Session, "refused"); else this.drop(Session, "parse");
            return;
        }

        const Kind = LocalName(Node.name);

        if(Kind === "open"){
            this.open(Session, Node);
            return;
        }

        if(Kind === "close"){
            this.end(Session, "close");
            return;
        }

        if(Session.Uid === undefined){
            this.beforeLogin(Session, Node, Kind);
            return;
        }

        if(Kind === "iq"){
            this.iq(Session, Node);
            return;
        }

        if(Session.Resource === undefined){
            this.drop(Session, "unknown");
            return;
        }

        if(Kind === "presence"){
            this.presence(Session, Node);
        }
        else if(Kind === "message"){
            this.message(Session, Node);
        }
        else{
            this.drop(Session, "unknown");
        }
    }

    private open(Session: ChatSession, Node: Element): void {
        if(Session.Resource === undefined){
            const To = AttrOf(Node, "to");

            if(IsXmppDomain(To)){
                Session.Domain = To;
            }
            else if(Session.Uid === undefined){
                Session.Domain = DEFAULT_DOMAIN;
            }
        }

        this.send(Session, `<open xmlns="${NS.FRAMING}" from="${EscapeXml(Session.Domain)}" id="${crypto.randomBytes(8).toString("hex")}" version="1.0" xml:lang="en"/>`);
        this.send(Session, Session.Uid !== undefined
            ? `<stream:features xmlns:stream="${NS.STREAMS}"><bind xmlns="${NS.BIND}"/></stream:features>`
            : `<stream:features xmlns:stream="${NS.STREAMS}"><mechanisms xmlns="${NS.SASL}"><mechanism>PLAIN</mechanism></mechanisms></stream:features>`);
    }

    private beforeLogin(Session: ChatSession, Node: Element, Kind: string): void {
        if(Kind === "auth"){
            this.auth(Session, Node);
            return;
        }

        // After a failed SASL the game tries legacy jabber:iq:auth (_xmpp_auth1): refuse it and hang up
        if(Kind === "iq"){
            const Id = AttrOf(Node, "id") ?? "";

            this.send(Session, `<iq xmlns="${NS.CLIENT}" type="error"${Id.length > 0 && Id.length <= MAX_ID ? ` id="${EscapeXml(Id)}"` : ""}><error type="auth"><not-authorized xmlns="${NS.STANZAS}"/></error></iq>`);
        }

        this.end(Session, "refused");
    }

    private refuseLogin(Session: ChatSession, Reason: string, Uid: string | undefined, Condition = "not-authorized"): void {
        Session.LoginFailed = true;

        if(Reason !== "throttled"){
            this.countFailure(Session.Address, this.clock());
        }

        if(this.logOnce(`login|${Uid ?? Session.Address}|${Reason}`)){
            logger.info(`chat: login refused c=${Session.Id} reason=${Reason}${Uid !== undefined ? ` uid=${Uid}` : ""}`);
        }

        this.send(Session, `<failure xmlns="${NS.SASL}"><${Condition}/></failure>`);
    }

    private auth(Session: ChatSession, Node: Element): void {
        const Now = this.clock();
        const AddressUntil = this.throttledAddresses.get(Session.Address);

        // One SASL attempt per connection: after a refusal the game tries its legacy login, never <auth>
        if(Session.LoginFailed){
            this.end(Session, "refused");
            return;
        }

        if(AddressUntil !== undefined && AddressUntil > Now){
            this.refuseLogin(Session, "throttled", undefined, "temporary-auth-failure");
            return;
        }

        if(AttrOf(Node, "mechanism") !== "PLAIN"){
            this.refuseLogin(Session, "bad-mechanism", undefined, "invalid-mechanism");
            return;
        }

        const Encoded = TextOf(Node).trim();

        if(Encoded.length === 0 || Encoded.length > 12000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(Encoded)){
            this.refuseLogin(Session, "bad-format", undefined);
            return;
        }

        const Fields = Buffer.from(Encoded, "base64").toString("utf8").split("\0");

        if(Fields.length !== 3 || (Fields[0] !== "" && Fields[0] !== Fields[1]) || !IsAccountIdShape(Fields[1]) || Fields[2].length === 0 || Fields[2].length > 8192){
            this.refuseLogin(Session, "bad-format", undefined);
            return;
        }

        const Uid = Fields[1];
        const UidUntil = this.throttledUids.get(Uid);

        if(UidUntil !== undefined && UidUntil > Now){
            this.refuseLogin(Session, "throttled", Uid, "temporary-auth-failure");
            return;
        }

        let Payload: unknown;

        try{
            Payload = ValidateMetagameJWTAndGetPayload(Fields[2]);
        }
        catch(error){
            this.refuseLogin(Session, ErrorName(error) === "TokenExpiredError" ? "expired" : "bad-token", Uid);
            return;
        }

        const TokenUid = typeof Payload === "object" && Payload !== null ? (Payload as { userId?: unknown }).userId : undefined;

        if(TokenUid !== Uid){
            this.refuseLogin(Session, "uid-mismatch", Uid);
            return;
        }

        const Name = FindUsernameForUserId(Uid);

        if(Name === undefined){
            this.refuseLogin(Session, "no-account", Uid);
            return;
        }

        // At most three connections per account, bound or not: past that the oldest one that has not bound
        // goes (bound ones are limited to two at the bind)
        const Mine = [...this.clients].filter((Other) => Other !== Session && !Other.Ended && Other.Uid === Uid);

        for(const Old of Mine.filter((Other) => Other.Resource === undefined).slice(0, Math.max(0, Mine.length + 1 - MAX_CONNECTIONS_PER_ACCOUNT))){
            this.end(Old, "replaced");
        }

        Session.Uid = Uid;
        Session.NameAtLogin = Name;
        Session.LoggedInAt = Now;
        logger.info(`chat: login ok c=${Session.Id} uid=${Uid}`);
        this.send(Session, `<success xmlns="${NS.SASL}"/>`);
    }

    private iq(Session: ChatSession, Node: Element): void {
        const Type = AttrOf(Node, "type");
        const Id = AttrOf(Node, "id") ?? "";

        if(Type === "result" || Type === "error"){
            return;
        }

        if((Type !== "get" && Type !== "set") || Id.length > MAX_ID){
            this.drop(Session, "unknown");
            return;
        }

        const Binding = ChildNamed(Node, "bind");

        if(Type === "set" && Binding !== undefined){
            this.bind(Session, Id, TextOf(ChildNamed(Binding, "resource")));
            return;
        }

        // Pings, the never-advertised session IQ, and anything else: an empty result, which is what the
        // game was seen working with. The namespace of an unknown one is logged once per session.
        const Child = Node.children.find((Item): Item is Element => typeof Item !== "string");
        const Namespace = Child !== undefined ? (AttrOf(Child, "xmlns") ?? "") : "";

        if(Child !== undefined && Namespace !== NS.PING && Namespace !== NS.SESSION && !Session.Namespaces.has(Namespace) && Session.Namespaces.size < 32){
            Session.Namespaces.add(Namespace);
            logger.debug(`chat: iq c=${Session.Id} ${Type} namespace=${Namespace.slice(0, 80)}`);
        }

        this.send(Session, `<iq xmlns="${NS.CLIENT}" type="result" id="${EscapeXml(Id)}"/>`);
    }

    private bind(Session: ChatSession, Id: string, Requested: string): void {
        const Uid = Session.Uid!;

        if(Session.Resource !== undefined){
            this.send(Session, `<iq xmlns="${NS.CLIENT}" type="result" id="${EscapeXml(Id)}"><bind xmlns="${NS.BIND}"><jid>${EscapeXml(FullJidOf(Session))}</jid></bind></iq>`);
            return;
        }

        if(Requested.length > MAX_RESOURCE || CONTROL_CHARACTER.test(Requested)){
            this.send(Session, `<iq xmlns="${NS.CLIENT}" type="error" id="${EscapeXml(Id)}"><error type="modify"><bad-request xmlns="${NS.STANZAS}"/></error></iq>`);
            return;
        }

        const Resource = Requested.length > 0 ? Requested : `srv-${crypto.randomBytes(16).toString("hex")}`;

        // At most two sessions per account. The game makes a new resource at every login, so the same one
        // again is a ghost or a forgery, and a third session replaces the one silent longest (normally the
        // ghost of a dropped connection).
        const Same = (this.byUid.get(Uid) ?? []).find((Other) => Other.Resource === Resource);

        if(Same !== undefined){
            this.end(Same, "replaced");
        }

        const Remaining = this.byUid.get(Uid) ?? [];

        if(Remaining.length >= MAX_SESSIONS_PER_ACCOUNT){
            this.end(Remaining.reduce((Oldest, Other) => Other.LastInbound < Oldest.LastInbound ? Other : Oldest), "replaced");
        }

        Session.Resource = Resource;
        this.byUid.set(Uid, [...(this.byUid.get(Uid) ?? []), Session]);
        logger.info(`chat: bound c=${Session.Id} uid=${Uid} resource=${Resource} domain=${Session.Domain} sessions=${this.byUid.get(Uid)!.length}`);
        this.send(Session, `<iq xmlns="${NS.CLIENT}" type="result" id="${EscapeXml(Id)}"><bind xmlns="${NS.BIND}"><jid>${EscapeXml(FullJidOf(Session))}</jid></bind></iq>`);

        // An older session of the same account that does not answer a ping within 10 s is a ghost
        for(const Other of this.byUid.get(Uid)!){
            if(Other !== Session && (Other.PingDeadline === undefined || Other.PingDeadline > this.clock() + GHOST_PING_MS)){
                this.ping(Other, GHOST_PING_MS);
            }
        }
    }

    // ---- Presence and messages ----

    private presence(Session: ChatSession, Node: Element): void {
        const ToText = AttrOf(Node, "to");
        const Type = AttrOf(Node, "type");

        // A broadcast presence (no "to") is recorded; it is never echoed to its sender or to another session
        // of the same account. Only with CHAT_PRESENCE=1 it goes to the sender's online friends
        // (realtime/presence.ts); without it, it is relayed to no one. An unavailable one leaves every room.
        if(ToText === undefined){
            if(Type === "unavailable"){
                this.muc.LeaveAll(Session, "left");
                this.friendPresence?.Unavailable(Session, "unavailable");
            }
            else if(Type === undefined){
                Session.Available = true;
                logger.debug(`chat: presence c=${Session.Id} status=${JSON.stringify(StatusTextOf(Node))}`);
                this.friendPresence?.Broadcast(Session, Node);
            }

            return;
        }

        const To = ToText.length <= 2048 ? ParseJid(ToText) : undefined;
        const Muc = ChildNamed(Node, "x");
        const ToRoom = To !== undefined && (this.muc.IsMucDomain(Session, To.Domain) || /^(muc|conference)\./i.test(To.Domain) || (Muc !== undefined && AttrOf(Muc, "xmlns") === NS.MUC));

        if(To === undefined || !ToRoom){
            // Directed presence to a user, subscriptions and probes: dropped
            logger.debug(`chat: presence to a user dropped c=${Session.Id}`);
            return;
        }

        if(Type === undefined){
            this.muc.Join(Session, To);
        }
        else if(Type === "unavailable"){
            this.muc.Leave(Session, To);
        }
    }

    private message(Session: ChatSession, Node: Element): void {
        const Type = AttrOf(Node, "type");
        const ToText = AttrOf(Node, "to") ?? "";
        const To = ToText.length <= 2048 ? ParseJid(ToText) : undefined;

        if(Type === "groupchat" && To !== undefined){
            this.muc.GroupChat(Session, To, Node);
        }
        else if(Type === "chat" && To !== undefined){
            this.whisper(Session, Node, To.Local, To.Resource);
        }
        else{
            logger.debug(`chat: message dropped c=${Session.Id} type=${String(Type).slice(0, 16)}`);
        }
    }

    // A whisper: to one session of the account when the resource names one, else to all of them, from the
    // sender's full JID (the client drops senders without a resource). Nothing is sent back when it is not
    // delivered: the client routes type="error" messages to its room code.
    private whisper(Session: ChatSession, Node: Element, Target: string, Resource: string | undefined): void {
        const Uid = Session.Uid!;
        const Body = TextOf(ChildNamed(Node, "body"));
        const Length = BodyLength(Body);
        const IdAttr = AttrOf(Node, "id");
        const Id = IdAttr !== undefined && IdAttr.length <= MAX_ID ? IdAttr : undefined;
        const Shown = IsAccountIdShape(Target) ? Target : "?";
        const Refused = (Reason: string) => logger.info(`chat: whisper from=${Uid} to=${Shown} len=${Length} reason=${Reason}`);

        // Every whisper takes a token first, refused ones included, so its log lines are as limited as
        // delivered ones
        if(!TakeMessageToken(Session, this.clock())){
            if(this.logOnce(`whisper-rate|${Session.Id}`, 60 * 1000)){
                Refused("limit");
            }

            return;
        }

        if(Length === 0 || Length > BODY_LIMIT){
            Refused("size");
            return;
        }

        if(Target === Uid){
            Refused("self");
            return;
        }

        const Sessions = Target === "xmpp-admin" ? [] : (this.byUid.get(Target) ?? []);

        if(Sessions.length === 0){
            Refused("offline");
            return;
        }

        // Either player blocked the other: not delivered (the same rule as party invites)
        if(IsBlockedEitherWay(Uid, Target)){
            Refused("blocked");
            return;
        }

        const Chosen = Sessions.filter((Other) => Other.Resource === Resource);
        const Recipients = Chosen.length > 0 ? Chosen : Sessions;
        const Text = EscapeXml(Body);

        for(const Recipient of Recipients){
            this.send(Recipient, `<message xmlns="${NS.CLIENT}" type="chat" from="${EscapeXml(FullJidOf(Session))}" to="${EscapeXml(FullJidOf(Recipient))}"${Id !== undefined ? ` id="${EscapeXml(Id)}"` : ""}><body>${Text}</body></message>`);
        }

        logger.info(`chat: whisper from=${Uid} to=${Target} len=${Length} delivered=${Recipients.length}`);
    }
}

// The Status text of a broadcast presence (the client sends JSON in <status>), at most 64 characters
function StatusTextOf(Node: Element): string {
    const Raw = TextOf(ChildNamed(Node, "status"));

    try{
        const Parsed = JSON.parse(Raw);
        const Status = typeof Parsed === "object" && Parsed !== null ? (Parsed as { Status?: unknown }).Status : undefined;

        return typeof Status === "string" ? Status.slice(0, 64) : "";
    }
    catch{
        return "";
    }
}

// ---- Settings and start ----

export type ChatConfig = { Enabled: boolean, Port: number, Host: string, NickCheck: NickCheckMode, Trace: boolean, Errors: string[], Warnings: string[] };

// Chat is on when CHAT is unset/empty or 1; CHAT=0 explicitly disables it. CHAT_PORT (61099)
// and CHAT_BIND_HOST (127.0.0.1) say where; in public mode (GATEWAY_SECRET set) the gateway forwards to
// 127.0.0.1 and nothing else is accepted. CHAT_NICK_CHECK=log admits room nicknames that fail the
// resource, format or name rule with a warning instead of refusing them (a rollback switch only); another
// account's id is refused either way. CHAT_TRACE=1 logs redacted frames.
export function ReadChatConfig(Env: NodeJS.ProcessEnv = process.env): ChatConfig {
    const Errors: string[] = [];
    const Warnings: string[] = [];
    const ChatSetting = (Env.CHAT ?? "").trim();
    const Enabled = ChatSetting === "" || ChatSetting === "1";
    const PortText = Env.CHAT_PORT || "61099";
    const Port = Number(PortText);
    const Host = Env.CHAT_BIND_HOST || "127.0.0.1";
    const PublicMode = typeof Env.GATEWAY_SECRET === "string" && Env.GATEWAY_SECRET.length > 0;

    if(Env.EXPERIMENTAL_CHAT !== undefined && Env.CHAT === undefined){
        Warnings.push("EXPERIMENTAL_CHAT is no longer read; the switch is now CHAT=1");
    }

    if(ChatSetting !== "" && ChatSetting !== "0" && ChatSetting !== "1"){
        Warnings.push("CHAT is not 0 or 1; chat stays off. Unset it or use CHAT=1 to enable in-game chat.");
    }

    if(!Enabled && (ParseOnOff((Env.CHAT_PRESENCE ?? "").trim()) ?? true)){
        Warnings.push("CHAT_PRESENCE is on but chat is off (CHAT=1 is needed); nobody shows as online");
    }

    if(!/^\d{1,5}$/.test(PortText) || !Number.isInteger(Port) || Port < 1 || Port > 65535){
        Errors.push(`CHAT_PORT must be a port number (1-65535)`);
    }

    if(PublicMode ? Host !== "127.0.0.1" : (Host !== "127.0.0.1" && Host !== "::1")){
        Errors.push(PublicMode
            ? `CHAT_BIND_HOST must be 127.0.0.1 in public mode (the gateway forwards chat there)`
            : `CHAT_BIND_HOST must be 127.0.0.1 or ::1`);
    }

    const NickText = Env.CHAT_NICK_CHECK ?? "";
    let NickCheck: NickCheckMode = "enforce";

    if(NickText === "log"){
        NickCheck = "log";
    }
    else if(NickText !== "" && NickText !== "enforce"){
        Warnings.push(`CHAT_NICK_CHECK=${NickText.slice(0, 16)} is not enforce or log; nicknames are checked`);
    }

    return { Enabled, Port, Host, NickCheck, Trace: Env.CHAT_TRACE === "1", Errors, Warnings };
}

// Starts chat by default. Never throws and never stops the metagame: a bad setting or a port in use is
// one error line, and the metagame serves on without chat.
export async function StartChat(Env: NodeJS.ProcessEnv = process.env): Promise<ChatServer | undefined> {
    const Config = ReadChatConfig(Env);

    for(const Warning of Config.Warnings){
        logger.warn(`chat: ${Warning}`);
    }

    if(!Config.Enabled){
        logger.info("chat: disabled by CHAT setting; use CHAT=1 and restart to enable in-game chat");
        return undefined;
    }

    if(Config.Errors.length > 0){
        logger.error(`chat: not started: ${Config.Errors.join("; ")}. The metagame runs without chat.`);
        return undefined;
    }

    const Server = new ChatServer({ Trace: Config.Trace, NickCheck: Config.NickCheck });

    try{
        await Server.listen(Config.Port, Config.Host);
        return Server;
    }
    catch(error){
        const Code = (error as { code?: unknown })?.code;

        logger.error(`chat: not started: could not listen on ${Config.Host}:${Config.Port} (${typeof Code === "string" ? Code : ErrorName(error)}). The metagame runs without chat.`);
        await Server.close().catch(() => undefined);
        return undefined;
    }
}

// Dauntless Forever: chat on the metagame's own HTTP server. CHAT=0 turns it off; CHAT_NICK_CHECK=enforce
// refuses room names that do not match the account (default here: log, which admits them with a warning).
export function AttachChat(server: HttpServer, Env: NodeJS.ProcessEnv = process.env): ChatServer | undefined {
    try{
        if((Env.CHAT ?? "").trim() === "0"){
            logger.info("chat: off (CHAT=0)");
            return undefined;
        }
        const NickCheck: NickCheckMode = Env.CHAT_NICK_CHECK === "enforce" ? "enforce" : "log";
        const Server = new ChatServer({ Trace: Env.CHAT_TRACE === "1", NickCheck });
        Server.attach(server);
        return Server;
    }
    catch(error){
        logger.error(`chat: not started (${ErrorName(error)}). The metagame runs without chat.`);
        return undefined;
    }
}
