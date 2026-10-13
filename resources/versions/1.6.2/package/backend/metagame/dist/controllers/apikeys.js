// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DrainAndRegisterAPIKeys = DrainAndRegisterAPIKeys;
exports.IsValidGameserverAPIKey = IsValidGameserverAPIKey;
const db_1 = require("../db");
const schema_1 = require("../db/schema");
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../logger");
function HashGameserverAPIKey(GameserverAPIKeyToHash) {
    return crypto_1.default.createHash("sha256").update(GameserverAPIKeyToHash, "utf8").digest("hex");
}
async function DrainAndRegisterAPIKeys() {
    const APIKeysToRegister = await (0, db_1.GetDb)().query.gameserverapikeystoregister.findMany();
    await (0, db_1.GetDb)().delete(schema_1.gameserverapikeystoregister);
    for (const APIKey of APIKeysToRegister) {
        await (0, db_1.GetDb)().insert(schema_1.gameserverapikeys).values({
            keyHash: HashGameserverAPIKey(APIKey.key)
        });
    }
    logger_1.logger.info(`Registered ${APIKeysToRegister.length} new Gameserver API Key(s) on boot!`);
}
async function IsValidGameserverAPIKey(GameserverAPIKey) {
    const AllAPIKeyHashes = await (0, db_1.GetDb)().query.gameserverapikeys.findMany();
    const IncomingGameserverAPIKeyHashBuffer = Buffer.from(HashGameserverAPIKey(GameserverAPIKey), "hex");
    let Match = false;
    for (const CmpAPIKeyHash of AllAPIKeyHashes) {
        const CmpAPIKeyHashBuffer = Buffer.from(CmpAPIKeyHash.keyHash, "hex");
        if (CmpAPIKeyHashBuffer.length !== IncomingGameserverAPIKeyHashBuffer.length) {
            continue;
        }
        if (crypto_1.default.timingSafeEqual(IncomingGameserverAPIKeyHashBuffer, CmpAPIKeyHashBuffer)) {
            Match = true;
        }
    }
    return Match;
}
