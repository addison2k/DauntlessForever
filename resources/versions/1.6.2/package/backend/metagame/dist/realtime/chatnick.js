"use strict";
// Dauntless Forever: taken unchanged from Dauntless Revived (github.com/mixutin/dauntless-revived, AGPL-3.0,
// UndauntedMetagame/src/realtime/chatnick.ts). Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// The room nickname the 1.4.4 client joins with, and the rules a join must pass (docs/findings/chat.md,
// "Names"). Read from the game's executable (image base 0x140000000):
//
// - The client joins every room as Printf("%s:%s:%s", UrlEncode(DisplayName), AccountId, OwnResource)
//   (0x1408b5aeb): part 1 is its own display name, URL-encoded; then its account id; then its bound
//   resource (V2:<AppId>:WIN::<32 hex>, which itself holds colons).
// - Its UrlEncode (0x1428aebb0) converts to UTF-8 and keeps exactly A-Z a-z 0-9 - _ . ~; every other
//   byte becomes %XX in upper case. So part 1 never holds a ":".
// - Other clients show part 1, URL-decoded, as the name when an account lookup finds nobody, and their
//   "self" test is a case-sensitive search for their own account id anywhere in the nickname
//   (0x143a34acd-0x143a34aec). A nickname that carried another player's id would read as that player's
//   own presence on their screen.
//
// So the server never rewrites a nickname (that breaks the joiner's self test and stalls the join); it
// admits one only when it is exactly <name>:<own account id>:<own bound resource>, carries no other
// account id, and <name> decodes to the account's username (current, or as it was at chat login) or to
// the client's own fallback for a failed account read, InvalidMCPUser (0x14092bc0b).
Object.defineProperty(exports, "__esModule", { value: true });
exports.FALLBACK_NAME = void 0;
exports.UrlEncodeLikeClient = UrlEncodeLikeClient;
exports.DecodeNamePart = DecodeNamePart;
exports.NamePartOf = NamePartOf;
exports.CheckNickname = CheckNickname;
exports.FALLBACK_NAME = "InvalidMCPUser";
const ALLOWED_BYTE = /^[A-Za-z0-9\-_.~]$/;
const ENCODED_PART = /^(?:[A-Za-z0-9\-_.~]|%[0-9A-Fa-f]{2})*$/;
// The client's UrlEncode, for tests and docs: UTF-8, unreserved characters kept, %XX upper case
function UrlEncodeLikeClient(Text) {
    let Out = "";
    for (const Byte of Buffer.from(Text, "utf8")) {
        const Char = String.fromCharCode(Byte);
        if (Byte === 0) {
            continue;
        }
        Out += ALLOWED_BYTE.test(Char) ? Char : `%${Byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    return Out;
}
// Part 1 decoded, or undefined when it is not in the encoder's alphabet or not valid UTF-8. Hex case
// does not matter, and neither does over-encoding: the comparison is on the decoded text.
function DecodeNamePart(Part) {
    if (!ENCODED_PART.test(Part)) {
        return undefined;
    }
    const Bytes = [];
    for (let Index = 0; Index < Part.length;) {
        if (Part[Index] === "%") {
            Bytes.push(parseInt(Part.slice(Index + 1, Index + 3), 16));
            Index += 3;
        }
        else {
            Bytes.push(Part.charCodeAt(Index));
            Index += 1;
        }
    }
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(Bytes));
    }
    catch {
        return undefined;
    }
}
// The name part of any nickname, decoded when possible (for logs)
function NamePartOf(Nick) {
    const Colon = Nick.indexOf(":");
    return DecodeNamePart(Colon === -1 ? Nick : Nick.slice(0, Colon));
}
// The join rules. Names: the account's current username, and its username at chat login.
function CheckNickname(Nick, Uid, Resource, Names) {
    const Colon = Nick.indexOf(":");
    if (Colon === -1) {
        return { Ok: false, Reason: "nick-account" };
    }
    const Part1 = Nick.slice(0, Colon);
    const Rest = Nick.slice(Colon + 1);
    // V1: the rest is exactly <own account id>:<own bound resource>, case included
    if (Rest !== `${Uid}:${Resource}`) {
        return { Ok: false, Reason: Rest.split(":")[0] !== Uid ? "nick-account" : "nick-resource" };
    }
    // No other account id anywhere (a resource is the client's own free text)
    if (Nick.split(Uid).join("").includes("UID-")) {
        return { Ok: false, Reason: "nick-account" };
    }
    // V2: the encoder's alphabet, decoding to valid UTF-8
    const Name = DecodeNamePart(Part1);
    if (Name === undefined) {
        return { Ok: false, Reason: "nick-format" };
    }
    // V3: the account's own name, or the client's fallback
    if (Name !== exports.FALLBACK_NAME && !Names.some((Known) => Known !== undefined && Known === Name)) {
        return { Ok: false, Reason: "nick-name", Name };
    }
    return { Ok: true, Name };
}
