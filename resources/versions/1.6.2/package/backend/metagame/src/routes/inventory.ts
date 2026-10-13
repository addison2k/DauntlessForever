import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { logger } from "../logger";
import { GetInventoryForUserIdAndCharacterId, InventoryError, RunInventoryTransaction, UpdateInstancedItem } from "../controllers/inventory";

export const inventoryRouter = Router();

function StatusForInventoryError(Error: InventoryError){
    switch(Error){
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

inventoryRouter.post("/inventory/:characterId/:changeList", HasUndauntedMetagameAuth, (req: any, res) => {
    logger.info("Inventory migration (stubbed)");

    res.status(200);
    res.json({
        code: null,
        message: ""
    });
});

inventoryRouter.get("/inventory/:userId/:characterId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const UserId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;
    
    req.AuthData.userId;
    const CharacterId = req.params.characterId;

    logger.info(`UserId ${UserId} requested inventory for CharacterId ${CharacterId}`);

    const InventoryResult = await GetInventoryForUserIdAndCharacterId(UserId, CharacterId);

    if(InventoryResult.success){
        res.status(200);
        res.json(InventoryResult.data);
    }
    else{
        res.status(StatusForInventoryError(InventoryResult.error));
        res.send();
    }
});

inventoryRouter.post("/inventory", HasUndauntedMetagameAuth, async (req: any, res) => {
    const UserId = req.AuthData.IsGameserver ? req.body.accountId : req.AuthData.userId;
    const CharacterId = req.body.characterId;
    const TransactionId = req.body.transactionId;
    const InstancedItemsToAdd = req.body.addInstancedItems;
    const StackedItemsToAdd = req.body.addStackedItems;
    const InstancedItemsToRemove = req.body.removeInstancedItems;
    const StackedItemsToRemove = req.body.removeStackedItems;
    const InstancedItemsToSave = req.body.saveInstancedItems;

    const TransactionResult = await RunInventoryTransaction(UserId, CharacterId, TransactionId, InstancedItemsToAdd, StackedItemsToAdd, InstancedItemsToRemove, StackedItemsToRemove, InstancedItemsToSave);

    if(TransactionResult.success){
        logger.info(`Ran transactionId ${TransactionId} for userId ${UserId} and characterId ${CharacterId}`);

        res.status(200);
        res.json({
            createdInstancedItems: InstancedItemsToAdd,
            updatedInstancedItems: [], // TODO: Actually properly diff & merge the JSON blobs
            updatedStackedItems: TransactionResult.data != undefined ? TransactionResult.data : [],
            removedInstancedItems: InstancedItemsToRemove
        });

        return;
    }
    else{
        logger.error(`transactionId ${TransactionId} for userId ${UserId} and characterId ${CharacterId} FAILED!`);

        res.status(StatusForInventoryError(TransactionResult.error));
        res.send();
        return;
    }
});

inventoryRouter.post("/inventory/instanceditem", HasUndauntedMetagameAuth, async (req: any, res) => {
    const CharacterId = req.body.characterId;
    const UserId = req.AuthData.IsGameserver ? req.body.accountId : req.AuthData.userId;
    const InstanceId = req.body.instanceId;
    const CatalogId = req.body.catalogId;
    const ItemData = req.body.itemData;
    const UpdateVersion = req.body.updateVersion;

    const ItemResult = await UpdateInstancedItem(CharacterId, UserId, InstanceId, CatalogId, ItemData, UpdateVersion);

    if(ItemResult.success){
        res.status(200);
        res.json(ItemResult.data);
    }
    else{
        res.status(StatusForInventoryError(ItemResult.error));
        res.send();
    }
});
