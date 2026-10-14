// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import { Router } from "express";
import { logger } from "../logger";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { GetDb } from "../db";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";
import { GetUsernameForUserId } from "../controllers/login";
import { FindAccountByName, FindUsername } from "../controllers/social162";

export const loginRouter = Router();

loginRouter.get("/features/platform/win", (req, res) => {
    logger.info("Features");

    res.send({
        "code" : null,
        "message" : "OK",
        "payload" : {
           "crossplay" : true,
           "crossprogression" : true
        }
    });
});

loginRouter.get("/account/link/epic/:AccId", (req, res) => {
    logger.info("Account Linking");

    res.json({
        "code" : null,
        "message" : "OK",
        "payload" : {
           "isLinked" : true
        }
    });
});

loginRouter.post("/login", HasUndauntedMetagameAuth, async (req: any, res) => {
    if(req.AuthData.userId !== req.body.email){
        res.status(400);
        res.send();

        logger.error(`UserID from Undaunted Auth ${req.AuthData.userId} didn't match UserID from token ${req.AuthData.email}`);

        return;
    }

    let UserRecord = await GetDb().query.users.findFirst({where: eq(users.userId, req.AuthData.userId)});

    if(UserRecord == undefined){
        res.status(400);
        res.send();

        logger.error(`UserID from Undaunted Auth ${req.AuthData.userId} had no database entry!`);

        return;
    }

    logger.info(`${req.body.email} is logging in!`);

    res.json({
        "error_code": "TicketRateOk",
        "message": "",
        "state": "OPEN",
        "timeout": 8000,
        "title": ""
    });
});

loginRouter.get("/accountinfo", HasUndauntedMetagameAuth, async (req: any, res) => {
    logger.info("Account info")

    const Username = await GetUsernameForUserId(req.AuthData.userId);

    res.json({
        "accountId" : req.AuthData.userId,
        "creationDate" : "2000-01-01 00:00:00",
        "email" : null,
        "preferredLanguage" : null,
        "username" : Username,
        "verified" : true
    });
});

loginRouter.get("/tags", HasUndauntedMetagameAuth, (req: any, res) => {
    logger.info("Tags")

    res.json({
        "accountId" : req.AuthData.userId,
        "tags": []
    });
});

loginRouter.put("/gamesession/epic", HasUndauntedMetagameAuth, (req: any, res) => {
    const AuthHeader = req.headers.authorization;

    const Token = AuthHeader.slice("bearer ".length);

    // A note on auth tokens:
    // The original flow went Epic Launcher -> Epic -> PHX
    // With each step having it's own auth token.
    // Since this is unneeded complexity for us, we just use the same token for all 3
    // Hence this echo endpoint

    res.json({
        "code": null,
        "message": "OK",
        "payload": {
            "error_code": null,
            "sessionid": "SESSION_ID_LOL", // TODO: This is surfaced in the UI, but I don't think it matters for anything else
            "sessionToken": Token 
        }
    })
});

// POST /accountinfo/public: the game looks up OTHER players here (party invite senders, party members,
// friends), body {"accountId": <id>} or {"displayname": <name>}. The reply must describe the LOOKED-UP
// account: the game files it under the reply's accountId (the first reply per id wins for the session).
// The old reply carried the caller's own id, so other players never showed (Dauntless Revived's finding).
loginRouter.post("/accountinfo/public", HasUndauntedMetagameAuth, async (req: any, res) => {
    const AskedId = req.body?.accountId;
    let Found: { UserId: string, Username: string } | undefined;
    if(AskedId !== undefined && AskedId !== null && AskedId !== ""){
        const Name = await FindUsername(AskedId);
        Found = Name !== undefined ? { UserId: AskedId, Username: Name } : undefined;
    } else {
        Found = await FindAccountByName(req.body?.displayname ?? req.body?.displayName);
    }
    if(!Found){
        res.status(404);
        res.json({});
        return;
    }
    res.status(200);
    res.json({
        accountId: Found.UserId,
        isSubscribed: true,
        language: null,
        linkedAccounts: [
            {
                accountId: Found.UserId,
                accountType: "epic"
            }
        ],
        username: Found.Username
    });
});
