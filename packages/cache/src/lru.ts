export class Lru<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  deletePrefix(prefix: string): void {
    for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k);
  }

  get size(): number {
    return this.map.size;
  }
}
