import { z } from "zod";

export const symbolParams = z.object({ symbol: z.string().min(1).max(20) });
export const rangeQuery = z.object({
  range: z.enum(["5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "max"]).default("1y"),
});
export const limitQuery = (max: number, fallback: number) =>
  z.object({ limit: z.coerce.number().int().min(1).max(max).default(fallback) });
export const isoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
