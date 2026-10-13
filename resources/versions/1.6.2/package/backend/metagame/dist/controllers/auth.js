// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HashUserAPIKey = HashUserAPIKey;
exports.DrainAndRegisterUserAPIKeys = DrainAndRegisterUserAPIKeys;
exports.GetUserIDForAPIKey = GetUserIDForAPIKey;
exports.SignMetagameJWTForUid = SignMetagameJWTForUid;
exports.ValidateMetagameJWTAndGetPayload = ValidateMetagameJWTAndGetPayload;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("../db");
const schema_1 = require("../db/schema");
const logger_1 = require("../logger");
const PRIVKEY = Buffer.from(process.env.AUTH_SIGNING_PRIVKEY_B64, "base64").toString("utf-8");
const PUBKEY = Buffer.from(process.env.AUTH_SIGNING_PUBKEY_B64, "base64").toString("utf-8");
function HashUserAPIKey(UserAPIKeyToHash) {
    return crypto_1.default.createHash("sha256").update(UserAPIKeyToHash, "utf8").digest("hex");
}
async function DrainAndRegisterUserAPIKeys() {
    const APIKeysToRegister = await (0, db_1.GetDb)().query.userapikeystoregister.findMany();
    await (0, db_1.GetDb)().delete(schema_1.userapikeystoregister);
    for (const APIKey of APIKeysToRegister) {
        await (0, db_1.GetDb)().insert(schema_1.userapikeys).values({
            userId: APIKey.userId,
            keyHash: HashUserAPIKey(APIKey.key)
        });
    }
    logger_1.logger.info(`Registered ${APIKeysToRegister.length} new User API Key(s) on boot!`);
}
async function GetUserIDForAPIKey(UserAPIKey) {
    const AllAPIKeyHashes = await (0, db_1.GetDb)().query.userapikeys.findMany();
    const IncomingUserAPIKeyHashBuffer = Buffer.from(HashUserAPIKey(UserAPIKey), "hex");
    let UserId = undefined;
    for (const CmpAPIKeyHash of AllAPIKeyHashes) {
        const CmpAPIKeyHashBuffer = Buffer.from(CmpAPIKeyHash.keyHash, "hex");
        if (CmpAPIKeyHashBuffer.length !== IncomingUserAPIKeyHashBuffer.length) {
            continue;
        }
        if (crypto_1.default.timingSafeEqual(IncomingUserAPIKeyHashBuffer, CmpAPIKeyHashBuffer)) {
            UserId = CmpAPIKeyHash.userId;
        }
    }
    return UserId;
}
function SignMetagameJWTForUid(userId) {
    return jsonwebtoken_1.default.sign({
        userId: userId
    }, PRIVKEY, {
        algorithm: "RS256",
        expiresIn: "24h",
        issuer: "undaunted-metagame",
        audience: "undaunted-metagame"
    });
}
function ValidateMetagameJWTAndGetPayload(token) {
    return jsonwebtoken_1.default.verify(token, PUBKEY, {
        algorithms: ["RS256"],
        issuer: "undaunted-metagame",
        audience: "undaunted-metagame"
    });
}
