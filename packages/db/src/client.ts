import { chunk, guardCommit, throwIfAborted } from "@ma/core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./tables.js";

export type Db = ReturnType<typeof createDb>;

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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

export interface DbOptions {
  applicationName?: string;
  statementTimeoutMs?: number;
}

export function createDb(url: string, max = 3, opts: DbOptions = {}) {
  const local = /localhost|127\.0\.0\.1/.test(url);
  const sql = postgres(url, {
    max,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,
    connection: {
      ...(opts.applicationName ? { application_name: opts.applicationName } : {}),
      ...(opts.statementTimeoutMs ? { statement_timeout: opts.statementTimeoutMs } : {}),
    },
    ...(local ? {} : { ssl: "require" as const }),
  });
  return drizzle(sql, { schema, casing: "snake_case" });
}

export async function closeDb(db: Db): Promise<void> {
  await db.$client.end({ timeout: 5 });
}
