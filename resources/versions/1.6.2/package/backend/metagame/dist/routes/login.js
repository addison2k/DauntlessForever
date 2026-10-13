// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loginRouter = void 0;
const express_1 = require("express");
const logger_1 = require("../logger");
const HasUndauntedMetagameAuth_1 = require("../middleware/HasUndauntedMetagameAuth");
const db_1 = require("../db");
const schema_1 = require("../db/schema");
const drizzle_orm_1 = require("drizzle-orm");
const login_1 = require("../controllers/login");
exports.loginRouter = (0, express_1.Router)();
exports.loginRouter.get("/features/platform/win", (req, res) => {
    logger_1.logger.info("Features");
    res.send({
        "code": null,
        "message": "OK",
        "payload": {
            "crossplay": true,
            "crossprogression": true
        }
    });
});
exports.loginRouter.get("/account/link/epic/:AccId", (req, res) => {
    logger_1.logger.info("Account Linking");
    res.json({
        "code": null,
        "message": "OK",
        "payload": {
            "isLinked": true
        }
    });
});
exports.loginRouter.post("/login", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    if (req.AuthData.userId !== req.body.email) {
        res.status(400);
        res.send();
        logger_1.logger.error(`UserID from Undaunted Auth ${req.AuthData.userId} didn't match UserID from token ${req.AuthData.email}`);
        return;
    }
    let UserRecord = await (0, db_1.GetDb)().query.users.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.users.userId, req.AuthData.userId) });
    if (UserRecord == undefined) {
        res.status(400);
        res.send();
        logger_1.logger.error(`UserID from Undaunted Auth ${req.AuthData.userId} had no database entry!`);
        return;
    }
    logger_1.logger.info(`${req.body.email} is logging in!`);
    res.json({
        "error_code": "TicketRateOk",
        "message": "",
        "state": "OPEN",
        "timeout": 8000,
        "title": ""
    });
});
exports.loginRouter.get("/accountinfo", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    logger_1.logger.info("Account info");
    const Username = await (0, login_1.GetUsernameForUserId)(req.AuthData.userId);
    res.json({
        "accountId": req.AuthData.userId,
        "creationDate": "2000-01-01 00:00:00",
        "email": null,
        "preferredLanguage": null,
        "username": Username,
        "verified": true
    });
});
exports.loginRouter.get("/tags", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    logger_1.logger.info("Tags");
    res.json({
        "accountId": req.AuthData.userId,
        "tags": []
    });
});
exports.loginRouter.put("/gamesession/epic", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
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
    });
});
exports.loginRouter.post("/accountinfo/public", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const AccountIdToLookupFromRequest = req.body.accountId;
    const RequestorAccountId = req.AuthData.userId;
    const Username = await (0, login_1.GetUsernameForUserId)(AccountIdToLookupFromRequest);
    // We allow anybody to look up anybody's username from account id
    res.status(200);
    res.json({
        accountId: RequestorAccountId,
        isSubscribed: true,
        language: null,
        linkedAccounts: [
            {
                accountId: RequestorAccountId,
                accountType: "epic"
            }
        ],
        username: Username
    });
});
