// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import fs from "fs";
import path from "path";
import { and, eq } from "drizzle-orm";
import { GetDb } from "../db";
import { loadouts } from "../db/schema";
import { logger } from "../logger";

const DEFAULT_INSTANCE_DATA = JSON.stringify({
    SheenType: 73,
    IsPrimarySheenActive: true,
    PrimaryDyeId: "None",
    IsSecondarySheenActive: true,
    SecondaryDyeId: "None",
    IsTertiarySheenActive: false,
    TertiaryDyeId: "None",
    TransmogCatalogId: "None",
    TransmogEnabled: false,
    EquippedCells: [],
    EquippedCellsv2: [],
    SubTypeMetadataArray: {
        ItemSubType: "subtype_eblade",
        EquippedItemParts: [{
            WeaponPartId: "PART_EB_SPECIAL_DEFAULT",
            SlotIndex: 0,
        }]
    }
});

const DEFAULT_PERSISTENT = {
    manual_emotes: ["", "", "", "", "", ""],
    intro_emote: "EM_INTRO_BEGINNER_01",
    banner: "BN_BEGINNER_00",
    bannerCustomization: "{\"BannerMeshItemID\":\"BNC_MESH_BEGINNER_00\",\"FabricMaterialItemID\":\"BNC_FABRIC_BEGINNER_00\",\"SigilTextureItemID\":\"BNC_SIGIL_BEGINNER_00\",\"PlantVFXItemID\":\"\",\"PersistantStandardVFXItemID\":\"\",\"AnimationItemID\":\"BNC_ANIMATION_BEGINNER_00\",\"BackgroundColourItemID\":\"DYE_BANNER_BACKGROUND_DEFAULT\",\"BorderColourItemID\":\"DYE_BANNER_SIGIL_DEFAULT\",\"SigilColourItemID\":\"DYE_BANNER_SIGIL_DEFAULT\",\"BackgroundSheenType\":0,\"BorderSheenType\":0,\"SigilSheenType\":0}",
    flare: "QI_BASIC_FLARE_DURABLE",
    title: "",
    head_accessory: "",
    back_accessory: "",
    pet: "",
    glider: "GD_FRAME_STARTER_BASE",
    update_version: 0,
    quick_chats: ["", "", "", "", "", "", "", "", ""],
    emojis: ["", "", "", "", "", "", "", "", ""],
    quick_curiosities_items: Array.from({length: 8}, (_, item_index) => ({
        item_index,
        item_id: "",
        instance_id: "",
    })),
    quickwheel: [],
};

export async function GetAllLoadoutsForUserIdAndCharacterId(UserId: string, CharacterId: string){
    let LoadoutDbRow = await GetDb().query.loadouts.findFirst({where: and(eq(loadouts.characterId, CharacterId), eq(loadouts.userId, UserId))});

    let Loadouts;

    if(LoadoutDbRow == undefined){
        logger.info(`Creating new loadout set for userId ${UserId} and characterId ${CharacterId}`);

        const NewLoadoutSlot = {
            weapon: {
                item_id: "WP_EB_TRAINING",
                instance_id: "WP_EB_TRAINING",
                instance_data: DEFAULT_INSTANCE_DATA
            },
            helmet: {
                item_id: "AR_UNEQUIPPED_HELM",
                instance_id: "AR_UNEQUIPPED_HELM",
                instance_data: DEFAULT_INSTANCE_DATA
            },
            chest: {
                item_id: "AR_BEGINNER_CHEST",
                instance_id: "AR_BEGINNER_CHEST",
                instance_data: DEFAULT_INSTANCE_DATA
            },
            arms: {
                item_id: "AR_BEGINNER_ARMS",
                instance_id: "AR_BEGINNER_ARMS",
                instance_data: DEFAULT_INSTANCE_DATA
            },
            legs: {
                item_id: "AR_BEGINNER_LEGS",
                instance_id: "AR_BEGINNER_LEGS",
                instance_data: DEFAULT_INSTANCE_DATA
            },
            lantern: {
                item_id: "LT_BASIC",
                instance_id: "LT_BASIC",
                instance_data: DEFAULT_INSTANCE_DATA
            },
            player_role: {
                item_id: "PR_DARKNESS",
                instance_id: "PR_DARKNESS",
                instance_data: DEFAULT_INSTANCE_DATA
            },
            subweapon: null,
            appearance: "{\"CreationState\":\"EArchonCharacterCreationState::NewCharacter\",\"Data\":[],\"AssetReferences\":[],\"StringData\":[]}",
            flask: "FL_HEALING_DEFAULT",
            quick_items: [],
            slot_index: 0, // TODO: Support multi-loadout
            update_version: 0,
            custom_name: "",
            persistent: DEFAULT_PERSISTENT
        };

        const NewLoadoutData = [NewLoadoutSlot];

        await GetDb().insert(loadouts).values({
            characterId: CharacterId,
            userId: UserId,
            loadouts: JSON.stringify(NewLoadoutData),
            persistent: JSON.stringify(DEFAULT_PERSISTENT)
        });

        Loadouts = NewLoadoutData;
    }
    else{
        Loadouts = JSON.parse(LoadoutDbRow.loadouts);
    }

    return Loadouts;
}

