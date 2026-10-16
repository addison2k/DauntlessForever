// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tuningRouter = void 0;
exports.SeasonalEventSchedule = SeasonalEventSchedule;
const express_1 = require("express");
const logger_1 = require("../logger");
exports.tuningRouter = (0, express_1.Router)();
// Seasonal event schedule (FServiceSchedule in the exe: { ScheduledItems: FScheduleData[] }, each with Name, StartTime,
// EndTime, IsRepeatable, RepeatableDetails { EachDay, EachWeek }, bShouldQueueTheSheduleItems,
// ScheduledItems [{ ID, MaxCompletionPerInterval }]). UPlayerEscalationComponent reads the current Heroic Escalation
// (start/end time, which hunt) from it, so an empty schedule means no Heroic Escalation.
// HEROIC_ESCALATION=0 sends the old empty schedule. HEROIC_ROTATION (comma list of hunt ids) overrides the rotation.
// One Heroic Escalation per week, Monday 00:00 UTC to Monday 00:00 UTC, rotating from the week of Oct 12, 2026.
// Idea from a player's patch (heroic07.js, Oct 14); written here against the exe's own struct names.
const HEROIC_ROTATION = (process.env.HEROIC_ROTATION ?? [
    "CR19_PlayerHunt_Escalation_Thunderbird_Heroic",
    "CR19_PlayerHunt_Escalation_Armstrong_Heroic",
    "CR19_PlayerHunt_Escalation_Randall_Heroic",
    "CR19_PlayerHunt_Escalation_Funguy_Heroic",
    "CR19_PlayerHunt_Escalation_Mint_Heroic",
].join(",")).split(",").map((Id) => Id.trim()).filter((Id) => Id.length > 0);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ROTATION_START = Date.UTC(2026, 9, 12); // Monday Oct 12, 2026
function HeroicEventSchedule(Now = new Date()) {
    if ((process.env.HEROIC_ESCALATION ?? "1") !== "1" || HEROIC_ROTATION.length === 0) {
        return { ScheduledItems: [] };
    }
    const Today = Date.UTC(Now.getUTCFullYear(), Now.getUTCMonth(), Now.getUTCDate());
    const Monday = Today - ((new Date(Today).getUTCDay() + 6) % 7) * 24 * 60 * 60 * 1000;
    const Week = Math.floor((Monday - ROTATION_START) / WEEK_MS);
    const HuntId = HEROIC_ROTATION[((Week % HEROIC_ROTATION.length) + HEROIC_ROTATION.length) % HEROIC_ROTATION.length];
    return {
        ScheduledItems: [{
                Name: "Heroic Escalation",
                StartTime: new Date(Monday).toISOString(),
                EndTime: new Date(Monday + WEEK_MS).toISOString(),
                IsRepeatable: false,
                RepeatableDetails: { EachDay: false, EachWeek: false },
                bShouldQueueTheSheduleItems: false,
                ScheduledItems: [{ ID: HuntId, MaxCompletionPerInterval: 1 }]
            }]
    };
}

// Trials: one Normal/Dauntless pair per week, changing Monday 00:00 UTC, the same one the menu shows and the hunt
// launches (tools/trials-schedule.cjs). Fix by KombatKing. If it can't be worked out, Heroic still goes out.
function SeasonalEventSchedule(Now = new Date()){
    const schedule = HeroicEventSchedule(Now);
    try { schedule.ScheduledItems.push(...require(require('node:path').resolve(__dirname,'../../../../tools/trials-schedule.cjs')).schedule(Now)); }
    catch (e) { console.error("Trials schedule: " + (e && e.message)); }
    return schedule;
}
exports.tuningRouter.get("/game_tuning/seasonal_event_schedule", (req, res) => {
    const Schedule = SeasonalEventSchedule();
    const Current = Schedule.ScheduledItems[0];
    logger_1.logger.info(Current ? `Seasonal Event Schedule: Heroic Escalation ${Current.ScheduledItems[0].ID} until ${Current.EndTime}` : "Seasonal Event Schedule: empty (HEROIC_ESCALATION=0)");
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: Schedule
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
