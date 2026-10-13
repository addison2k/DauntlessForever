// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.undauntedApiRouter = void 0;
const express_1 = require("express");
const undauntedapi_1 = require("../controllers/undauntedapi");
const HasUndauntedUserApiKey_1 = require("../middleware/HasUndauntedUserApiKey");
const HasUndauntedAdminApiKey_1 = require("../middleware/HasUndauntedAdminApiKey");
const auth_1 = require("../controllers/auth");
exports.undauntedApiRouter = (0, express_1.Router)();
exports.undauntedApiRouter.get("/RegistrationStatus", (req, res) => {
    res.status(200);
    res.json({
        RegistrationMode: undauntedapi_1.REGISTRATION_MODE
    });
});
exports.undauntedApiRouter.post("/RegistrationStatus", HasUndauntedAdminApiKey_1.HasUndauntedAdminApiKey, (req, res) => {
    const NewRegistrationStatus = req.body.RegistrationStatus;
    if (!(0, undauntedapi_1.SetRegistrationMode)(NewRegistrationStatus)) {
        res.status(400);
        res.send();
        return;
    }
    res.status(200);
    res.send();
});
exports.undauntedApiRouter.get("/InviteCodes", HasUndauntedAdminApiKey_1.HasUndauntedAdminApiKey, async (req, res) => {
    const InviteCodes = await (0, undauntedapi_1.GetInviteCodes)();
    res.status(200);
    res.json({
        InviteCodes: InviteCodes
    });
});
exports.undauntedApiRouter.post("/GenerateJWTForUserId", HasUndauntedAdminApiKey_1.HasUndauntedAdminApiKey, async (req, res) => {
    const UserId = req.body.UserId;
    const JWT = await (0, auth_1.SignMetagameJWTForUid)(UserId);
    res.status(200);
    res.send({
        JWT: JWT
    });
});
exports.undauntedApiRouter.get("/GetAllUsers", HasUndauntedAdminApiKey_1.HasUndauntedAdminApiKey, async (req, res) => {
    const AllUsers = await (0, undauntedapi_1.GetAllUserIds)();
    res.status(200);
    res.send({
        Users: AllUsers
    });
});
exports.undauntedApiRouter.post("/RegisterInviteCode", HasUndauntedAdminApiKey_1.HasUndauntedAdminApiKey, async (req, res) => {
    const NewInviteCode = req.body.NewInviteCode;
    const Uses = req.body.Uses;
    const InfiniteUses = !!req.body.InfiniteUses;
    if (!await (0, undauntedapi_1.RegisterInviteCode)(NewInviteCode, Uses, InfiniteUses)) {
        res.status(400);
        res.send();
        return;
    }
    res.status(200);
    res.send();
});
exports.undauntedApiRouter.delete("/InviteCode/:inviteCodeToDelete", HasUndauntedAdminApiKey_1.HasUndauntedAdminApiKey, async (req, res) => {
    const InviteCodeToDelete = req.params.inviteCodeToDelete;
    await (0, undauntedapi_1.DeleteInviteCode)(InviteCodeToDelete);
    res.status(200);
    res.send();
});
exports.undauntedApiRouter.post("/Register", async (req, res) => {
    if (!(0, undauntedapi_1.IsRegistrationMode)(undauntedapi_1.REGISTRATION_MODE)) {
        res.status(500);
        res.send();
        return;
    }
    if (undauntedapi_1.REGISTRATION_MODE === "NONE") {
        res.status(400);
        res.send();
        return;
    }
    const Username = req.body.Username;
    if (typeof Username !== "string" || Username.trim().length === 0) {
        res.status(400);
        res.send();
        return;
    }
    if (undauntedapi_1.REGISTRATION_MODE === "INVITECODE") {
        const InviteCode = req.body.InviteCode;
        if (await (0, undauntedapi_1.ValidateAndConsumeInviteCode)(InviteCode)) {
            const UUK = await (0, undauntedapi_1.RegisterUser)(Username);
            res.status(200);
            res.json({
                UUK: UUK
            });
        }
        else {
            res.status(401);
            res.send();
        }
    }
    else if (undauntedapi_1.REGISTRATION_MODE === "OPEN") {
        const UUK = await (0, undauntedapi_1.RegisterUser)(Username);
        res.status(200);
        res.json({
            UUK: UUK
        });
    }
});
exports.undauntedApiRouter.get("/GetUserInfo", HasUndauntedUserApiKey_1.HasUndauntedUserApiKey, async (req, res) => {
    res.status(200);
    res.json(req.UndauntedUserInfo);
});
exports.undauntedApiRouter.get("/PrivateOnlineStats", HasUndauntedAdminApiKey_1.HasUndauntedAdminApiKey, async (req, res) => {
    const PlayerData = await (0, undauntedapi_1.GetRecentPlayerData)();
    res.status(200);
    res.json(PlayerData);
});
exports.undauntedApiRouter.get("/PublicOnlineStats", HasUndauntedUserApiKey_1.HasUndauntedUserApiKey, async (req, res) => {
    const PlayerData = await (0, undauntedapi_1.GetRecentPlayerData)();
    res.status(200);
    res.json({
        NumActivePlayers: PlayerData.length
    });
});
