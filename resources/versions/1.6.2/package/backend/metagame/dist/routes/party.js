// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.partyRouter = void 0;
const express_1 = require("express");
const HasUndauntedMetagameAuth_1 = require("../middleware/HasUndauntedMetagameAuth");
const logger_1 = require("../logger");
const login_1 = require("../controllers/login");
// TODO: Party functionality will be coming very soon (tm), for now this is just a stub
exports.partyRouter = (0, express_1.Router)();
exports.partyRouter.post("/party", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const UserId = req.AuthData.userId;
    const Username = (0, login_1.GetUsernameForUserId)(UserId);
    logger_1.logger.info("Get Party State (stubbed)");
    res.status(200);
    res.json({
        candidateId: "CANDIDATE_ID_LOL",
        candidateState: "QUEUED_FOR_START",
        gauntletLevel: null,
        leaderPlayerId: UserId,
        partyId: UserId, // TODO: Switch to tracked UUID
        playerHuntId: null, // TODO: Make current Hunt ID
        playerStates: [
            {
                consoleSessionId: null,
                displayName: Username,
                isMemberOfCandidate: true,
                platform: "win",
                playerId: UserId
            }
        ]
    });
});
exports.partyRouter.get("/party/invites", (req, res) => {
    logger_1.logger.info("Get Party Invites (stubbed)");
    res.status(200);
    res.json({
        invitations: []
    });
});
