import type { RedisClient } from "@ma/cache";

const RESUME_TTL_S = 24 * 3600;

export interface DerivePass {
  cursorKey: string;
  resumeKey: string;
  cursor: Date;
  passStart: Date;
  afterId: number;
  resumed: boolean;
}

/**
 * A derive pass walks ids in ascending order. When the job deadline cuts it short the
 * next run resumes after the last finished id, with the same cursor, so the cursor only
 * advances (to when the pass began) once every candidate has been processed.
 */
export async function beginPass(
  redis: RedisClient,
  keys: { cursorKey: string; resumeKey: string },
  now: Date,
  initialCursor: Date,
): Promise<DerivePass> {
  const [cursorRaw, resumeRaw] = await Promise.all([
    redis.get(keys.cursorKey),
    redis.get(keys.resumeKey),
  ]);
  const resume = parseResume(resumeRaw);
  return {
    ...keys,
    cursor: cursorRaw ? new Date(cursorRaw) : initialCursor,
    passStart: resume?.passStart ?? now,
    afterId: resume?.afterId ?? 0,
    resumed: resume !== null,
  };
}

export async function endPass(
  redis: RedisClient,
  pass: DerivePass,
  outcome: { complete: boolean; lastId: number },
): Promise<void> {
  if (outcome.complete) {
    await redis.set(pass.cursorKey, pass.passStart.toISOString());
    await redis.del(pass.resumeKey);
    return;
  }
  const state = { passStart: pass.passStart.toISOString(), afterId: outcome.lastId };
  await redis.set(pass.resumeKey, JSON.stringify(state), "EX", RESUME_TTL_S);
}

export function parseResume(raw: string | null): { passStart: Date; afterId: number } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { passStart?: unknown; afterId?: unknown };
    const passStart = typeof v.passStart === "string" ? new Date(v.passStart) : null;
    if (!passStart || Number.isNaN(passStart.getTime())) return null;
    if (typeof v.afterId !== "number" || !Number.isInteger(v.afterId)) return null;
    return { passStart, afterId: v.afterId };
  } catch {
    return null;
  }
}
