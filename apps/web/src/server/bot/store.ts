import type { Conversation, TraceRecord } from "@ma/agent";
import { CONVERSATION_VERSION } from "@ma/agent";
import type { RedisClient } from "@ma/cache";

const CONV_TTL_S = 7 * 86_400;
const TRACE_TTL_S = 14 * 86_400;
const TRACE_INDEX = "bot:traces";
const TRACE_INDEX_MAX = 500;
const LOCK_MS = 90_000;
const DEDUPE_S = 600;

export interface TraceIndexEntry {
  traceId: string;
  at: string;
  conversationId: string;
  status: string;
  failure: string | null;
  durationMs: number | null;
}

export class BotStore {
  constructor(private readonly redis: RedisClient) {}

  async load(id: string): Promise<Conversation | null> {
    const raw = await this.redis.get(`bot:conv:${id}`);
    if (!raw) return null;
    const conv = JSON.parse(raw) as Conversation;
    return conv.version === CONVERSATION_VERSION ? conv : null;
  }

  async save(conv: Conversation): Promise<void> {
    await this.redis.set(`bot:conv:${conv.id}`, JSON.stringify(conv), "EX", CONV_TTL_S);
  }

  async remove(id: string): Promise<void> {
    await this.redis.unlink(`bot:conv:${id}`);
  }

  async claimRequest(requestId: string): Promise<boolean> {
    return (await this.redis.set(`bot:req:${requestId}`, "1", "EX", DEDUPE_S, "NX")) === "OK";
  }

  async lock(conversationId: string, token: string): Promise<boolean> {
    return (
      (await this.redis.set(`bot:lock:${conversationId}`, token, "PX", LOCK_MS, "NX")) === "OK"
    );
  }

  async unlock(conversationId: string, token: string): Promise<void> {
    await this.redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
      1,
      `bot:lock:${conversationId}`,
      token,
    );
  }

  async saveTrace(record: TraceRecord, entry: TraceIndexEntry): Promise<void> {
    await this.redis
      .multi()
      .set(`bot:trace:${record.traceId}`, JSON.stringify(record), "EX", TRACE_TTL_S)
      .lpush(TRACE_INDEX, JSON.stringify(entry))
      .ltrim(TRACE_INDEX, 0, TRACE_INDEX_MAX - 1)
      .expire(TRACE_INDEX, TRACE_TTL_S)
      .exec();
  }

  async trace(traceId: string): Promise<TraceRecord | null> {
    const raw = await this.redis.get(`bot:trace:${traceId}`);
    return raw ? (JSON.parse(raw) as TraceRecord) : null;
  }

  async recentTraces(limit: number): Promise<TraceIndexEntry[]> {
    const rows = await this.redis.lrange(TRACE_INDEX, 0, Math.max(0, limit - 1));
    return rows.map((r) => JSON.parse(r) as TraceIndexEntry);
  }
}
