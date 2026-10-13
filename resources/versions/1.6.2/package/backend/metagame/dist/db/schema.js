// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invitecodes = exports.encounteredcontent = exports.breadcrumbs = exports.gameserverapikeystoregister = exports.userapikeystoregister = exports.userapikeys = exports.gameserverapikeys = exports.loadouts = exports.inventory = exports.characters = exports.users = void 0;
const sqlite_core_1 = require("drizzle-orm/sqlite-core");
exports.users = (0, sqlite_core_1.sqliteTable)("users", {
    userId: (0, sqlite_core_1.text)("userId").notNull().primaryKey(),
    name: (0, sqlite_core_1.text)("name").notNull(),
    notes: (0, sqlite_core_1.integer)("notes").notNull(),
    isAdmin: (0, sqlite_core_1.integer)("isAdmin", { mode: "boolean" }).notNull().default(false)
});
exports.characters = (0, sqlite_core_1.sqliteTable)("characters", {
    characterId: (0, sqlite_core_1.text)("characterId").notNull().primaryKey(),
    userId: (0, sqlite_core_1.text)("userId").notNull(),
    createdDate: (0, sqlite_core_1.text)("createdDate").notNull(),
    lastModifiedDate: (0, sqlite_core_1.text)("lastModifiedDate").notNull(),
    name: (0, sqlite_core_1.text)("name").notNull(),
    updateVersion: (0, sqlite_core_1.integer)("updateVersion").notNull(),
    data: (0, sqlite_core_1.text)("data").notNull()
});
exports.inventory = (0, sqlite_core_1.sqliteTable)("inventories", {
    characterId: (0, sqlite_core_1.text)("characterId").notNull().primaryKey(),
    instancedItems: (0, sqlite_core_1.text)("instancedItems").notNull(),
    stackedItems: (0, sqlite_core_1.text)("stackedItems").notNull()
});
exports.loadouts = (0, sqlite_core_1.sqliteTable)("loadouts", {
    characterId: (0, sqlite_core_1.text)("characterId").notNull().primaryKey(),
    userId: (0, sqlite_core_1.text)("userId").notNull(),
    loadouts: (0, sqlite_core_1.text)("loadouts").notNull(),
    persistent: (0, sqlite_core_1.text)("persistent").notNull()
});
exports.gameserverapikeys = (0, sqlite_core_1.sqliteTable)("gameserverapikeys", {
    id: (0, sqlite_core_1.integer)("id").notNull().primaryKey({ autoIncrement: true }),
    keyHash: (0, sqlite_core_1.text)("keyHash")
});
exports.userapikeys = (0, sqlite_core_1.sqliteTable)("userapikeys", {
    userId: (0, sqlite_core_1.text)("userId").notNull().primaryKey(),
    keyHash: (0, sqlite_core_1.text)("keyHash").notNull()
});
exports.userapikeystoregister = (0, sqlite_core_1.sqliteTable)("userapikeystoregister", {
    userId: (0, sqlite_core_1.text)("userId").notNull().primaryKey(),
    key: (0, sqlite_core_1.text)("key").notNull()
});
exports.gameserverapikeystoregister = (0, sqlite_core_1.sqliteTable)("gameserverapikeystoregister", {
    key: (0, sqlite_core_1.text)("key").primaryKey()
});
exports.breadcrumbs = (0, sqlite_core_1.sqliteTable)("breadcrumbs", {
    characterId: (0, sqlite_core_1.text)("characterId").notNull().primaryKey(),
    userId: (0, sqlite_core_1.text)("userId").notNull(),
    breadcrumbs: (0, sqlite_core_1.text)("breadcrumbs").notNull(),
    updateVersion: (0, sqlite_core_1.integer)("updateVersion").notNull()
});
exports.encounteredcontent = (0, sqlite_core_1.sqliteTable)("encounteredcontent", {
    characterId: (0, sqlite_core_1.text)("characterId").notNull().primaryKey(),
    userId: (0, sqlite_core_1.text)("userId").notNull(),
    encounteredcontent: (0, sqlite_core_1.text)("encounteredcontent").notNull()
});
exports.invitecodes = (0, sqlite_core_1.sqliteTable)("invitecodes", {
    inviteCode: (0, sqlite_core_1.text)("invitecode").notNull().primaryKey(),
    usesRemaining: (0, sqlite_core_1.integer)("usesRemaining").notNull(),
    infiniteUses: (0, sqlite_core_1.integer)("infiniteUses", { mode: "boolean" }).notNull()
});
