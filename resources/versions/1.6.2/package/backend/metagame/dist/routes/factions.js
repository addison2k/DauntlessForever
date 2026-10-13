// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
// [1.6.2 port] Player Journey factions, version 2.
// What the 1.6.2 game actually does (seen in the metagame log):
//   GET  /factions/<season>                         (client)   e.g. /factions/event_season13_complete
//   GET  /factions/<uid>/<season>                   (server)
//   POST /factions/<uid>/<season>/<faction>         body {"nodes": {...}}  e.g. .../faction_season13_past
// Each faction has its own node tree (Past_*, Future_*). Version 1 kept ONE blob per player, so saving
// Faction: Future overwrote Faction: Past, and GET only ever returned the last faction saved.
// Version 2 keeps every faction's tree separately and answers GET with all of a season's nodes merged
// (node ids are unique per faction), in the same {nodes, update_version} shape the Player Journey uses.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.factionsRouter = void 0;
const express_1 = require("express");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const HasUndauntedMetagameAuth_1 = require("../middleware/HasUndauntedMetagameAuth");
const logger_1 = require("../logger");
exports.factionsRouter = (0, express_1.Router)();
const FACTIONS_DIR = node_path_1.default.join(node_path_1.default.dirname(process.env.DB_FILENAME || "./undaunted.db"), "factions");
function FileFor(UserId) {
    return node_path_1.default.join(FACTIONS_DIR, UserId.replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
}
function Load(UserId) {
    try {
        const raw = JSON.parse(node_fs_1.default.readFileSync(FileFor(UserId), "utf8").replace(/^\uFEFF/, ""));
        if (raw && raw.factions && typeof raw.factions === "object")
            return raw;
        // Version 1 file (a single posted body): keep it as a legacy tree so nothing is lost
        if (raw && raw.nodes && typeof raw.nodes === "object") {
            return { factions: { "legacy/legacy": { nodes: raw.nodes, update_version: 1 } } };
        }
    }
    catch { /* no file yet */ }
    return { factions: {} };
}
function Save(UserId, State) {
    node_fs_1.default.mkdirSync(FACTIONS_DIR, { recursive: true });
    const file = FileFor(UserId);
    node_fs_1.default.writeFileSync(file + ".tmp", JSON.stringify(State, null, 2));
    node_fs_1.default.renameSync(file + ".tmp", file);
}
function MergedForSeason(State, Season) {
    const nodes = {};
    let version = 0;
    for (const [key, tree] of Object.entries(State.factions)) {
        const [s] = key.split("/");
        if (Season && s !== Season && s !== "legacy")
            continue;
        for (const [id, node] of Object.entries(tree.nodes ?? {})) {
            // Newer trees win for the same id (legacy first, real saves after)
            if (!(id in nodes) || s !== "legacy")
                nodes[id] = node;
        }
        version = Math.max(version, tree.update_version ?? 0);
    }
    return { nodes, update_version: version };
}
function Reply(res, Data) {
    res.status(200);
    res.json({ code: "200", message: "OK", payload: Data });
}
exports.factionsRouter.use("/factions", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const Parts = req.path.split("/").filter((p) => p.length > 0).map((p) => decodeURIComponent(p));
    let UserId;
    let Rest;
    if (Parts[0] && Parts[0].startsWith("UID-")) {
        UserId = Parts[0];
        Rest = Parts.slice(1);
        // A client may only touch its own data
        if (!req.AuthData?.IsGameserver && req.AuthData?.userId !== UserId) {
            res.status(403);
            res.send();
            return;
        }
    }
    else {
        UserId = req.AuthData?.userId;
        Rest = Parts;
    }
    if (typeof UserId !== "string") {
        res.status(400);
        res.send();
        return;
    }
    const Season = Rest[0];
    const Faction = Rest[1];
    const State = Load(UserId);
    if (req.method === "POST" || req.method === "PUT") {
        const Nodes = req.body && typeof req.body.nodes === "object" && req.body.nodes !== null ? req.body.nodes : null;
        if (!Season || !Faction || Nodes === null) {
            logger_1.logger.warn(`Factions: ignored save ${req.originalUrl} (missing season/faction/nodes)`);
            res.status(400);
            res.send();
            return;
        }
        const key = `${Season}/${Faction}`;
        const old = State.factions[key];
        const tree = { nodes: Nodes, update_version: (old?.update_version ?? 0) + 1 };
        State.factions[key] = tree;
        Save(UserId, State);
        const unlocked = Object.values(Nodes).filter((n) => n?.node_status === 2).map((n) => n.node_id);
        logger_1.logger.info(`Factions saved for ${UserId}: ${key} v${tree.update_version}, unlocked [${unlocked.join(", ")}]`);
        Reply(res, tree);
        return;
    }
    const merged = MergedForSeason(State, Season);
    const unlocked = Object.values(merged.nodes).filter((n) => n?.node_status === 2).map((n) => n.node_id);
    logger_1.logger.info(`Factions read for ${UserId} (${req.method} ${req.originalUrl}): ${Object.keys(merged.nodes).length} node(s), unlocked [${unlocked.join(", ")}]`);
    Reply(res, merged);
});
