import { and, eq } from "drizzle-orm";
import { GetDb } from "../db";
import { breadcrumbs, encounteredcontent } from "../db/schema";
import { logger } from "../logger";
import { DoesCharacterBelongToUserId } from "./character";

export type ProgressionError = "forbidden" | "conflict" | "invalid_data" | "db_error";
export type ProgressionResult<T = void> = {success: true, data?: T} | {success: false, error: ProgressionError};

class ProgressionConflictError extends Error {
    constructor(message: string){
        super(message);
        this.name = "ProgressionConflictError";
    }
}

function EncounteredContentFor(userId: string, characterId: string){
    return and(eq(encounteredcontent.userId, userId), eq(encounteredcontent.characterId, characterId));
}

function BreadcrumbsFor(userId: string, characterId: string){
    return and(eq(breadcrumbs.userId, userId), eq(breadcrumbs.characterId, characterId));
}

async function RunProgressionOperation<T>(userId: string, characterId: string, invalidDataMessage: string, dbErrorMessage: string, Operation: () => Promise<T> | T): Promise<ProgressionResult<T>>{
    if(!await DoesCharacterBelongToUserId(userId, characterId)){
        logger.error(`Specified characterId ${characterId} does not belong to user ${userId}`);
        return {success: false, error: "forbidden"};
    }

    try{
        return {success: true, data: await Operation()};
    }
    catch(error){
        if(error instanceof ProgressionConflictError){
            logger.warn(error.message);
            return {success: false, error: "conflict"};
        }

        if(error instanceof SyntaxError){
            logger.error(error, invalidDataMessage);
            return {success: false, error: "invalid_data"};
        }

        logger.error(error, dbErrorMessage);
        return {success: false, error: "db_error"};
    }
}

export async function QueryEncounteredContent(userId: string, characterId: string, categoriesToQuery: number[]): Promise<ProgressionResult<any[]>>{
    logger.info(`Querying ${categoriesToQuery.length} categories for userId ${userId} and characterId ${characterId}`);

    return RunProgressionOperation(
        userId,
        characterId,
        `Invalid encountered content data for characterId ${characterId} and userId ${userId}`,
        `Failed to query encountered content for characterId ${characterId} and userId ${userId}`,
        async () => {
            const EncounteredContentFromDB = await GetDb().query.encounteredcontent.findFirst({where: EncounteredContentFor(userId, characterId)});
            const EncounteredContent = JSON.parse(EncounteredContentFromDB?.encounteredcontent ?? "[]");

            return categoriesToQuery.map((Category) => ({
                content: EncounteredContent.filter((Content: any) => Number(Content.category) == Number(Category)).map((Content: any) => Content.content),
                content_type: Number(Category),
            }));
        }
    );
}

export async function AddEncounteredContent(userId: string, characterId: string, contentType: number, contentId: string): Promise<ProgressionResult>{
    return RunProgressionOperation(
        userId,
        characterId,
        `Invalid encountered content data while adding ${contentId} for characterId ${characterId} and userId ${userId}`,
        `Failed to add encountered content ${contentId} for characterId ${characterId} and userId ${userId}`,
        async () => {
            const EncounteredContentFromDB = await GetDb().query.encounteredcontent.findFirst({where: EncounteredContentFor(userId, characterId)});

            if(EncounteredContentFromDB == undefined){
                await GetDb().insert(encounteredcontent).values({userId: userId, characterId: characterId, encounteredcontent: "[]"});
            }

            const ParsedEncounteredContent = JSON.parse(EncounteredContentFromDB?.encounteredcontent ?? "[]");

            if(ParsedEncounteredContent.some((Content: any) => Number(Content.category) == Number(contentType) && Content.content == contentId)){
                return;
            }

            ParsedEncounteredContent.push({
                content: contentId,
                category: contentType
            });

            await GetDb().update(encounteredcontent).set({
                encounteredcontent: JSON.stringify(ParsedEncounteredContent),
            }).where(EncounteredContentFor(userId, characterId));
        }
    );
}

export async function GetBreadcrumbsForCharacterIdAndUserId(userId: string, characterId: string): Promise<ProgressionResult<{breadcrumbs: any[], updateVersion: number}>>{
    return RunProgressionOperation(
        userId,
        characterId,
        `Invalid breadcrumb data for characterId ${characterId} and userId ${userId}`,
        `Failed to fetch breadcrumbs for characterId ${characterId} and userId ${userId}`,
        async () => {
            const BreadcrumbsFromDB = await GetDb().query.breadcrumbs.findFirst({where: BreadcrumbsFor(userId, characterId)});

            if(BreadcrumbsFromDB == undefined){
                logger.info(`Creating new breadcrumbs entry for character ${characterId}`);

                await GetDb().insert(breadcrumbs).values({
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
        }
    );
}

export async function SetBreadcrumbsForCharacterIdAndUserId(userId: string, characterId: string, breadcrumbsFromUser: any, updateVersion: number): Promise<ProgressionResult<{breadcrumbs: any, updateVersion: number}>>{
    return RunProgressionOperation(
        userId,
        characterId,
        `Invalid breadcrumb data while setting breadcrumbs for characterId ${characterId} and userId ${userId}`,
        `Failed to set breadcrumbs for characterId ${characterId} and userId ${userId}`,
        async () => {
            const BreadcrumbsFromDB = await GetDb().query.breadcrumbs.findFirst({where: BreadcrumbsFor(userId, characterId)});

            if(BreadcrumbsFromDB == undefined){
                logger.info(`Creating new breadcrumbs entry for character ${characterId}`);

                await GetDb().insert(breadcrumbs).values({
                    breadcrumbs: JSON.stringify(breadcrumbsFromUser),
                    updateVersion: updateVersion,
                    userId: userId,
                    characterId: characterId
                });
            }
            else if(BreadcrumbsFromDB.updateVersion >= updateVersion){
                throw new ProgressionConflictError(`Refusing stale breadcrumbs update for characterId ${characterId} and userId ${userId}: current updateVersion ${BreadcrumbsFromDB.updateVersion}, incoming updateVersion ${updateVersion}`);
            }
            else{
                logger.info(`Updating breadcrumbs entry for character ${characterId} with updateVersion ${updateVersion}`);

                await GetDb().update(breadcrumbs).set({
                    breadcrumbs: JSON.stringify(breadcrumbsFromUser),
                    updateVersion: updateVersion
                }).where(BreadcrumbsFor(userId, characterId));
            }

            return {
                breadcrumbs: breadcrumbsFromUser,
                updateVersion: updateVersion
            };
        }
    );
}
