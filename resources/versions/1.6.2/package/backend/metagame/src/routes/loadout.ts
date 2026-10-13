import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { GetActiveLoadoutIndex, GetAllLoadoutsForUserIdAndCharacterId, GetPersistentLoadoutForUserIdAndCharacterId, MAX_LOADOUT_SLOTS, SetActiveLoadoutIndex, SetLoadoutDataForUserIdAndCharacterId } from "../controllers/loadout";
import { logger } from "../logger";

export const loadoutRouter = Router();

// The full loadout state the game expects (all saved slots, persistent data, slot counts, active slot)
async function LoadoutPayload(UserId: string, CharacterId: string) {
    const Loadouts: any[] = await GetAllLoadoutsForUserIdAndCharacterId(UserId, CharacterId);
    const Persistent: any = await GetPersistentLoadoutForUserIdAndCharacterId(UserId, CharacterId); // TODO: WARN: Ordering of this and the GetAllLoadoutsForUserIdAndCharacterId MUST NOT CHANGE until create-on-nonexistent is added in the loadout controller

    logger.info(`Fetched ${Loadouts.length} loadout(s) for userId ${UserId} and characterId ${CharacterId}`);

    return {
        loadouts: Loadouts,
        persistent: Persistent,
        num_account_slots: 1,
        max_account_slots: 1,
        num_character_slots: MAX_LOADOUT_SLOTS,
        max_character_slots: MAX_LOADOUT_SLOTS,
        active_index: GetActiveLoadoutIndex(UserId, CharacterId),
        needs_migration: false
    };
}

loadoutRouter.get("/loadout/:userId/:characterId/all", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;
    const CharacterId = req.params.characterId;

    res.status(200);
    res.json({ code: null, message: "OK", payload: await LoadoutPayload(RequestorAccountId, CharacterId) });
});

// Switch the active loadout slot
loadoutRouter.post("/loadout/:userId/:characterId/active/:index", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;
    const CharacterId = req.params.characterId;

    if (!SetActiveLoadoutIndex(RequestorAccountId, CharacterId, String(req.params.index))) {
        res.status(400);
        res.send();
        return;
    }

    res.status(200);
    res.json({ code: null, message: "OK", payload: await LoadoutPayload(RequestorAccountId, CharacterId) });
});

loadoutRouter.post("/loadout/:userId/:characterId/:index", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const Data = req.body.data;
    const Index = String(req.params.index);

    const Success = await SetLoadoutDataForUserIdAndCharacterId(RequestorAccountId, CharacterId, Index, Data);

    if(Success){
        logger.info(`Successfully updated loadout index ${Index} for userId ${RequestorAccountId} and characterId ${CharacterId}`);

        res.status(200);
        res.json({ code: null, message: "OK", payload: await LoadoutPayload(RequestorAccountId, CharacterId) });
    }
    else{
        logger.error(`Failed to update loadout index ${Index} for userId ${RequestorAccountId} and characterId ${CharacterId}`);

        res.status(400);
        res.send();
    }
});
