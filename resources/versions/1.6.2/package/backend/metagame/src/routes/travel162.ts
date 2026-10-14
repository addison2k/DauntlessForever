// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
//
// Your character travels with you (travel162.ts): a friend's launcher, joining this backend through the relay
// or the LAN, sends its own character here before the game starts and takes it home when the game closes.
// Both calls use the account key the joiner was given (X-Undaunted-User-Api-Key), so a joiner can only ever
// read or replace their own account here, never the host's or anyone else's.
import { Router } from "express";
import path from "node:path";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database: any = require("better-sqlite3");
import { logger } from "../logger";
import { HasUndauntedUserApiKey } from "../middleware/HasUndauntedUserApiKey";
import { ExportAccount, ImportAccount } from "../travel162";

const travelRouter = Router();
let raw: any = null;
const Db = () => raw || (raw = new Database(process.env.DB_FILENAME || "./undaunted.db"));
const DataDir = () => path.dirname(process.env.DB_FILENAME || "./undaunted.db");

travelRouter.post("/undaunted/api/travel/import", HasUndauntedUserApiKey, (req: any, res) => {
    const Who = req.UndauntedUserInfo;
    try {
        const r = ImportAccount(Db(), DataDir(), Who.UserId, req.body && req.body.bundle, "joined");
        logger.info(`travel: ${Who.Username} brought their character here (${r.characters} character(s), ${r.files} file(s))`);
        res.json({ ok: true, ...r });
    } catch (e) {
        logger.warn(`travel: ${Who.Username} could not bring their character: ${(e as Error).message}`);
        res.status(400).json({ ok: false, error: (e as Error).message });
    }
});

travelRouter.get("/undaunted/api/travel/export", HasUndauntedUserApiKey, (req: any, res) => {
    const Who = req.UndauntedUserInfo;
    try {
        const b = ExportAccount(Db(), DataDir(), Who.UserId);
        logger.info(`travel: ${Who.Username} took their character home (${b.characters.length} character(s))`);
        res.json(b);
    } catch (e) {
        res.status(400).json({ ok: false, error: (e as Error).message });
    }
});

export { travelRouter };
