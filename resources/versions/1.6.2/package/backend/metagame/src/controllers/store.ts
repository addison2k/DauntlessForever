// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import { eq } from "drizzle-orm";
import { GetDb } from "../db";
import { users } from "../db/schema";

export async function GetNotesForUser(userId: string){
    let UserFromDb = await GetDb().query.users.findFirst({where: eq(users.userId, userId)});

    return UserFromDb!.notes;
}