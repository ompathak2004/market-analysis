export const OBJECT_PREFIXES = { raw: "raw/", text: "text/", backups: "backups/" } as const;
export type ObjectKind = keyof typeof OBJECT_PREFIXES;

export interface ObjectMeta {
  bytes: number;
  sha256: string | null;
}

export interface ObjectStore {
  put(key: string, body: Uint8Array, sha256: string, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  head(key: string): Promise<ObjectMeta | null>;
  remove(keys: readonly string[]): Promise<void>;
}

export function objectKey(kind: ObjectKind, sha256: string, extension: string): string {
  return `${OBJECT_PREFIXES[kind]}${sha256.slice(0, 2)}/${sha256}.${extension}`;
}

export function objectKind(key: string): ObjectKind | null {
  for (const [kind, prefix] of Object.entries(OBJECT_PREFIXES)) {
    if (key.startsWith(prefix)) return kind as ObjectKind;
  }
  return null;
}

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Uint8Array; sha256: string }>();

  async put(key: string, body: Uint8Array, sha256: string): Promise<void> {
    this.objects.set(key, { body, sha256 });
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.body ?? null;
  }

  async head(key: string): Promise<ObjectMeta | null> {
    const obj = this.objects.get(key);
    return obj ? { bytes: obj.body.byteLength, sha256: obj.sha256 } : null;
  }

  async remove(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
  }
}
