// Dauntless Forever: taken unchanged from Dauntless Revived (github.com/mixutin/dauntless-revived, AGPL-3.0,
// UndauntedMetagame/src/realtime/xmpp.ts). Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
import { Element, parse } from "ltx";

// Small XMPP helpers shared by the chat listener (chat.ts) and its rooms. Stanza shapes and the reasons
// behind them are in docs/findings/chat.md.

export const NS = {
    FRAMING: "urn:ietf:params:xml:ns:xmpp-framing",
    SASL: "urn:ietf:params:xml:ns:xmpp-sasl",
    BIND: "urn:ietf:params:xml:ns:xmpp-bind",
    SESSION: "urn:ietf:params:xml:ns:xmpp-session",
    STREAMS: "http://etherx.jabber.org/streams",
    STREAM_ERRORS: "urn:ietf:params:xml:ns:xmpp-streams",
    STANZAS: "urn:ietf:params:xml:ns:xmpp-stanzas",
    CLIENT: "jabber:client",
    LEGACY_AUTH: "jabber:iq:auth",
    PING: "urn:xmpp:ping",
    MUC: "http://jabber.org/protocol/muc",
    MUC_USER: "http://jabber.org/protocol/muc#user"
};

// The client's cooked [OnlineSubsystemMcp.XMPP] Domain, which the launcher does not override. Used when
// the client's <open to> is missing or is not a host name.
export const DEFAULT_DOMAIN = "prod.ol.epicgames.com";

export function EscapeXml(Value: string): string {
    return Value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// "stream:features" -> "features", lower case (the client writes plain lower-case names)
export function LocalName(Name: string): string {
    return (Name.split(":").at(-1) ?? "").toLowerCase();
}

export function ChildNamed(Node: Element | undefined, Name: string): Element | undefined {
    if(Node === undefined){
        return undefined;
    }

    for(const Item of Node.children){
        if(typeof Item !== "string" && LocalName(Item.name) === Name){
            return Item;
        }
    }

    return undefined;
}

export function TextOf(Node: Element | undefined): string {
    return Node?.getText() ?? "";
}

export function AttrOf(Node: Element, Name: string): string | undefined {
    const Value = Node.attrs[Name];

    return typeof Value === "string" ? Value : undefined;
}

// Client text for a log line: at most Max characters, anything but printable ASCII as "?"
export function LogText(Text: string, Max = 80): string {
    const Chars = [...Text];

    return Chars.slice(0, Max).map((Char) => /^[\x21-\x7e]$/.test(Char) ? Char : "?").join("") + (Chars.length > Max ? "..." : "");
}

// A host name as the client can write it in <open to>: at most 253 characters of A-Z a-z 0-9 . -
export function IsHostName(Value: unknown): Value is string {
    return typeof Value === "string" && Value.length > 0 && Value.length <= 253 && /^[A-Za-z0-9.-]+$/.test(Value);
}

// The launcher redirects the cooked XMPP domain to its local MCP endpoint. Unlike a DNS host, that
// value includes the metagame port (for example 127.0.0.1:61000), and the client uses it verbatim in
// both <open to> and muc.<domain> room JIDs.
export function IsXmppDomain(Value: unknown): Value is string {
    if(typeof Value !== "string" || Value.length === 0 || Value.length > 259){
        return false;
    }

    const Match = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(Value);

    if(Match === null || !IsHostName(Match[1])){
        return false;
    }

    return Match[2] === undefined || (Number(Match[2]) >= 1 && Number(Match[2]) <= 65535);
}

export type Jid = { Local: string, Domain: string, Resource: string | undefined };

// local@domain/resource. The resource is everything after the first "/" and may itself hold "/", "@" and ":".
export function ParseJid(Text: string): Jid | undefined {
    const Slash = Text.indexOf("/");
    const Bare = Slash === -1 ? Text : Text.slice(0, Slash);
    const Resource = Slash === -1 ? undefined : Text.slice(Slash + 1);
    const At = Bare.indexOf("@");

    if(At <= 0 || At === Bare.length - 1){
        return undefined;
    }

    return { Local: Bare.slice(0, At), Domain: Bare.slice(At + 1), Resource: Resource };
}

// One WebSocket message is one stanza (RFC 7395). Frames that carry a DTD or a processing instruction are
// refused before the parser sees them. Returns undefined for anything that does not parse.
export function ParseFrame(Raw: string): Element | undefined {
    try{
        const Node: Element | null = parse(Raw);

        return Node !== null && typeof Node.name === "string" ? Node : undefined;
    }
    catch{
        return undefined;
    }
}

export function HasMarkupDeclaration(Raw: string): boolean {
    return Raw.includes("<!") || Raw.includes("<?");
}

// A token bucket: Burst tokens, one more every RefillMs
export type Bucket = { Tokens: number, At: number };

export function NewBucket(Burst: number, Now: number): Bucket {
    return { Tokens: Burst, At: Now };
}

export function TakeToken(TheBucket: Bucket, Burst: number, RefillMs: number, Now: number): boolean {
    const Elapsed = Math.max(0, Now - TheBucket.At);

    TheBucket.Tokens = Math.min(Burst, TheBucket.Tokens + Elapsed / RefillMs);
    TheBucket.At = Now;

    if(TheBucket.Tokens >= 1){
        TheBucket.Tokens -= 1;
        return true;
    }

    return false;
}

// Frames for the trace (CHAT_TRACE=1): no SASL payload, legacy password, message text or token ever
// reaches the log. Capped at 2 KB.
export function RedactFrame(Raw: string): string {
    const Redacted = Raw
        .replace(/(<auth\b[^>]*>)[\s\S]*?(<\/auth>)/gi, "$1[redacted]$2")
        .replace(/(<password\b[^>]*>)[\s\S]*?(<\/password>)/gi, "$1[redacted]$2")
        .replace(/(<body\b[^>]*>)([\s\S]*?)(<\/body>)/gi, (_Match, Open: string, Text: string, Close: string) => `${Open}[${[...Text].length} chars]${Close}`)
        .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<token>")
        .replace(/[\w-]{64,}/g, "<redacted>");

    return Redacted.length > 2048 ? `${Redacted.slice(0, 2048)}...` : Redacted;
}
