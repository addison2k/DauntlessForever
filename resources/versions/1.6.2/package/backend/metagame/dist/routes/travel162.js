// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
// Compiled from src/travel162.ts and src/routes/travel162.ts (your character travels with you to a friend's game).
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.travelRouter = void 0;
// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
//
// Your character travels with you (travel162.ts): a friend's launcher, joining this backend through the relay
// or the LAN, sends its own character here before the game starts and takes it home when the game closes.
// Both calls use the account key the joiner was given (X-Undaunted-User-Api-Key), so a joiner can only ever
// read or replace their own account here, never the host's or anyone else's.
const express_1 = require("express");
const node_path_1 = __importDefault(require("node:path"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3");
const logger_1 = require("../logger");
const HasUndauntedUserApiKey_1 = require("../middleware/HasUndauntedUserApiKey");
const travel162_1 = require("../travel162");
const travelRouter = (0, express_1.Router)();
exports.travelRouter = travelRouter;
let raw = null;
const Db = () => raw || (raw = new Database(process.env.DB_FILENAME || "./undaunted.db"));
const DataDir = () => node_path_1.default.dirname(process.env.DB_FILENAME || "./undaunted.db");
travelRouter.post("/undaunted/api/travel/import", HasUndauntedUserApiKey_1.HasUndauntedUserApiKey, (req, res) => {
    const Who = req.UndauntedUserInfo;
    try {
        const r = (0, travel162_1.ImportAccount)(Db(), DataDir(), Who.UserId, req.body && req.body.bundle, "joined");
        logger_1.logger.info(`travel: ${Who.Username} brought their character here (${r.characters} character(s), ${r.files} file(s))`);
        res.json({ ok: true, ...r });
    }
    catch (e) {
        logger_1.logger.warn(`travel: ${Who.Username} could not bring their character: ${e.message}`);
        res.status(400).json({ ok: false, error: e.message });
    }
});
travelRouter.get("/undaunted/api/travel/export", HasUndauntedUserApiKey_1.HasUndauntedUserApiKey, (req, res) => {
    const Who = req.UndauntedUserInfo;
    try {
        const b = (0, travel162_1.ExportAccount)(Db(), DataDir(), Who.UserId);
        logger_1.logger.info(`travel: ${Who.Username} took their character home (${b.characters.length} character(s))`);
        res.json(b);
    }
    catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});
