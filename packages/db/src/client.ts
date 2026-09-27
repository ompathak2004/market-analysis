import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

export function createDb(url: string, max = 10) {
  const sql = postgres(url, { max, idle_timeout: 30, connect_timeout: 15, prepare: true });
  return drizzle(sql, { schema, casing: "snake_case" });
}

export async function closeDb(db: Db): Promise<void> {
  await db.$client.end({ timeout: 5 });
}
