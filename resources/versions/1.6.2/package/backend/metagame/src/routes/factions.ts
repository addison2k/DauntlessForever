// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
// [1.6.2 port] Player Journey factions, version 2.
// What the 1.6.2 game actually does (seen in the metagame log):
//   GET  /factions/<season>                         (client)   e.g. /factions/event_season13_complete
//   GET  /factions/<uid>/<season>                   (server)
//   POST /factions/<uid>/<season>/<faction>         body {"nodes": {...}}  e.g. .../faction_season13_past
// Each faction has its own node tree (Past_*, Future_*). Version 1 kept ONE blob per player, so saving
// Faction: Future overwrote Faction: Past, and GET only ever returned the last faction saved.
// Version 2 keeps every faction's tree separately and answers GET with all of a season's nodes merged
// (node ids are unique per faction), in the same {nodes, update_version} shape the Player Journey uses.

import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { logger } from "../logger";

export const factionsRouter = Router();

const FACTIONS_DIR = path.join(path.dirname(process.env.DB_FILENAME || "./undaunted.db"), "factions");

type Tree = { nodes: Record<string, any>; update_version: number };
type FactionState = { factions: Record<string, Tree> };   // key: "<season>/<faction>"

function FileFor(UserId: string) {
    return path.join(FACTIONS_DIR, UserId.replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
}

function Load(UserId: string): FactionState {
    try {
        const raw = JSON.parse(fs.readFileSync(FileFor(UserId), "utf8").replace(/^\uFEFF/, ""));
        if (raw && raw.factions && typeof raw.factions === "object") return raw as FactionState;
        // Version 1 file (a single posted body): keep it as a legacy tree so nothing is lost
        if (raw && raw.nodes && typeof raw.nodes === "object") {
            return { factions: { "legacy/legacy": { nodes: raw.nodes, update_version: 1 } } };
        }
    } catch { /* no file yet */ }
    return { factions: {} };
}

function Save(UserId: string, State: FactionState) {
    fs.mkdirSync(FACTIONS_DIR, { recursive: true });
    const file = FileFor(UserId);
    fs.writeFileSync(file + ".tmp", JSON.stringify(State, null, 2));
    fs.renameSync(file + ".tmp", file);
}

function MergedForSeason(State: FactionState, Season: string | undefined): Tree {
    const nodes: Record<string, any> = {};
    let version = 0;
    for (const [key, tree] of Object.entries(State.factions)) {
        const [s] = key.split("/");
        if (Season && s !== Season && s !== "legacy") continue;
        for (const [id, node] of Object.entries(tree.nodes ?? {})) {
            // Newer trees win for the same id (legacy first, real saves after)
            if (!(id in nodes) || s !== "legacy") nodes[id] = node;
        }
        version = Math.max(version, tree.update_version ?? 0);
    }
    return { nodes, update_version: version };
}

function Reply(res: any, Data: Tree) {
    res.status(200);
    res.json({ code: "200", message: "OK", payload: Data });
}

factionsRouter.use("/factions", HasUndauntedMetagameAuth, (req: any, res) => {
    const Parts: string[] = req.path.split("/").filter((p: string) => p.length > 0).map((p: string) => decodeURIComponent(p));
    let UserId: string | undefined;
    let Rest: string[];
    if (Parts[0] && Parts[0].startsWith("UID-")) {
        UserId = Parts[0];
        Rest = Parts.slice(1);
        // A client may only touch its own data
        if (!req.AuthData?.IsGameserver && req.AuthData?.userId !== UserId) {
            res.status(403); res.send(); return;
        }
    } else {
        UserId = req.AuthData?.userId;
        Rest = Parts;
    }
    if (typeof UserId !== "string") { res.status(400); res.send(); return; }

    const Season = Rest[0];
    const Faction = Rest[1];
    const State = Load(UserId);

    if (req.method === "POST" || req.method === "PUT") {
        const Nodes = req.body && typeof req.body.nodes === "object" && req.body.nodes !== null ? req.body.nodes : null;
        if (!Season || !Faction || Nodes === null) {
            logger.warn(`Factions: ignored save ${req.originalUrl} (missing season/faction/nodes)`);
            res.status(400); res.send(); return;
        }
        const key = `${Season}/${Faction}`;
        const old = State.factions[key];
        const tree: Tree = { nodes: Nodes, update_version: (old?.update_version ?? 0) + 1 };
        State.factions[key] = tree;
        Save(UserId, State);
        const unlocked = Object.values(Nodes).filter((n: any) => n?.node_status === 2).map((n: any) => n.node_id);
        logger.info(`Factions saved for ${UserId}: ${key} v${tree.update_version}, unlocked [${unlocked.join(", ")}]`);
        Reply(res, tree);
        return;
    }

    const merged = MergedForSeason(State, Season);
    const unlocked = Object.values(merged.nodes).filter((n: any) => n?.node_status === 2).map((n: any) => n.node_id);
    logger.info(`Factions read for ${UserId} (${req.method} ${req.originalUrl}): ${Object.keys(merged.nodes).length} node(s), unlocked [${unlocked.join(", ")}]`);
    Reply(res, merged);
});
