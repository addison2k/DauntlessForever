// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateInstancedItem = UpdateInstancedItem;
exports.RunInventoryTransaction = RunInventoryTransaction;
exports.GetInventoryForUserIdAndCharacterId = GetInventoryForUserIdAndCharacterId;
const drizzle_orm_1 = require("drizzle-orm");
const db_1 = require("../db");
const schema_1 = require("../db/schema");
const logger_1 = require("../logger");
const character_1 = require("./character");
class InventoryConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = "InventoryConflictError";
    }
}
class InventoryValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "InventoryValidationError";
    }
}
// ---------------------------------------------------------------------------
// [cell-exchange] Cell fusion (Middleman) support.
//
// The game server represents an in-progress fusion as a singleton instanced item
// TOKEN_CELL_EXCHANGE (catalogId == instanceId) whose itemData is
// {"SlotID":1,"EndTime":"<ISO>","ResultCell":"<id>","ExchangeID":"<hex>"}.
// It never bumps updateVersion (live backend owned that), so equal-version
// writes/removes must be accepted for this item. We also clamp EndTime so a
// fusion never runs longer than CELL_EXCHANGE_MAX_SECONDS (default 420 = 7 min).
// ---------------------------------------------------------------------------
const CELL_EXCHANGE_TOKEN_ID = "TOKEN_CELL_EXCHANGE";
const CellExchangeMaxSeconds = Number(process.env.CELL_EXCHANGE_MAX_SECONDS ?? 420);
function IsCellExchangeToken(Item) {
    return Item != null && Item.catalogId === CELL_EXCHANGE_TOKEN_ID;
}
function ClampCellExchangeItemData(CatalogId, ItemData) {
    if (CatalogId !== CELL_EXCHANGE_TOKEN_ID || ItemData == null || !(CellExchangeMaxSeconds > 0)) {
        return ItemData;
    }
    try {
        const Data = JSON.parse(ItemData);
        if (Data == null || typeof Data.EndTime !== "string") {
            return ItemData;
        }
        const EndMs = Date.parse(Data.EndTime);
        if (Number.isNaN(EndMs)) {
            return ItemData;
        }
        const MaxEndMs = Date.now() + CellExchangeMaxSeconds * 1000;
        if (EndMs <= MaxEndMs) {
            return ItemData;
        }
        const ClampedEndTime = new Date(MaxEndMs).toISOString();
        logger_1.logger.info(`[cell-exchange] Clamping slot ${Data.SlotID} EndTime ${Data.EndTime} -> ${ClampedEndTime} (max ${CellExchangeMaxSeconds}s)`);
        Data.EndTime = ClampedEndTime;
        return JSON.stringify(Data);
    }
    catch {
        // Not JSON we understand; leave it untouched.
        return ItemData;
    }
}
function ClampCellExchangeItem(Item) {
    if (IsCellExchangeToken(Item) && Object.prototype.hasOwnProperty.call(Item, "itemData")) {
        Item.itemData = ClampCellExchangeItemData(Item.catalogId, Item.itemData);
    }
    return Item;
}
// [cell-exchange] One saved fusion per slot.
// The game saves every slot's fusion with the same instanceId ("TOKEN_CELL_EXCHANGE"), so a second fusion
// overwrote the first and the first slot's cells were lost. The backend files each one under its own id,
// TOKEN_CELL_EXCHANGE_SLOT_<SlotID>, taking SlotID from itemData. Writes that arrive without itemData (a remove,
// usually when a finished fusion is claimed) are matched to the slot whose fusion is due first.
// Tested in game Oct 12 on the dev backend (all three slots fusing and claiming).
function CellExchangeSlotOf(ItemData) {
    if (ItemData == null)
        return null;
    try {
        const Data = typeof ItemData === "string" ? JSON.parse(ItemData) : ItemData;
        const Slot = Number(Data?.SlotID);
        return Number.isInteger(Slot) && Slot >= 0 ? Slot : null;
    }
    catch {
        return null;
    }
}
function CellExchangeEndMs(Item) {
    try {
        const Data = typeof Item?.itemData === "string" ? JSON.parse(Item.itemData) : Item?.itemData;
        const Ms = Date.parse(Data?.EndTime);
        return Number.isNaN(Ms) ? Number.MAX_SAFE_INTEGER : Ms;
    }
    catch {
        return Number.MAX_SAFE_INTEGER;
    }
}
function CellExchangeSlotInstanceId(Slot) {
    return `${CELL_EXCHANGE_TOKEN_ID}_SLOT_${Slot}`;
}
// Gives an incoming token its per-slot instanceId (when its itemData names a slot). Returns the same object.
function AssignCellExchangeSlotId(Item) {
    if (!IsCellExchangeToken(Item))
        return Item;
    const Slot = CellExchangeSlotOf(Item.itemData);
    if (Slot != null) {
        const Wanted = CellExchangeSlotInstanceId(Slot);
        if (Item.instanceId !== Wanted) {
            Item.instanceId = Wanted;
        }
    }
    return Item;
}
// Index of the stored item a write refers to. For TOKEN_CELL_EXCHANGE: the stored token of the same slot
// (including an old shared-id token of that slot), or for a slot-less remove the token due first.
function FindItemIndexForWrite(InstancedItems, Item, Operation) {
    const Direct = FindInstancedItemIndex(InstancedItems, Item.instanceId);
    if (!IsCellExchangeToken(Item))
        return Direct;
    const Slot = CellExchangeSlotOf(Item.itemData);
    const Tokens = InstancedItems.map((Stored, Index) => ({ Stored, Index })).filter(({ Stored }) => IsCellExchangeToken(Stored));
    if (Slot != null) {
        const SameSlot = Tokens.find(({ Stored }) => CellExchangeSlotOf(Stored.itemData) === Slot);
        const Index = SameSlot ? SameSlot.Index : -1;
        logger_1.logger.info(`[cell-exchange] ${Operation} slot ${Slot} -> ${Index >= 0 ? InstancedItems[Index].instanceId : "new"}`);
        return Index;
    }
    if (Direct >= 0 && InstancedItems[Direct].instanceId !== CELL_EXCHANGE_TOKEN_ID) {
        return Direct; // already a per-slot id (the game loaded it that way)
    }
    if (Operation === "remove") {
        if (Tokens.length === 0)
            return -1;
        const DueFirst = Tokens.sort((A, B) => CellExchangeEndMs(A.Stored) - CellExchangeEndMs(B.Stored))[0];
        logger_1.logger.info(`[cell-exchange] remove without slot -> ${DueFirst.Stored.instanceId} (due first of ${Tokens.length})`);
        return DueFirst.Index;
    }
    logger_1.logger.warn(`[cell-exchange] ${Operation} of ${Item.instanceId} has no SlotID; left as sent`);
    return Direct;
}
function MakeEmptyInventoryRow(CharacterId) {
    return {
        characterId: CharacterId,
        instancedItems: "[]",
        stackedItems: "[]",
    };
}
function FindInstancedItemIndex(InstancedItems, InstanceId) {
    return InstancedItems.findIndex((Item) => Item.instanceId === InstanceId);
}
function HasStatelessItemData(Item) {
    return !Object.prototype.hasOwnProperty.call(Item, "itemData") || Item.itemData == null;
}
function IsAllowedStaleStatelessReplacement(CurrentItem, IncomingItem, Operation) {
    return Operation !== "remove"
        && HasStatelessItemData(CurrentItem)
        && HasStatelessItemData(IncomingItem)
        && CurrentItem.updateVersion === 0;
}
function AssertValidIncomingInstancedItem(IncomingItem, Operation) {
    if (HasStatelessItemData(IncomingItem) && IncomingItem.updateVersion !== 0) {
        throw new InventoryValidationError(`Refusing stateless instanced item ${Operation} ${IncomingItem.catalogId}/${IncomingItem.instanceId}: expected updateVersion 0, got ${IncomingItem.updateVersion}`);
    }
}
function AssertExistingInstancedItemWrite(CurrentItem, IncomingItem, Operation) {
    if (Operation !== "remove") {
        AssertValidIncomingInstancedItem(IncomingItem, Operation);
    }
    if (typeof CurrentItem.updateVersion !== "number") {
        return "write";
    }
    if (IsAllowedStaleStatelessReplacement(CurrentItem, IncomingItem, Operation)) {
        return "skip";
    }
    // [cell-exchange] The game server re-saves (and removes) TOKEN_CELL_EXCHANGE with the
    // same updateVersion every time. Accept equal (or missing) versions for it; last write wins.
    if (IsCellExchangeToken(IncomingItem)
        && (IncomingItem.updateVersion == null || IncomingItem.updateVersion === CurrentItem.updateVersion)) {
        return "write";
    }
    const IsStaleInstancedItem = typeof IncomingItem.updateVersion !== "number" || IncomingItem.updateVersion <= CurrentItem.updateVersion;
    if (IsStaleInstancedItem) {
        throw new InventoryConflictError(`Refusing stale instanced item ${Operation} ${IncomingItem.catalogId}/${IncomingItem.instanceId}: current updateVersion ${CurrentItem.updateVersion}, incoming updateVersion ${IncomingItem.updateVersion}`);
    }
    return "write";
}
async function UpdateInstancedItem(CharacterId, UserId, InstanceId, CatalogId, ItemData, UpdateVersion) {
    if (!await (0, character_1.DoesCharacterBelongToUserId)(UserId, CharacterId)) {
        logger_1.logger.error(`Specified characterId ${CharacterId} does not belong to user ${UserId}`);
        return { success: false, error: "forbidden" };
    }
    // [cell-exchange] Cap fusion duration before it is persisted.
    ItemData = ClampCellExchangeItemData(CatalogId, ItemData);
    try {
        return (0, db_1.GetDb)().transaction((tx) => {
            let CurrentInventory = tx.query.inventory.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.inventory.characterId, CharacterId) }).sync();
            if (CurrentInventory == undefined) {
                logger_1.logger.info(`Creating inventory for characterId ${CharacterId} and userId ${UserId}`);
                CurrentInventory = MakeEmptyInventoryRow(CharacterId);
                tx.insert(schema_1.inventory).values(CurrentInventory).run();
            }
            const InstancedItems = JSON.parse(CurrentInventory.instancedItems);
            const ItemIndex = CatalogId === CELL_EXCHANGE_TOKEN_ID
                ? FindItemIndexForWrite(InstancedItems, { catalogId: CatalogId, instanceId: InstanceId, itemData: ItemData }, "update")
                : InstancedItems.findIndex((Item) => Item.catalogId === CatalogId && Item.instanceId === InstanceId);
            if (ItemIndex < 0) {
                return { success: false, error: "not_found" };
            }
            const Item = InstancedItems[ItemIndex];
            const IncomingItem = { catalogId: CatalogId, instanceId: InstanceId, itemData: ItemData, updateVersion: UpdateVersion };
            if (AssertExistingInstancedItemWrite(Item, IncomingItem, "update") === "skip") {
                logger_1.logger.info(`Skipping stale stateless Instanced Item ${CatalogId} for CharacterId ${CharacterId} and UserId ${UserId}`);
                return { success: true, data: Item };
            }
            Item.itemData = ItemData;
            Item.updateVersion = UpdateVersion;
            logger_1.logger.info(`Updating Instanced Item ${CatalogId} for CharacterId ${CharacterId} and UserId ${UserId}`);
            tx.update(schema_1.inventory).set({
                instancedItems: JSON.stringify(InstancedItems)
            }).where((0, drizzle_orm_1.eq)(schema_1.inventory.characterId, CharacterId)).run();
            return { success: true, data: Item };
        });
    }
    catch (error) {
        if (error instanceof InventoryConflictError) {
            logger_1.logger.warn(error.message);
            return { success: false, error: "conflict" };
        }
        if (error instanceof InventoryValidationError) {
            logger_1.logger.warn(error.message);
            return { success: false, error: "invalid_inventory_item" };
        }
        if (error instanceof SyntaxError) {
            logger_1.logger.error(error, `Invalid inventory data while updating instanced item ${CatalogId} for characterId ${CharacterId} and userId ${UserId}`);
            return { success: false, error: "invalid_inventory_data" };
        }
        logger_1.logger.error(error, `Failed to update instanced item ${CatalogId} for characterId ${CharacterId} and userId ${UserId}`);
        return { success: false, error: "db_error" };
    }
}
async function RunInventoryTransaction(UserId, CharacterId, TransactionId, InstancedItemsToAdd, StackedItemsToAdd, InstancedItemsToRemove, StackedItemsToRemove, InstancedItemsToSave) {
    InstancedItemsToAdd ??= [];
    StackedItemsToAdd ??= [];
    InstancedItemsToRemove ??= [];
    StackedItemsToRemove ??= [];
    InstancedItemsToSave ??= [];
    // [cell-exchange] Cap fusion duration on anything about to be persisted.
    InstancedItemsToAdd.forEach(ClampCellExchangeItem);
    InstancedItemsToSave.forEach(ClampCellExchangeItem);
    let TouchedStackedItems = []; // TODO: Clean this up if this ends up working
    if (!await (0, character_1.DoesCharacterBelongToUserId)(UserId, CharacterId)) {
        logger_1.logger.error(`Specified characterId ${CharacterId} does not belong to user ${UserId}`);
        return { success: false, error: "forbidden" };
    }
    const ShouldTouchInstancedItems = InstancedItemsToAdd.length > 0 || InstancedItemsToRemove.length > 0 || InstancedItemsToSave.length > 0;
    const ShouldTouchStackedItems = StackedItemsToAdd.length > 0 || StackedItemsToRemove.length > 0;
    if (!ShouldTouchInstancedItems && !ShouldTouchStackedItems) {
        return { success: true };
    }
    try {
        (0, db_1.GetDb)().transaction((tx) => {
            let CurrentInventory = tx.query.inventory.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.inventory.characterId, CharacterId) }).sync();
            if (CurrentInventory == undefined) {
                logger_1.logger.info(`Creating inventory for characterId ${CharacterId}`);
                CurrentInventory = MakeEmptyInventoryRow(CharacterId);
                tx.insert(schema_1.inventory).values(CurrentInventory).run();
            }
            const Update = {};
            if (ShouldTouchInstancedItems) {
                const InstancedItems = JSON.parse(CurrentInventory.instancedItems);
                let DidUpdateInstancedItems = false;
                for (const ItemToRemove of InstancedItemsToRemove) {
                    const ItemIndex = FindItemIndexForWrite(InstancedItems, ItemToRemove, "remove");
                    if (ItemIndex >= 0) {
                        AssertExistingInstancedItemWrite(InstancedItems[ItemIndex], ItemToRemove, "remove");
                        InstancedItems.splice(ItemIndex, 1);
                        DidUpdateInstancedItems = true;
                    }
                }
                for (const ItemToSave of InstancedItemsToSave) {
                    const ItemIndex = FindItemIndexForWrite(InstancedItems, ItemToSave, "save");
                    AssignCellExchangeSlotId(ItemToSave);
                    if (ItemIndex >= 0) {
                        if (AssertExistingInstancedItemWrite(InstancedItems[ItemIndex], ItemToSave, "save") === "skip") {
                            continue;
                        }
                        InstancedItems[ItemIndex] = ItemToSave;
                        DidUpdateInstancedItems = true;
                    }
                    else {
                        AssertValidIncomingInstancedItem(ItemToSave, "save");
                        InstancedItems.push(ItemToSave);
                        DidUpdateInstancedItems = true;
                    }
                }
                for (const ItemToAdd of InstancedItemsToAdd) {
                    const ItemIndex = FindItemIndexForWrite(InstancedItems, ItemToAdd, "add");
                    AssignCellExchangeSlotId(ItemToAdd);
                    if (ItemIndex >= 0) {
                        if (AssertExistingInstancedItemWrite(InstancedItems[ItemIndex], ItemToAdd, "add") === "skip") {
                            continue;
                        }
                        InstancedItems[ItemIndex] = ItemToAdd;
                        DidUpdateInstancedItems = true;
                    }
                    else {
                        AssertValidIncomingInstancedItem(ItemToAdd, "add");
                        InstancedItems.push(ItemToAdd);
                        DidUpdateInstancedItems = true;
                    }
                }
                if (DidUpdateInstancedItems) {
                    Update.instancedItems = JSON.stringify(InstancedItems);
                }
            }
            if (ShouldTouchStackedItems) {
                const StackedItems = JSON.parse(CurrentInventory.stackedItems);
                for (const ItemToRemove of StackedItemsToRemove) {
                    const ItemIndex = StackedItems.findIndex((Item) => Item.catalogId === ItemToRemove.catalogId);
                    if (ItemIndex < 0) {
                        continue;
                    }
                    StackedItems[ItemIndex].quantity -= ItemToRemove.quantity;
                    if (StackedItems[ItemIndex].quantity <= 0) {
                        // Report the item as 0 so the game drops it from the screen
                        TouchedStackedItems.push({ ...StackedItems[ItemIndex], quantity: 0 });
                        StackedItems.splice(ItemIndex, 1);
                    }
                    else {
                        // Report the new count so the game updates the screen
                        TouchedStackedItems.push(StackedItems[ItemIndex]);
                    }
                }
                for (const ItemToAdd of StackedItemsToAdd) {
                    const ItemIndex = StackedItems.findIndex((Item) => Item.catalogId === ItemToAdd.catalogId);
                    if (ItemIndex >= 0) {
                        StackedItems[ItemIndex].quantity += ItemToAdd.quantity;
                        TouchedStackedItems.push(StackedItems[ItemIndex]);
                    }
                    else {
                        TouchedStackedItems.push(ItemToAdd);
                        StackedItems.push(ItemToAdd);
                    }
                }
                Update.stackedItems = JSON.stringify(StackedItems);
            }
            if (Object.keys(Update).length > 0) {
                tx.update(schema_1.inventory).set(Update).where((0, drizzle_orm_1.eq)(schema_1.inventory.characterId, CharacterId)).run();
            }
        });
    }
    catch (error) {
        if (error instanceof InventoryConflictError) {
            logger_1.logger.warn(error.message);
            return { success: false, error: "conflict" };
        }
        if (error instanceof InventoryValidationError) {
            logger_1.logger.warn(error.message);
            return { success: false, error: "invalid_inventory_item" };
        }
        if (error instanceof SyntaxError) {
            logger_1.logger.error(error, `Invalid inventory data while running transaction ${TransactionId} for characterId ${CharacterId} and userId ${UserId}`);
            return { success: false, error: "invalid_inventory_data" };
        }
        logger_1.logger.error(error, `Failed to run inventory transaction ${TransactionId} for characterId ${CharacterId} and userId ${UserId}`);
        return { success: false, error: "db_error" };
    }
    return { success: true, data: TouchedStackedItems };
}
async function GetInventoryForUserIdAndCharacterId(UserId, CharacterId) {
    if (!await (0, character_1.DoesCharacterBelongToUserId)(UserId, CharacterId)) { // TODO: HACK: Get rid of this ugly thing, this is a workaround as we don't have a userId on our inventories table
        return { success: false, error: "forbidden" };
    }
    try {
        let InventoryFromDb = await (0, db_1.GetDb)().query.inventory.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.inventory.characterId, CharacterId) });
        if (InventoryFromDb == undefined) {
            logger_1.logger.info(`Creating inventory for characterId ${CharacterId} and userId ${UserId}`);
            InventoryFromDb = MakeEmptyInventoryRow(CharacterId);
            await (0, db_1.GetDb)().insert(schema_1.inventory).values(InventoryFromDb);
        }
        return {
            success: true,
            data: {
                characterId: CharacterId,
                instancedItems: JSON.parse(InventoryFromDb.instancedItems),
                stackedItems: JSON.parse(InventoryFromDb.stackedItems)
            }
        };
    }
    catch (error) {
        if (error instanceof SyntaxError) {
            logger_1.logger.error(error, `Invalid inventory data while fetching inventory for characterId ${CharacterId} and userId ${UserId}`);
            return { success: false, error: "invalid_inventory_data" };
        }
        logger_1.logger.error(error, `Failed to fetch inventory for characterId ${CharacterId} and userId ${UserId}`);
        return { success: false, error: "db_error" };
    }
}
