// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import { Router } from "express";
import { logger } from "../logger";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { GetNotesForUser } from "../controllers/store";

export const storeRouter = Router();

// Lady Luck / Trials shop (trials-shop162.js, by KombatKing): 56 offers paid with Steel/Gilded Marks, Champion stock
// unlocked. Its routes run first and pass anything that is not theirs on to the routes below, unchanged.
storeRouter.use(require("../trials-shop162").router);
// Ozz holiday shop (seasonal-ozz162.js, by KombatKing): holiday items for event coins, only during their holiday.
storeRouter.use(require("../seasonal-ozz162").router);

storeRouter.post("/reconcile", HasUndauntedMetagameAuth, async (req: any, res) => {
    const Notes = await GetNotesForUser(req.AuthData.userId);

    logger.info(`Retrieved notes balance of ${Notes} for ${req.AuthData.userId}`);

    res.status(200);
    res.json({
        balances: {
            id_currency_notes: Notes,
            CURRENCY_NOTES: Notes
        },
        refreshInventory: true
    });
});

storeRouter.get("/creator", HasUndauntedMetagameAuth, async (req: any, res) => {
    logger.info("SupportACreator (stubbed)");

    res.status(200);
    res.json({
        "expirationDate": "2099-01-01T01:00:00.041Z",
        "slug": "MROWMROW",
        "success": true
    });
})

storeRouter.get("/balance", HasUndauntedMetagameAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;

    const NotesBalance = await GetNotesForUser(UserId);

    logger.info(`Fetched notes balance of ${NotesBalance} for userId ${UserId}`);

    res.status(200);
    res.json({
        id_currency_s20_coin: 0,
        CURRENCY_GAUNTLET_COIN_FADED: 0,
        CURRENCY_S20_COIN: 0,
        CURRENCY_S18_COIN: 0,
        id_currency_seasonal_coin: 0,
        id_currency_s18_coin: 0,
        id_currency_weapon_token: 25,
        id_currency_celldust: 0,
        id_currency_event_ramsgiving: 0,
        CURRENCY_NOTES: NotesBalance,
        id_currency_event_frostfall: 0,
        CURRENCY_EVENT_DARKHARVEST: 0,
        CURRENCY_S19_COIN: 0,
        id_currency_s16_coin: 0,
        CURRENCY_S16_COIN: 0,
        id_currency_gauntlet_coin: 0,
        id_currency_s13_coin: 0,
        CURRENCY_MARKS_STEEL: 0,
        CURRENCY_S13_COIN: 0,
        CURRENCY_EVENT_FROSTFALL: 0,
        CURRENCY_GAUNTLET_COIN: 0,
        id_currency_marks_steel: 0,
        id_currency_rewardcache: 0,
        CURRENCY_PRESTIGE: 0,
        CURRENCY_SEASONAL_COIN: 0,
        CURRENCY_REWARDCACHE: 0,
        id_currency_token_exchange_speed_up: 0,
        id_currency_event_springtide: 0,
        CURRENCY_TOKEN_EXCHANGE_SPEED_UP: 0,
        id_currency_gauntlet_coin_faded: 0,
        CURRENCY_S15_COIN: 0,
        CURRENCY_PLATINUM: 0,
        id_currency_platinum: 0,
        id_currency_s15_coin: 0,
        id_currency_marks_gilded: 0,
        id_currency_event_darkharvest: 0,
        id_currency_event_saintsbond: 0,
        CURRENCY_EVENT_SPRINGTIDE: 0,
        id_currency_s19_coin: 0,
        id_currency_notes: NotesBalance,
        id_currency_prestige: 0,
        id_currency_s13_daily: 0,
        CURRENCY_WEAPON_TOKEN: 25,
        CURRENCY_MARKS_GILDED: 0,
        CURRENCY_S13_DAILY: 0,
        CURRENCY_CELLDUST: 0,
        CURRENCY_S14_COIN: 0,
        CURRENCY_EVENT_SAINTSBOND: 0,
        CURRENCY_S17_COIN: 0,
        id_currency_s14_coin: 0,
        CURRENCY_EVENT_RAMSGIVING: 0,
        id_currency_s17_coin: 0
    });
});

storeRouter.get("/product/skus/public", HasUndauntedMetagameAuth, async (req: any, res) => {
    const tags = String(req.query?.requiredTags ?? "");
    logger.info(`Store SKUs requested tags=${tags} (returning empty)`);
    // Empty catalog: no weekly cell offers, no purchasable slot unlocks yet.
    res.status(200).json([]);
});