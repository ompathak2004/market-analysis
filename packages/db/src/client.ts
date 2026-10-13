import { chunk, guardCommit, throwIfAborted } from "@ma/core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * A business write that commits only if the caller is still allowed to: the signal (and the
 * ambient deadline scope) is not aborted and the scope's commit guard, which the worker sets to
 * its lease fence, passes as the last statement before COMMIT.
 */
export function fencedTransaction<T>(
  db: Pick<Db, "transaction">,
  fn: (tx: Tx) => Promise<T>,
  signal?: AbortSignal | null,
): Promise<T> {
  throwIfAborted(signal);
  return db.transaction(async (tx) => {
    const result = await fn(tx);
    await guardCommit(tx, signal);
    return result;
  });
}

/** Writes `rows` in fenced transactions of `size`, checking for abort before each batch. */
export async function fencedBatches<T>(
  db: Pick<Db, "transaction">,
  rows: readonly T[],
  write: (tx: Tx, batch: T[]) => Promise<unknown>,
  opts: { size?: number; signal?: AbortSignal | null } = {},
): Promise<void> {
  for (const batch of chunk([...rows], opts.size ?? 200)) {
    throwIfAborted(opts.signal);
    await fencedTransaction(db, (tx) => write(tx, batch), opts.signal);
  }
}

export function createDb(url: string, max = 3) {
  const local = /localhost|127\.0\.0\.1/.test(url);
  const sql = postgres(url, {
    max,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,
    ...(local ? {} : { ssl: "require" as const }),
  });
  return drizzle(sql, { schema, casing: "snake_case" });
}

export async function closeDb(db: Db): Promise<void> {
  await db.$client.end({ timeout: 5 });
}
