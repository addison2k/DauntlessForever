// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import { Router } from "express";
import { logger } from "../logger";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";

export const guildRouter = Router();

guildRouter.get("/guild/invite/player", HasUndauntedMetagameAuth, (req: any, res) => {
    logger.info("Guild invites (stubbed)");

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            invites: []
        }
    });
});

guildRouter.get("/guild", HasUndauntedMetagameAuth, (req: any, res) => {
    logger.info("Current guild (stubbed)");

    res.status(204);
    res.send();
});