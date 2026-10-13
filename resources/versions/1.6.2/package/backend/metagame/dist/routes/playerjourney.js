// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
// [1.6.2 port] Player Journey (/pjm) routes.
// The Player Journey system was added to Dauntless after 1.4.4, so upstream Undaunted has no route for it,
// and 1.6.2 stops at the title screen with "Error reading your character's Player Journey data".
// Shapes follow the Dauntless Revived backend-contract notes: nodes is an object keyed by node id,
// and GET is (by static reading of the client) wrapped in the usual {code, message, payload} envelope.
// Set PJM_WRAPPED=0 in .env to answer unwrapped instead, if 1.6.2 turns out to expect that.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.playerJourneyRouter = void 0;
const express_1 = require("express");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const HasUndauntedMetagameAuth_1 = require("../middleware/HasUndauntedMetagameAuth");
const logger_1 = require("../logger");
exports.playerJourneyRouter = (0, express_1.Router)();
const WRAPPED = process.env.PJM_WRAPPED !== "0";
const PJM_DIR = node_path_1.default.join(node_path_1.default.dirname(process.env.DB_FILENAME || "./undaunted.db"), "pjm");
function FileFor(UserId) {
    return node_path_1.default.join(PJM_DIR, UserId.replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
}
function LoadJourney(UserId) {
    try {
        const Parsed = JSON.parse(node_fs_1.default.readFileSync(FileFor(UserId), "utf8"));
        if (Parsed && typeof Parsed.nodes === "object" && Parsed.nodes !== null && !Array.isArray(Parsed.nodes)) {
            return { nodes: Parsed.nodes, update_version: Number(Parsed.update_version) || 0 };
        }
    }
    catch {
        // No saved journey yet: start empty.
    }
    return { nodes: {}, update_version: 0 };
}
function SaveJourney(UserId, Data) {
    node_fs_1.default.mkdirSync(PJM_DIR, { recursive: true });
    node_fs_1.default.writeFileSync(FileFor(UserId), JSON.stringify(Data));
}
function Reply(res, Data) {
    res.status(200);
    if (WRAPPED) {
        res.json({ code: "200", message: "OK", payload: Data });
    }
    else {
        res.json(Data);
    }
}
function RequestorFor(req) {
    return req.AuthData.IsGameserver ? req.params.accountid : req.AuthData.userId;
}
exports.playerJourneyRouter.get("/pjm", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const UserId = req.AuthData.userId;
    if (typeof UserId !== "string") {
        res.status(400);
        res.send();
        return;
    }
    const Data = LoadJourney(UserId);
    logger_1.logger.info(`Player Journey read for ${UserId}: ${Object.keys(Data.nodes).length} node(s)`);
    Reply(res, Data);
});
exports.playerJourneyRouter.get("/pjm/:accountid", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const UserId = RequestorFor(req);
    if (typeof UserId !== "string") {
        res.status(400);
        res.send();
        return;
    }
    const Data = LoadJourney(UserId);
    logger_1.logger.info(`Player Journey read for ${UserId}: ${Object.keys(Data.nodes).length} node(s)`);
    Reply(res, Data);
});
exports.playerJourneyRouter.post("/pjm/:accountid", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const UserId = RequestorFor(req);
    if (typeof UserId !== "string") {
        res.status(400);
        res.send();
        return;
    }
    const Body = req.body;
    const Nodes = Body && typeof Body.nodes === "object" && Body.nodes !== null && !Array.isArray(Body.nodes) ? Body.nodes : null;
    if (Nodes === null) {
        logger_1.logger.warn(`Player Journey save for ${UserId} had no nodes object; ignored`);
        res.status(400);
        res.send();
        return;
    }
    const Old = LoadJourney(UserId);
    const Data = { nodes: Nodes, update_version: Old.update_version + 1 };
    SaveJourney(UserId, Data);
    logger_1.logger.info(`Player Journey saved for ${UserId}: ${Object.keys(Nodes).length} node(s), version ${Data.update_version}`);
    Reply(res, Data);
});
