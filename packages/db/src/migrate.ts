import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, createDb } from "./client.js";

const MIGRATE_LOCK = "drizzle_migrate";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const db = createDb(url, 1);
await db.execute(sql`select pg_advisory_lock(hashtext(${MIGRATE_LOCK}))`);
await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
await db.execute(sql`select pg_advisory_unlock(hashtext(${MIGRATE_LOCK}))`);
await closeDb(db);
