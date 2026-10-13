// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tuningRouter = void 0;
const express_1 = require("express");
const logger_1 = require("../logger");
exports.tuningRouter = (0, express_1.Router)();
exports.tuningRouter.get("/game_tuning/seasonal_event_schedule", (req, res) => {
    logger_1.logger.info("Seasonal Event Schedule (stubbed)");
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            ScheduledItems: []
        }
    });
});
exports.tuningRouter.get("/game_tuning/huntpass_xp_config", (req, res) => {
    logger_1.logger.info("Huntpass XP Config (stubbed)");
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            EventConfigs: [],
            GlobalConfig: {
                DifficultyBias: 1.000000000000000,
                GlobalMultiplier: 1.000000000000000,
                MaxXPAwarded: 200
            }
        }
    });
});
