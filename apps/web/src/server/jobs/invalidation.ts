import type { AppContext } from "../context";

const BRIEF_INPUTS = "insights:";

export const JOB_INVALIDATIONS: Record<string, readonly string[]> = {
  universe: ["search:", "company:"],
  prices: ["prices:", "movers:", "quote:", "company:", BRIEF_INPUTS],
  fundamentals: ["financials:", "company:", BRIEF_INPUTS],
  announcements: ["announcements:", BRIEF_INPUTS],
  relationships: [
    "supply-chain:",
    "signals:",
    "leaderboard:",
    "financials:",
    "company:",
    BRIEF_INPUTS,
  ],
  intel: ["signals:", "leaderboard:", "supply-chain:", "company:", BRIEF_INPUTS],
  moneycontrol: ["analysts:", "research:", "company:", BRIEF_INPUTS],
  "broker-reports": ["analysts:", BRIEF_INPUTS],
  insights: ["insights:", "feed:"],
  "market-brief": ["market-brief:"],
  triage: ["announcements:", "feed:", "market-brief:", BRIEF_INPUTS],
  "broker-theses": ["analysts:", BRIEF_INPUTS],
  "aircraft-registry": ["travel:", "logistics:", "altdata:"],
  "aircraft-sample": ["travel:", "altdata:"],
  "ais-collect": ["logistics:", "altdata:"],
  "altdata-derive": ["travel:", "logistics:", "altdata:"],
  "altdata-signals": ["travel:", "logistics:", "altdata:", "signals:", BRIEF_INPUTS],
  fleets: ["logistics:"],
  "altdata-cleanup": ["travel:", "logistics:", "altdata:"],
};

export async function invalidateAfterJob(ctx: AppContext, job: string): Promise<void> {
  for (const prefix of JOB_INVALIDATIONS[job] ?? []) {
    await ctx.api
      .invalidatePrefix(prefix)
      .catch((err: unknown) => ctx.logger.warn({ job, prefix, err }, "cache invalidation failed"));
  }
}
