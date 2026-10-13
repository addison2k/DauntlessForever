// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueryEncounteredContent = QueryEncounteredContent;
exports.AddEncounteredContent = AddEncounteredContent;
exports.GetBreadcrumbsForCharacterIdAndUserId = GetBreadcrumbsForCharacterIdAndUserId;
exports.SetBreadcrumbsForCharacterIdAndUserId = SetBreadcrumbsForCharacterIdAndUserId;
const drizzle_orm_1 = require("drizzle-orm");
const db_1 = require("../db");
const schema_1 = require("../db/schema");
const logger_1 = require("../logger");
const character_1 = require("./character");
class ProgressionConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = "ProgressionConflictError";
    }
}
function EncounteredContentFor(userId, characterId) {
    return (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.encounteredcontent.userId, userId), (0, drizzle_orm_1.eq)(schema_1.encounteredcontent.characterId, characterId));
}
function BreadcrumbsFor(userId, characterId) {
    return (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.breadcrumbs.userId, userId), (0, drizzle_orm_1.eq)(schema_1.breadcrumbs.characterId, characterId));
}
async function RunProgressionOperation(userId, characterId, invalidDataMessage, dbErrorMessage, Operation) {
    if (!await (0, character_1.DoesCharacterBelongToUserId)(userId, characterId)) {
        logger_1.logger.error(`Specified characterId ${characterId} does not belong to user ${userId}`);
        return { success: false, error: "forbidden" };
    }
    try {
        return { success: true, data: await Operation() };
    }
    catch (error) {
        if (error instanceof ProgressionConflictError) {
            logger_1.logger.warn(error.message);
            return { success: false, error: "conflict" };
        }
        if (error instanceof SyntaxError) {
            logger_1.logger.error(error, invalidDataMessage);
            return { success: false, error: "invalid_data" };
        }
        logger_1.logger.error(error, dbErrorMessage);
        return { success: false, error: "db_error" };
    }
}
async function QueryEncounteredContent(userId, characterId, categoriesToQuery) {
    logger_1.logger.info(`Querying ${categoriesToQuery.length} categories for userId ${userId} and characterId ${characterId}`);
    return RunProgressionOperation(userId, characterId, `Invalid encountered content data for characterId ${characterId} and userId ${userId}`, `Failed to query encountered content for characterId ${characterId} and userId ${userId}`, async () => {
        const EncounteredContentFromDB = await (0, db_1.GetDb)().query.encounteredcontent.findFirst({ where: EncounteredContentFor(userId, characterId) });
        const EncounteredContent = JSON.parse(EncounteredContentFromDB?.encounteredcontent ?? "[]");
        return categoriesToQuery.map((Category) => ({
            content: EncounteredContent.filter((Content) => Number(Content.category) == Number(Category)).map((Content) => Content.content),
            content_type: Number(Category),
        }));
    });
}
async function AddEncounteredContent(userId, characterId, contentType, contentId) {
    return RunProgressionOperation(userId, characterId, `Invalid encountered content data while adding ${contentId} for characterId ${characterId} and userId ${userId}`, `Failed to add encountered content ${contentId} for characterId ${characterId} and userId ${userId}`, async () => {
        const EncounteredContentFromDB = await (0, db_1.GetDb)().query.encounteredcontent.findFirst({ where: EncounteredContentFor(userId, characterId) });
        if (EncounteredContentFromDB == undefined) {
            await (0, db_1.GetDb)().insert(schema_1.encounteredcontent).values({ userId: userId, characterId: characterId, encounteredcontent: "[]" });
        }
        const ParsedEncounteredContent = JSON.parse(EncounteredContentFromDB?.encounteredcontent ?? "[]");
        if (ParsedEncounteredContent.some((Content) => Number(Content.category) == Number(contentType) && Content.content == contentId)) {
            return;
        }
        ParsedEncounteredContent.push({
            content: contentId,
            category: contentType
        });
        await (0, db_1.GetDb)().update(schema_1.encounteredcontent).set({
            encounteredcontent: JSON.stringify(ParsedEncounteredContent),
        }).where(EncounteredContentFor(userId, characterId));
    });
}
async function GetBreadcrumbsForCharacterIdAndUserId(userId, characterId) {
    return RunProgressionOperation(userId, characterId, `Invalid breadcrumb data for characterId ${characterId} and userId ${userId}`, `Failed to fetch breadcrumbs for characterId ${characterId} and userId ${userId}`, async () => {
        const BreadcrumbsFromDB = await (0, db_1.GetDb)().query.breadcrumbs.findFirst({ where: BreadcrumbsFor(userId, characterId) });
        if (BreadcrumbsFromDB == undefined) {
            logger_1.logger.info(`Creating new breadcrumbs entry for character ${characterId}`);
            await (0, db_1.GetDb)().insert(schema_1.breadcrumbs).values({
                breadcrumbs: "[]",
                updateVersion: 0,
                userId: userId,
                characterId: characterId
            });
        }
        return {
            breadcrumbs: JSON.parse(BreadcrumbsFromDB?.breadcrumbs ?? "[]"),
            updateVersion: BreadcrumbsFromDB?.updateVersion ?? 0
        };
    });
}
async function SetBreadcrumbsForCharacterIdAndUserId(userId, characterId, breadcrumbsFromUser, updateVersion) {
    return RunProgressionOperation(userId, characterId, `Invalid breadcrumb data while setting breadcrumbs for characterId ${characterId} and userId ${userId}`, `Failed to set breadcrumbs for characterId ${characterId} and userId ${userId}`, async () => {
        const BreadcrumbsFromDB = await (0, db_1.GetDb)().query.breadcrumbs.findFirst({ where: BreadcrumbsFor(userId, characterId) });
        if (BreadcrumbsFromDB == undefined) {
            logger_1.logger.info(`Creating new breadcrumbs entry for character ${characterId}`);
            await (0, db_1.GetDb)().insert(schema_1.breadcrumbs).values({
                breadcrumbs: JSON.stringify(breadcrumbsFromUser),
                updateVersion: updateVersion,
                userId: userId,
                characterId: characterId
            });
        }
        else if (BreadcrumbsFromDB.updateVersion >= updateVersion) {
            throw new ProgressionConflictError(`Refusing stale breadcrumbs update for characterId ${characterId} and userId ${userId}: current updateVersion ${BreadcrumbsFromDB.updateVersion}, incoming updateVersion ${updateVersion}`);
        }
        else {
            logger_1.logger.info(`Updating breadcrumbs entry for character ${characterId} with updateVersion ${updateVersion}`);
            await (0, db_1.GetDb)().update(schema_1.breadcrumbs).set({
                breadcrumbs: JSON.stringify(breadcrumbsFromUser),
                updateVersion: updateVersion
            }).where(BreadcrumbsFor(userId, characterId));
        }
        return {
            breadcrumbs: breadcrumbsFromUser,
            updateVersion: updateVersion
        };
    });
}
