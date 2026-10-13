// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import * as schema from "./db/schema"

 const db = drizzle(process.env.DB_FILENAME!, {schema});

let didMigration = false;

export function GetDb(){
    if(!didMigration){
        didMigration = true;

        migrate(db, {migrationsFolder: "./src/drizzle"});
    }

    return db;
}