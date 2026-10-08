import { unstable_cache } from "next/cache";

export const REVALIDATE = {
  market: 60,
  movers: 300,
  company: 300,
  altdata: 300,
  signals: 300,
  briefs: 300,
} as const;

export type CacheTag = "market" | "signals" | "briefs" | "altdata" | `company:${string}`;

export function companyTag(symbol: string): CacheTag {
  return `company:${symbol.toUpperCase()}`;
}

export function cached<A extends Array<string | number>, R>(
  name: string,
  fn: (...args: A) => Promise<R>,
  opts: { revalidate: number; tags: (...args: A) => CacheTag[] },
): (...args: A) => Promise<R> {
  return (...args: A) =>
    unstable_cache(() => fn(...args), [name, ...args.map(String)], {
      revalidate: opts.revalidate,
      tags: opts.tags(...args),
    })();
}
