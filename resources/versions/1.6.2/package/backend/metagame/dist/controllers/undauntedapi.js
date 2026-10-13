// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REGISTRATION_MODE = exports.VALID_REGISTRATION_MODES = void 0;
exports.IsRegistrationMode = IsRegistrationMode;
exports.SetRegistrationMode = SetRegistrationMode;
exports.GetInviteCodes = GetInviteCodes;
exports.GetAllUserIds = GetAllUserIds;
exports.RegisterInviteCode = RegisterInviteCode;
exports.DeleteInviteCode = DeleteInviteCode;
exports.IsUserIdAdmin = IsUserIdAdmin;
exports.RegisterUser = RegisterUser;
exports.ValidateAndConsumeInviteCode = ValidateAndConsumeInviteCode;
exports.UpdatePlayerActivity = UpdatePlayerActivity;
exports.UpdatePlayerLocation = UpdatePlayerLocation;
exports.GetRecentPlayerData = GetRecentPlayerData;
exports.GetUserInfoForApiKey = GetUserInfoForApiKey;
const node_crypto_1 = require("node:crypto");
const db_1 = require("../db");
const auth_1 = require("./auth");
const schema_1 = require("../db/schema");
const drizzle_orm_1 = require("drizzle-orm");
const AUTH_MODE = process.env.AUTH_MODE;
const NODE_ENV = process.env.NODE_ENV;
exports.VALID_REGISTRATION_MODES = ["NONE", "INVITECODE", "OPEN"];
exports.REGISTRATION_MODE = process.env.REGISTRATION_MODE; // In memory only for now, might wanna move to DB at some point
let PlayerActivityMap = new Map();
let PlayerLocationMap = new Map();
function IsRegistrationMode(Value) {
    return typeof Value === "string" && exports.VALID_REGISTRATION_MODES.includes(Value);
}
function SetRegistrationMode(Value) {
    if (!IsRegistrationMode(Value)) {
        return false;
    }
    exports.REGISTRATION_MODE = Value;
    return true;
}
async function GetInviteCodes() {
    return await (0, db_1.GetDb)().query.invitecodes.findMany();
}
async function GetAllUserIds() {
    const UsersFromDb = await (0, db_1.GetDb)().query.users.findMany();
    return UsersFromDb.map((user) => ({
        Username: user.name,
        UserId: user.userId
    }));
}
async function RegisterInviteCode(NewInviteCode, Uses, InfiniteUses) {
    if (typeof NewInviteCode !== "string" || NewInviteCode.trim().length === 0) {
        return false;
    }
    const ParsedUses = Number(Uses);
    if (!InfiniteUses && (!Number.isInteger(ParsedUses) || ParsedUses < 1)) {
        return false;
    }
    await (0, db_1.GetDb)().insert(schema_1.invitecodes).values({
        inviteCode: NewInviteCode.trim(),
        usesRemaining: InfiniteUses ? 0 : ParsedUses,
        infiniteUses: InfiniteUses
    });
    return true;
}
async function DeleteInviteCode(InviteCodeToDelete) {
    await (0, db_1.GetDb)().delete(schema_1.invitecodes).where((0, drizzle_orm_1.eq)(schema_1.invitecodes.inviteCode, InviteCodeToDelete));
}
async function IsUserIdAdmin(UserId) {
    const UserFromDb = await (0, db_1.GetDb)().query.users.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.users.userId, UserId) });
    return UserFromDb != undefined && UserFromDb.isAdmin;
}
async function RegisterUser(Username) {
    const UID = `UID-${(0, node_crypto_1.randomUUID)()}`;
    const UUK = `UUK_${(0, node_crypto_1.randomBytes)(24).toString("hex")}`;
    const UUKHash = (0, auth_1.HashUserAPIKey)(UUK);
    await (0, db_1.GetDb)().insert(schema_1.users).values({
        userId: UID,
        name: Username,
        notes: 0
    });
    await (0, db_1.GetDb)().insert(schema_1.userapikeys).values({
        userId: UID,
        keyHash: UUKHash
    });
    return UUK;
}
async function ValidateAndConsumeInviteCode(InviteCode) {
    if (typeof InviteCode !== "string" || InviteCode.length === 0) {
        return false;
    }
    const NormalizedInviteCode = InviteCode.trim();
    if (NormalizedInviteCode.length === 0) {
        return false;
    }
    // Avoid TOCTOU by decrement in DB statement
    const UsableInviteCode = await (0, db_1.GetDb)().update(schema_1.invitecodes).set({
        usesRemaining: (0, drizzle_orm_1.sql) `case when ${schema_1.invitecodes.infiniteUses} then ${schema_1.invitecodes.usesRemaining} else ${schema_1.invitecodes.usesRemaining} - 1 end`
    }).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.invitecodes.inviteCode, NormalizedInviteCode), (0, drizzle_orm_1.or)((0, drizzle_orm_1.eq)(schema_1.invitecodes.infiniteUses, true), (0, drizzle_orm_1.gt)(schema_1.invitecodes.usesRemaining, 0)))).returning({
        inviteCode: schema_1.invitecodes.inviteCode
    });
    return UsableInviteCode.length === 1;
}
async function UpdatePlayerActivity(UserId, Map) {
    PlayerActivityMap.set(UserId, {
        Map: Map,
        LastUpdatedTime: Date.now()
    });
}
async function UpdatePlayerLocation(UserId, HuntId) {
    PlayerLocationMap.set(UserId, {
        HuntId: HuntId,
        EnteredTime: Date.now()
    });
}
async function GetRecentPlayerData() {
    let PlayerDataToReturn = [];
    PlayerActivityMap.forEach((value, key, map) => {
        if (Date.now() - value.LastUpdatedTime <= 90 * 1000) { // If entry is < 90s old
            const PlayerLocationData = PlayerLocationMap.get(key);
            PlayerDataToReturn.push({
                UserId: key,
                Map: value.Map,
                HuntId: PlayerLocationData?.HuntId,
                EnteredHuntAt: PlayerLocationData?.EnteredTime
            });
        }
    });
    return PlayerDataToReturn;
}
async function GetUserInfoForApiKey(UserApiKey) {
    let UserId;
    if (AUTH_MODE === "NONE" && NODE_ENV !== "production") {
        UserId = UserApiKey;
    }
    else if (AUTH_MODE === "APIKEY") {
        UserId = await (0, auth_1.GetUserIDForAPIKey)(UserApiKey);
    }
    else {
        throw new Error("Unsupported Auth Mode!");
    }
    if (UserId == undefined) {
        return undefined;
    }
    const UserFromDb = await (0, db_1.GetDb)().query.users.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.users.userId, UserId) });
    if (UserFromDb == undefined) {
        return undefined;
    }
    return {
        UserId: UserId,
        Username: UserFromDb.name,
        IsAdmin: UserFromDb.isAdmin
    };
}
