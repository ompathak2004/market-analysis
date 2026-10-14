import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { OBJECT_PREFIXES, type ObjectStore, sha256, throwIfAborted } from "@ma/core";
import { type Db, sql } from "@ma/db";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const BACKUP_CHUNK_ROWS = 5_000;
export const BACKUP_OBJECT_KIND = "backup";
const MAGIC = Buffer.from("MABK1\n", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_INFO = "market-analysis/backup/v1";

export interface BackupResult {
  key: string;
  rows: number;
  maxId: number;
  bytes: number;
  sha256: string;
  encrypted: boolean;
}

export function backupKey(table: string, day: string, encrypted: boolean): string {
  return `${OBJECT_PREFIXES.backups}${table}-${day}.ndjson.gz${encrypted ? ".enc" : ""}`;
}

function deriveKey(keyHex: string): Buffer {
  const secret = Buffer.from(keyHex, "hex");
  if (secret.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must be 32 bytes of hex");
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), KEY_INFO, 32));
}

export function encryptBackup(plain: Uint8Array, keyHex: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(keyHex), iv);
  cipher.setAAD(MAGIC);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decryptBackup(sealed: Uint8Array, keyHex: string): Buffer {
  const buf = Buffer.from(sealed);
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not an encrypted backup");
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = buf.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(keyHex), iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(buf.subarray(MAGIC.length + IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]);
}

export async function readBackup(body: Uint8Array, keyHex?: string | null): Promise<string[]> {
  const gz = keyHex ? decryptBackup(body, keyHex) : Buffer.from(body);
  const text = (await gunzipAsync(gz)).toString("utf8");
  return text.split("\n").filter((line) => line.length > 0);
}

export async function backupAnnouncements(
  db: Pick<Db, "execute">,
  objects: ObjectStore,
  opts: {
    day: string;
    maxId: number;
    encryptionKey?: string | null;
    signal?: AbortSignal;
    chunkRows?: number;
  },
): Promise<BackupResult> {
  const chunkRows = opts.chunkRows ?? BACKUP_CHUNK_ROWS;
  const parts: Buffer[] = [];
  let after = 0;
  let rows = 0;
  for (;;) {
    throwIfAborted(opts.signal);
    const page = await db.execute<{ id: number; line: string }>(sql`
      select a.id, row_to_json(a)::text as line from announcements a
      where a.id > ${after} and a.id <= ${opts.maxId} order by a.id limit ${chunkRows}`);
    if (!page.length) break;
    parts.push(await gzipAsync(Buffer.from(`${page.map((r) => r.line).join("\n")}\n`, "utf8")));
    rows += page.length;
    after = Number(page[page.length - 1]?.id ?? after);
    if (page.length < chunkRows) break;
  }
  const gz = Buffer.concat(parts);
  const encrypted = !!opts.encryptionKey;
  const body = opts.encryptionKey ? encryptBackup(gz, opts.encryptionKey) : gz;
  const digest = sha256(body);
  const key = backupKey("announcements", opts.day, encrypted);
  await objects.put(key, body, digest, encrypted ? "application/octet-stream" : "application/gzip");
  if (!(await backupMatches(objects, key, body.byteLength, digest))) {
    throw new Error(`backup ${key} did not verify: expected ${body.byteLength} bytes`);
  }
  await db.execute(sql`
    insert into storage_objects (key, sha256, bytes, kind)
    values (${key}, ${digest}, ${body.byteLength}, ${BACKUP_OBJECT_KIND})
    on conflict (key) do update set sha256 = excluded.sha256, bytes = excluded.bytes,
      created_at = now()`);
  return { key, rows, maxId: opts.maxId, bytes: body.byteLength, sha256: digest, encrypted };
}

async function backupMatches(
  objects: ObjectStore,
  key: string,
  bytes: number,
  digest: string,
): Promise<boolean> {
  const head = await objects.head(key);
  return !!head && head.bytes === bytes && (head.sha256 === null || head.sha256 === digest);
}

export async function verifyBackup(
  db: Pick<Db, "execute">,
  objects: ObjectStore,
  key: string,
): Promise<{ bytes: number; sha256: string } | null> {
  const rows = await db.execute<{ bytes: number; sha256: string }>(sql`
    select bytes, sha256 from storage_objects where key = ${key} and kind = ${BACKUP_OBJECT_KIND}`);
  const row = rows[0];
  if (!row) return null;
  return (await backupMatches(objects, key, Number(row.bytes), row.sha256))
    ? { bytes: Number(row.bytes), sha256: row.sha256 }
    : null;
}
