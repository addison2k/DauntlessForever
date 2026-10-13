// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadoutRouter = void 0;
const express_1 = require("express");
const HasUndauntedMetagameAuth_1 = require("../middleware/HasUndauntedMetagameAuth");
const loadout_1 = require("../controllers/loadout");
const logger_1 = require("../logger");
exports.loadoutRouter = (0, express_1.Router)();
// The full loadout state the game expects (all saved slots, persistent data, slot counts, active slot)
async function LoadoutPayload(UserId, CharacterId) {
    const Loadouts = await (0, loadout_1.GetAllLoadoutsForUserIdAndCharacterId)(UserId, CharacterId);
    const Persistent = await (0, loadout_1.GetPersistentLoadoutForUserIdAndCharacterId)(UserId, CharacterId); // TODO: WARN: Ordering of this and the GetAllLoadoutsForUserIdAndCharacterId MUST NOT CHANGE until create-on-nonexistent is added in the loadout controller
    logger_1.logger.info(`Fetched ${Loadouts.length} loadout(s) for userId ${UserId} and characterId ${CharacterId}`);
    return {
        loadouts: Loadouts,
        persistent: Persistent,
        num_account_slots: 1,
        max_account_slots: 1,
        num_character_slots: loadout_1.MAX_LOADOUT_SLOTS,
        max_character_slots: loadout_1.MAX_LOADOUT_SLOTS,
        active_index: (0, loadout_1.GetActiveLoadoutIndex)(UserId, CharacterId),
        needs_migration: false
    };
}
exports.loadoutRouter.get("/loadout/:userId/:characterId/all", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const RequestorAccountId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;
    const CharacterId = req.params.characterId;
    res.status(200);
    res.json({ code: null, message: "OK", payload: await LoadoutPayload(RequestorAccountId, CharacterId) });
});
// Switch the active loadout slot
exports.loadoutRouter.post("/loadout/:userId/:characterId/active/:index", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const RequestorAccountId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;
    const CharacterId = req.params.characterId;
    if (!(0, loadout_1.SetActiveLoadoutIndex)(RequestorAccountId, CharacterId, String(req.params.index))) {
        res.status(400);
        res.send();
        return;
    }
    res.status(200);
    res.json({ code: null, message: "OK", payload: await LoadoutPayload(RequestorAccountId, CharacterId) });
});
exports.loadoutRouter.post("/loadout/:userId/:characterId/:index", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const RequestorAccountId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const Data = req.body.data;
    const Index = String(req.params.index);
    const Success = await (0, loadout_1.SetLoadoutDataForUserIdAndCharacterId)(RequestorAccountId, CharacterId, Index, Data);
    if (Success) {
        logger_1.logger.info(`Successfully updated loadout index ${Index} for userId ${RequestorAccountId} and characterId ${CharacterId}`);
        res.status(200);
        res.json({ code: null, message: "OK", payload: await LoadoutPayload(RequestorAccountId, CharacterId) });
    }
    else {
        logger_1.logger.error(`Failed to update loadout index ${Index} for userId ${RequestorAccountId} and characterId ${CharacterId}`);
        res.status(400);
        res.send();
    }
});
