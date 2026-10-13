// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HasUndauntedMetagameAuth = HasUndauntedMetagameAuth;
const logger_1 = require("../logger");
const auth_1 = require("../controllers/auth");
const apikeys_1 = require("../controllers/apikeys");
async function HasUndauntedMetagameAuth(req, res, next) {
    const AuthHeader = req.headers.authorization;
    const GameserverAuthHeader = req.headers["x-undaunted-gameserver-apikey"];
    if (GameserverAuthHeader !== undefined) {
        const IsValid = await (0, apikeys_1.IsValidGameserverAPIKey)(GameserverAuthHeader);
        if (IsValid) {
            if (AuthHeader != undefined) { // Why this double-auth amalgam? Sometimes the client sends it's Bearer auth to the server, and the server makes reqs where the only userId identifying factor is that auth token. This fixes that up, so we have that context.
                const Token = AuthHeader.slice("bearer ".length);
                const Payload = (0, auth_1.ValidateMetagameJWTAndGetPayload)(Token);
                req.AuthData = {
                    IsGameserver: true,
                    ...Payload
                };
            }
            else {
                req.AuthData = {
                    IsGameserver: true,
                };
            }
            next();
            return;
        }
        else {
            res.status(401);
            res.send();
            logger_1.logger.error(`Invalid Gameserver API Key Auth`);
            return;
        }
    }
    if (AuthHeader == undefined || (!AuthHeader?.startsWith("bearer ") && !AuthHeader?.startsWith("Bearer ") && !AuthHeader?.startsWith("BEARER "))) {
        res.status(401);
        res.send();
        logger_1.logger.error(`Unauthenticated ${req.method} to ${req.path} which needs Undaunted Metagame auth!`);
        return;
    }
    const Token = AuthHeader.slice("bearer ".length);
    try {
        const Payload = (0, auth_1.ValidateMetagameJWTAndGetPayload)(Token);
        req.AuthData = Payload;
        next();
    }
    catch {
        res.status(401);
        res.send();
        logger_1.logger.warn("Request with bad Undaunted Metagame auth!");
        return;
    }
}
