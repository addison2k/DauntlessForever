"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_DOMAIN = exports.NS = void 0;
exports.EscapeXml = EscapeXml;
exports.LocalName = LocalName;
exports.ChildNamed = ChildNamed;
exports.TextOf = TextOf;
exports.AttrOf = AttrOf;
exports.LogText = LogText;
exports.IsHostName = IsHostName;
exports.IsXmppDomain = IsXmppDomain;
exports.ParseJid = ParseJid;
exports.ParseFrame = ParseFrame;
exports.HasMarkupDeclaration = HasMarkupDeclaration;
exports.NewBucket = NewBucket;
exports.TakeToken = TakeToken;
exports.RedactFrame = RedactFrame;
// Dauntless Forever: taken unchanged from Dauntless Revived (github.com/mixutin/dauntless-revived, AGPL-3.0,
// UndauntedMetagame/src/realtime/xmpp.ts). Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
const ltx_1 = require("./lib/ltx/lib/ltx.js");
// Small XMPP helpers shared by the chat listener (chat.ts) and its rooms. Stanza shapes and the reasons
// behind them are in docs/findings/chat.md.
exports.NS = {
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
exports.DEFAULT_DOMAIN = "prod.ol.epicgames.com";
function EscapeXml(Value) {
    return Value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
// "stream:features" -> "features", lower case (the client writes plain lower-case names)
function LocalName(Name) {
    return (Name.split(":").at(-1) ?? "").toLowerCase();
}
function ChildNamed(Node, Name) {
    if (Node === undefined) {
        return undefined;
    }
    for (const Item of Node.children) {
        if (typeof Item !== "string" && LocalName(Item.name) === Name) {
            return Item;
        }
    }
    return undefined;
}
function TextOf(Node) {
    return Node?.getText() ?? "";
}
function AttrOf(Node, Name) {
    const Value = Node.attrs[Name];
    return typeof Value === "string" ? Value : undefined;
}
// Client text for a log line: at most Max characters, anything but printable ASCII as "?"
function LogText(Text, Max = 80) {
    const Chars = [...Text];
    return Chars.slice(0, Max).map((Char) => /^[\x21-\x7e]$/.test(Char) ? Char : "?").join("") + (Chars.length > Max ? "..." : "");
}
// A host name as the client can write it in <open to>: at most 253 characters of A-Z a-z 0-9 . -
function IsHostName(Value) {
    return typeof Value === "string" && Value.length > 0 && Value.length <= 253 && /^[A-Za-z0-9.-]+$/.test(Value);
}
// The launcher redirects the cooked XMPP domain to its local MCP endpoint. Unlike a DNS host, that
// value includes the metagame port (for example 127.0.0.1:61000), and the client uses it verbatim in
// both <open to> and muc.<domain> room JIDs.
function IsXmppDomain(Value) {
    if (typeof Value !== "string" || Value.length === 0 || Value.length > 259) {
        return false;
    }
    const Match = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(Value);
    if (Match === null || !IsHostName(Match[1])) {
        return false;
    }
    return Match[2] === undefined || (Number(Match[2]) >= 1 && Number(Match[2]) <= 65535);
}
// local@domain/resource. The resource is everything after the first "/" and may itself hold "/", "@" and ":".
function ParseJid(Text) {
    const Slash = Text.indexOf("/");
    const Bare = Slash === -1 ? Text : Text.slice(0, Slash);
    const Resource = Slash === -1 ? undefined : Text.slice(Slash + 1);
    const At = Bare.indexOf("@");
    if (At <= 0 || At === Bare.length - 1) {
        return undefined;
    }
    return { Local: Bare.slice(0, At), Domain: Bare.slice(At + 1), Resource: Resource };
}
// One WebSocket message is one stanza (RFC 7395). Frames that carry a DTD or a processing instruction are
// refused before the parser sees them. Returns undefined for anything that does not parse.
function ParseFrame(Raw) {
    try {
        const Node = (0, ltx_1.parse)(Raw);
        return Node !== null && typeof Node.name === "string" ? Node : undefined;
    }
    catch {
        return undefined;
    }
}
function HasMarkupDeclaration(Raw) {
    return Raw.includes("<!") || Raw.includes("<?");
}
function NewBucket(Burst, Now) {
    return { Tokens: Burst, At: Now };
}
function TakeToken(TheBucket, Burst, RefillMs, Now) {
    const Elapsed = Math.max(0, Now - TheBucket.At);
    TheBucket.Tokens = Math.min(Burst, TheBucket.Tokens + Elapsed / RefillMs);
    TheBucket.At = Now;
    if (TheBucket.Tokens >= 1) {
        TheBucket.Tokens -= 1;
        return true;
    }
    return false;
}
// Frames for the trace (CHAT_TRACE=1): no SASL payload, legacy password, message text or token ever
// reaches the log. Capped at 2 KB.
function RedactFrame(Raw) {
    const Redacted = Raw
        .replace(/(<auth\b[^>]*>)[\s\S]*?(<\/auth>)/gi, "$1[redacted]$2")
        .replace(/(<password\b[^>]*>)[\s\S]*?(<\/password>)/gi, "$1[redacted]$2")
        .replace(/(<body\b[^>]*>)([\s\S]*?)(<\/body>)/gi, (_Match, Open, Text, Close) => `${Open}[${[...Text].length} chars]${Close}`)
        .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<token>")
        .replace(/[\w-]{64,}/g, "<redacted>");
    return Redacted.length > 2048 ? `${Redacted.slice(0, 2048)}...` : Redacted;
}
