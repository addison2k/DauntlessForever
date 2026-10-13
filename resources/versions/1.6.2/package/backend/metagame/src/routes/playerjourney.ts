// [1.6.2 port] Player Journey (/pjm) routes.
// The Player Journey system was added to Dauntless after 1.4.4, so upstream Undaunted has no route for it,
// and 1.6.2 stops at the title screen with "Error reading your character's Player Journey data".
// Shapes follow the Dauntless Revived backend-contract notes: nodes is an object keyed by node id,
// and GET is (by static reading of the client) wrapped in the usual {code, message, payload} envelope.
// Set PJM_WRAPPED=0 in .env to answer unwrapped instead, if 1.6.2 turns out to expect that.

import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { logger } from "../logger";

export const playerJourneyRouter = Router();

const WRAPPED = process.env.PJM_WRAPPED !== "0";
const PJM_DIR = path.join(path.dirname(process.env.DB_FILENAME || "./undaunted.db"), "pjm");

type JourneyData = { nodes: Record<string, unknown>, update_version: number };

function FileFor(UserId: string){
    return path.join(PJM_DIR, UserId.replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
}

function LoadJourney(UserId: string): JourneyData {
    try{
        const Parsed = JSON.parse(fs.readFileSync(FileFor(UserId), "utf8"));
        if(Parsed && typeof Parsed.nodes === "object" && Parsed.nodes !== null && !Array.isArray(Parsed.nodes)){
            return { nodes: Parsed.nodes, update_version: Number(Parsed.update_version) || 0 };
        }
    }
    catch{
        // No saved journey yet: start empty.
    }
    return { nodes: {}, update_version: 0 };
}

function SaveJourney(UserId: string, Data: JourneyData){
    fs.mkdirSync(PJM_DIR, { recursive: true });
    fs.writeFileSync(FileFor(UserId), JSON.stringify(Data));
}

function Reply(res: any, Data: JourneyData){
    res.status(200);
    if(WRAPPED){
        res.json({ code: "200", message: "OK", payload: Data });
    }
    else{
        res.json(Data);
    }
}

function RequestorFor(req: any){
    return req.AuthData.IsGameserver ? req.params.accountid : req.AuthData.userId;
}

playerJourneyRouter.get("/pjm", HasUndauntedMetagameAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;
    if(typeof UserId !== "string"){
        res.status(400); res.send(); return;
    }
    const Data = LoadJourney(UserId);
    logger.info(`Player Journey read for ${UserId}: ${Object.keys(Data.nodes).length} node(s)`);
    Reply(res, Data);
});

playerJourneyRouter.get("/pjm/:accountid", HasUndauntedMetagameAuth, async (req: any, res) => {
    const UserId = RequestorFor(req);
    if(typeof UserId !== "string"){
        res.status(400); res.send(); return;
    }
    const Data = LoadJourney(UserId);
    logger.info(`Player Journey read for ${UserId}: ${Object.keys(Data.nodes).length} node(s)`);
    Reply(res, Data);
});

playerJourneyRouter.post("/pjm/:accountid", HasUndauntedMetagameAuth, async (req: any, res) => {
    const UserId = RequestorFor(req);
    if(typeof UserId !== "string"){
        res.status(400); res.send(); return;
    }
    const Body = req.body;
    const Nodes = Body && typeof Body.nodes === "object" && Body.nodes !== null && !Array.isArray(Body.nodes) ? Body.nodes : null;
    if(Nodes === null){
        logger.warn(`Player Journey save for ${UserId} had no nodes object; ignored`);
        res.status(400); res.send(); return;
    }
    const Old = LoadJourney(UserId);
    const Data: JourneyData = { nodes: Nodes, update_version: Old.update_version + 1 };
    SaveJourney(UserId, Data);
    logger.info(`Player Journey saved for ${UserId}: ${Object.keys(Nodes).length} node(s), version ${Data.update_version}`);
    Reply(res, Data);
});
