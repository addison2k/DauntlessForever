// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.characterRouter = void 0;
const express_1 = require("express");
const logger_1 = require("../logger");
const HasUndauntedMetagameAuth_1 = require("../middleware/HasUndauntedMetagameAuth");
const character_1 = require("../controllers/character");
exports.characterRouter = (0, express_1.Router)();
exports.characterRouter.get("/character", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const UserId = req.AuthData.userId;
    const CharactersForUid = await (0, character_1.GetCharactersForUid)(UserId);
    logger_1.logger.info(`Retrieved ${CharactersForUid.length} characters for ${UserId}`);
    res.status(200);
    res.json(CharactersForUid);
});
exports.characterRouter.put("/character", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const CharacterNameToCreate = req.body.name;
    logger_1.logger.info(`Creating a character named ${CharacterNameToCreate} for user ${req.AuthData.userId}`);
    let NewCharacter = await (0, character_1.CreateCharacterForUid)(req.AuthData.userId, CharacterNameToCreate);
    res.status(200);
    res.json(NewCharacter);
});
exports.characterRouter.post("/character", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const CharacterIdToUpdate = req.body.characterId;
    const UserId = req.AuthData.userId;
    const DataToUpdateWith = req.body.data;
    const UpdateVersion = req.body.updateVersion;
    logger_1.logger.info(`Updating characterId ${CharacterIdToUpdate} for userId ${UserId} with updateVersion ${UpdateVersion}`);
    const DidSucceed = await (0, character_1.UpdateCharacterForUid)(CharacterIdToUpdate, UserId, DataToUpdateWith, UpdateVersion);
    if (!DidSucceed) {
        logger_1.logger.warn(`Failed to update characterId ${CharacterIdToUpdate} for userId ${UserId} due to conflict`);
        res.status(409);
        res.send();
        return;
    }
    const UpdatedCharacter = await (0, character_1.GetCharacterWithUid)(CharacterIdToUpdate, UserId);
    res.status(200);
    res.json(UpdatedCharacter);
});
