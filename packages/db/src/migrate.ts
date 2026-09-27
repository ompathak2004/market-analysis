import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, createDb } from "./client.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const db = createDb(url, 1);
await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
await closeDb(db);
