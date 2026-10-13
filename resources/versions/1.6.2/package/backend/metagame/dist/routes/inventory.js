// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inventoryRouter = void 0;
const express_1 = require("express");
const HasUndauntedMetagameAuth_1 = require("../middleware/HasUndauntedMetagameAuth");
const logger_1 = require("../logger");
const inventory_1 = require("../controllers/inventory");
exports.inventoryRouter = (0, express_1.Router)();
function StatusForInventoryError(Error) {
    switch (Error) {
        case "forbidden":
            return 403;
        case "not_found":
            return 404;
        case "conflict":
            return 409;
        case "invalid_inventory_item":
            return 400;
        case "invalid_inventory_data":
        case "db_error":
            return 500;
    }
}
exports.inventoryRouter.post("/inventory/:characterId/:changeList", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    logger_1.logger.info("Inventory migration (stubbed)");
    res.status(200);
    res.json({
        code: null,
        message: ""
    });
});
exports.inventoryRouter.get("/inventory/:userId/:characterId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const UserId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;
    req.AuthData.userId;
    const CharacterId = req.params.characterId;
    logger_1.logger.info(`UserId ${UserId} requested inventory for CharacterId ${CharacterId}`);
    const InventoryResult = await (0, inventory_1.GetInventoryForUserIdAndCharacterId)(UserId, CharacterId);
    if (InventoryResult.success) {
        res.status(200);
        res.json(InventoryResult.data);
    }
    else {
        res.status(StatusForInventoryError(InventoryResult.error));
        res.send();
    }
});
exports.inventoryRouter.post("/inventory", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const UserId = req.AuthData.IsGameserver ? req.body.accountId : req.AuthData.userId;
    const CharacterId = req.body.characterId;
    const TransactionId = req.body.transactionId;
    const InstancedItemsToAdd = req.body.addInstancedItems;
    const StackedItemsToAdd = req.body.addStackedItems;
    const InstancedItemsToRemove = req.body.removeInstancedItems;
    const StackedItemsToRemove = req.body.removeStackedItems;
    const InstancedItemsToSave = req.body.saveInstancedItems;
    const TransactionResult = await (0, inventory_1.RunInventoryTransaction)(UserId, CharacterId, TransactionId, InstancedItemsToAdd, StackedItemsToAdd, InstancedItemsToRemove, StackedItemsToRemove, InstancedItemsToSave);
    if (TransactionResult.success) {
        logger_1.logger.info(`Ran transactionId ${TransactionId} for userId ${UserId} and characterId ${CharacterId}`);
        res.status(200);
        res.json({
            createdInstancedItems: InstancedItemsToAdd,
            updatedInstancedItems: [], // TODO: Actually properly diff & merge the JSON blobs
            updatedStackedItems: TransactionResult.data != undefined ? TransactionResult.data : [],
            removedInstancedItems: InstancedItemsToRemove
        });
        return;
    }
    else {
        logger_1.logger.error(`transactionId ${TransactionId} for userId ${UserId} and characterId ${CharacterId} FAILED!`);
        res.status(StatusForInventoryError(TransactionResult.error));
        res.send();
        return;
    }
});
exports.inventoryRouter.post("/inventory/instanceditem", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const CharacterId = req.body.characterId;
    const UserId = req.AuthData.IsGameserver ? req.body.accountId : req.AuthData.userId;
    const InstanceId = req.body.instanceId;
    const CatalogId = req.body.catalogId;
    const ItemData = req.body.itemData;
    const UpdateVersion = req.body.updateVersion;
    const ItemResult = await (0, inventory_1.UpdateInstancedItem)(CharacterId, UserId, InstanceId, CatalogId, ItemData, UpdateVersion);
    if (ItemResult.success) {
        res.status(200);
        res.json(ItemResult.data);
    }
    else {
        res.status(StatusForInventoryError(ItemResult.error));
        res.send();
    }
});
