// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DoesCharacterBelongToUserId = DoesCharacterBelongToUserId;
exports.GetCharactersForUid = GetCharactersForUid;
exports.CreateCharacterForUid = CreateCharacterForUid;
exports.UpdateCharacterForUid = UpdateCharacterForUid;
exports.GetCharacterWithUid = GetCharacterWithUid;
const drizzle_orm_1 = require("drizzle-orm");
const db_1 = require("../db");
const schema_1 = require("../db/schema");
const login_1 = require("./login");
const logger_1 = require("../logger");
const TARGET_CHANGELIST = process.env.TARGET_CHANGELIST;
function TransformDbCharacterToWireCharacter(DbCharacter) {
    return {
        accountId: DbCharacter.userId,
        createdDate: DbCharacter.createdDate,
        data: DbCharacter.data,
        id: DbCharacter.characterId,
        lastModifiedDate: DbCharacter.lastModifiedDate,
        name: DbCharacter.name,
        updateVersion: DbCharacter.updateVersion
    };
}
async function DoesCharacterBelongToUserId(UserId, CharacterId) {
    const Character = await (0, db_1.GetDb)().query.characters.findFirst({
        columns: { characterId: true },
        where: (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.characters.characterId, CharacterId), (0, drizzle_orm_1.eq)(schema_1.characters.userId, UserId))
    });
    return Character != undefined;
}
async function GetCharactersForUid(userId) {
    let CharactersFromDb = await (0, db_1.GetDb)().query.characters.findMany({ where: (0, drizzle_orm_1.eq)(schema_1.characters.userId, userId) });
    if (CharactersFromDb.length === 0) {
        const Username = await (0, login_1.GetUsernameForUserId)(userId);
        await CreateCharacterForUid(userId, Username);
        CharactersFromDb = await (0, db_1.GetDb)().query.characters.findMany({ where: (0, drizzle_orm_1.eq)(schema_1.characters.userId, userId) });
    }
    return CharactersFromDb.map((DbCharacter) => TransformDbCharacterToWireCharacter(DbCharacter));
}
function Pad(Target) {
    return String(Target).padStart(2, "0");
}
function ProcessTriggers(CharacterDataToUpdateWith) {
    const CharacterData = JSON.parse(CharacterDataToUpdateWith);
    if (CharacterData.SERIE_cr19_series_1_ftue != undefined) {
        const FTUESerieData = JSON.parse(CharacterData.SERIE_cr19_series_1_ftue);
        if (FTUESerieData["929A333B40E413C41E47B0A425EC3349"].Status === 3 && CharacterData["SERIE_dojo"] == undefined) {
            logger_1.logger.info(`Injecting SERIE_dojo!`);
            CharacterData["SERIE_dojo"] = "{\"ID\":\"Dojo\",\"Status\":0,\"62B91BD94558409B4F7352B5B96F3ED7\":{\"Status\":0,\"6CA2C43B46334BC06F73DEB5F2BFFEC1\":{\"Status\":0,\"CurrentAmount\":0,\"LastUpdateAmount\":0},\"3A7241AA43743647D3C1E39E8976E4F3\":{\"Status\":0,\"CurrentAmount\":0,\"LastUpdateAmount\":0}},\"816CBFD94D16EDA252BD1D8461209568\":{\"Status\":1},\"B152371947599B3C2D55BE9B91439C37\":{\"Status\":0,\"D3F19E2248AECEF5C5C3C8B9E2AC2C67\":{\"Status\":0,\"CurrentAmount\":0,\"LastUpdateAmount\":0},\"0407C2134FE0BEFE3EC791999632D2BC\":{\"Status\":0,\"CurrentAmount\":0,\"LastUpdateAmount\":0}},\"DFE54F884C6FC60688B6C494D79ADD29\":{\"Status\":0,\"9D1B0D754DBC896034F942AD625F9D93\":{\"Status\":0,\"CurrentAmount\":0,\"LastUpdateAmount\":0}}}";
        }
    }
    return JSON.stringify(CharacterData);
}
async function CreateCharacterForUid(userId, characterName) {
    let CharacterUUID = crypto.randomUUID();
    let CurrentDate = new Date();
    let FormattedCurrentDate = CurrentDate.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric"
    });
    let NewCharacter = await (0, db_1.GetDb)().insert(schema_1.characters).values({
        characterId: CharacterUUID,
        userId: userId,
        name: characterName,
        createdDate: FormattedCurrentDate,
        lastModifiedDate: FormattedCurrentDate,
        updateVersion: 0,
        data: "{}"
    }).returning();
    return TransformDbCharacterToWireCharacter(NewCharacter[0]);
}
async function UpdateCharacterForUid(CharacterId, UserId, CharacterDataToUpdateWith, UpdateVersion) {
    const CurrentData = await GetCharacterWithUid(CharacterId, UserId);
    if (CurrentData.updateVersion >= UpdateVersion) {
        return false;
    }
    CharacterDataToUpdateWith = ProcessTriggers(CharacterDataToUpdateWith);
    await (0, db_1.GetDb)().update(schema_1.characters).set({
        data: CharacterDataToUpdateWith,
        updateVersion: UpdateVersion
    }).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.characters.userId, UserId), (0, drizzle_orm_1.eq)(schema_1.characters.characterId, CharacterId)), (0, drizzle_orm_1.lt)(schema_1.characters.updateVersion, UpdateVersion)));
    return true;
}
async function GetCharacterWithUid(CharacterId, UserId) {
    const Character = await (0, db_1.GetDb)().query.characters.findFirst({ where: (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.characters.characterId, CharacterId), (0, drizzle_orm_1.eq)(schema_1.characters.userId, UserId)) });
    if (Character == undefined) {
        return undefined;
    }
    return TransformDbCharacterToWireCharacter(Character);
}