export async function GetPersistentLoadoutForUserIdAndCharacterId(UserId: string, CharacterId: string){
    // TODO: This will break if it's not called AFTER the GetAllLoadouts call as it has no create-on-nonexistent functionality

    const LoadoutDbRow = await GetDb().query.loadouts.findFirst({where: and(eq(loadouts.characterId, CharacterId), eq(loadouts.userId, UserId))});

    return JSON.parse(LoadoutDbRow!.persistent);
}

// ---------- multiple loadout slots (1.6.2 port) ----------
// Upstream only stored slot 0. Now every slot 0..MAX_LOADOUT_SLOTS-1 can be saved: a new slot is appended, gaps are
// filled with a copy of slot 0 (with its own slot_index). The active slot is kept in a small file per character
// (<LOADOUT_STATE_DIR>\<userId>_<characterId>.json), so the loadouts table needs no change.
export const MAX_LOADOUT_SLOTS = Math.max(1, Number(process.env.LOADOUT_SLOTS ?? 10));
const LOADOUT_STATE_DIR = process.env.LOADOUT_STATE_DIR ?? require("node:path").join(require("node:path").dirname(process.env.DB_FILENAME || "./undaunted.db"), "loadouts");

function ActivePath(UserId: string, CharacterId: string) {
    return path.join(LOADOUT_STATE_DIR, `${UserId}_${CharacterId}`.replace(/[^\w-]/g, "_") + ".json");
}

export function GetActiveLoadoutIndex(UserId: string, CharacterId: string): number {
    try {
        const j = JSON.parse(fs.readFileSync(ActivePath(UserId, CharacterId), "utf8").replace(/^\uFEFF/, ""));
        const i = Number(j.active_index);
        return Number.isInteger(i) && i >= 0 && i < MAX_LOADOUT_SLOTS ? i : 0;
    } catch {
        return 0;
    }
}

export function SetActiveLoadoutIndex(UserId: string, CharacterId: string, Index: string): boolean {
    const i = Number(Index);
    if (!Number.isInteger(i) || i < 0 || i >= MAX_LOADOUT_SLOTS) {
        logger.error(`Invalid active loadout index ${Index}`);
        return false;
    }
    fs.mkdirSync(LOADOUT_STATE_DIR, { recursive: true });
    const file = ActivePath(UserId, CharacterId);
    fs.writeFileSync(file + ".tmp", JSON.stringify({ active_index: i }));
    fs.renameSync(file + ".tmp", file);
    logger.info(`Active loadout for userId ${UserId} and characterId ${CharacterId} is now ${i}`);
    return true;
}

export async function SetLoadoutDataForUserIdAndCharacterId(UserId: string, CharacterId: string, Index: string, Data: string){
    logger.info(`Attempting to update loadout data Index ${Index}`);

    if(Index === "persistent"){
        await GetDb().update(loadouts).set({
            persistent: Data
        }).where(and(eq(loadouts.characterId, CharacterId), eq(loadouts.userId, UserId)));

        return true;
    }

    const SlotIndex = Number(Index);
    if (!Number.isInteger(SlotIndex) || SlotIndex < 0 || SlotIndex >= MAX_LOADOUT_SLOTS) {
        logger.error(`Unsupported Loadout Data Index ${Index} (slots 0-${MAX_LOADOUT_SLOTS - 1})`);
        return false;
    }

    let Slot: any;
    try {
        Slot = typeof Data === "string" ? JSON.parse(Data) : Data;
    } catch (e) {
        logger.error(e, `Loadout data for index ${Index} is not valid JSON`);
        return false;
    }
    if (!Slot || typeof Slot !== "object") {
        logger.error(`Loadout data for index ${Index} is empty`);
        return false;
    }

    // Make sure the row exists (creates the default loadout set if not), then edit the array in JS
    const Current: any[] = await GetAllLoadoutsForUserIdAndCharacterId(UserId, CharacterId);
    const Loadouts: any[] = Array.isArray(Current) ? [...Current] : [];
    while (Loadouts.length < SlotIndex) {
        const Filler = JSON.parse(JSON.stringify(Loadouts[0] ?? Slot));
        Filler.slot_index = Loadouts.length;
        Loadouts.push(Filler);
    }
    Slot.slot_index = SlotIndex;
    Loadouts[SlotIndex] = Slot;

    await GetDb().update(loadouts).set({
        loadouts: JSON.stringify(Loadouts)
    }).where(and(eq(loadouts.characterId, CharacterId), eq(loadouts.userId, UserId)));

    return true;
}
