import { chunk, sha256, throwIfAborted } from "@ma/core";
import { and, announcements, companies, desc, eq, inArray, insights, isNull } from "@ma/db";
import type { IntelContext } from "./context.js";
import { inputMessage, TRIAGE_SYSTEM } from "./prompts.js";
import { INSIGHT_MODEL_VERSION, type TriageItem, triageBatchSchema } from "./schemas.js";
import { isRoutineAnnouncement } from "./triage-rules.js";
import { NO_EVIDENCE, validateClaims } from "./validate.js";

export const TRIAGE_MODEL_VERSION = INSIGHT_MODEL_VERSION;
export const TRIAGE_BATCH = 20;
export const ROUTINE_SO_WHAT = "Routine compliance filing; no impact on the investment case.";

export interface TriageCandidate {
  id: number;
  companyId: number;
  symbol: string;
  publishedAt: string;
  subject: string;
  category: string | null;
  details: string | null;
}

export interface TriageStats {
  candidates: number;
  routine: number;
  triaged: number;
  missing: number;
  calls: number;
}

export function triageItemInput(c: TriageCandidate) {
  return {
    announcementId: c.id,
    symbol: c.symbol,
    publishedAt: c.publishedAt,
    subject: c.subject.slice(0, 200),
    exchangeCategory: c.category,
    details: c.details ? c.details.replace(/\s+/g, " ").slice(0, 400) : null,
  };
}

export function reconcileTriage(
  batch: readonly TriageCandidate[],
  items: readonly TriageItem[],
): Array<{ candidate: TriageCandidate; item: TriageItem }> {
  const byId = new Map(batch.map((c) => [c.id, c]));
  const out = new Map<number, { candidate: TriageCandidate; item: TriageItem }>();
  for (const item of items) {
    const candidate = byId.get(item.announcementId);
    if (!candidate || out.has(item.announcementId)) continue;
    const grounded =
      validateClaims(item.soWhat, triageItemInput(candidate), { known: NO_EVIDENCE }).length === 0;
    const soWhat = (grounded && item.soWhat.trim() ? item.soWhat : candidate.subject).slice(0, 160);
    out.set(item.announcementId, { candidate, item: { ...item, soWhat } });
  }
  return [...out.values()];
}

export async function loadTriageCandidates(
  ctx: IntelContext,
  opts: { limit: number; companyIds?: readonly number[] },
): Promise<TriageCandidate[]> {
  const rows = await ctx.db
    .select({
      id: announcements.id,
      companyId: announcements.companyId,
      symbol: companies.nseSymbol,
      name: companies.name,
      publishedAt: announcements.publishedAt,
      subject: announcements.subject,
      category: announcements.category,
      details: announcements.details,
    })
    .from(announcements)
    .innerJoin(companies, eq(companies.id, announcements.companyId))
    .where(
      and(
        isNull(announcements.triageModelVersion),
        opts.companyIds ? inArray(announcements.companyId, [...opts.companyIds]) : undefined,
      ),
    )
    .orderBy(desc(announcements.publishedAt), desc(announcements.id))
    .limit(opts.limit);
  return rows.map((r) => ({
    id: r.id,
    companyId: r.companyId,
    symbol: r.symbol ?? r.name,
    publishedAt: r.publishedAt.toISOString(),
    subject: r.subject,
    category: r.category ?? null,
    details: r.details ?? null,
  }));
}

async function markRoutine(ctx: IntelContext, ids: number[]): Promise<void> {
  if (!ids.length) return;
  throwIfAborted();
  await ctx.db
    .update(announcements)
    .set({
      materiality: "low",
      triageCategory: "routine",
      soWhat: ROUTINE_SO_WHAT,
      triageModelVersion: TRIAGE_MODEL_VERSION,
    })
    .where(inArray(announcements.id, ids));
}

export async function triageAnnouncements(
  ctx: IntelContext,
  opts: { limit: number; companyIds?: readonly number[]; expired?: () => boolean },
): Promise<TriageStats> {
  const candidates = await loadTriageCandidates(ctx, opts);
  const routine = candidates.filter((c) => isRoutineAnnouncement(c.subject, c.details));
  await markRoutine(
    ctx,
    routine.map((c) => c.id),
  );
  const rest = candidates.filter((c) => !routine.includes(c));
  const stats: TriageStats = {
    candidates: candidates.length,
    routine: routine.length,
    triaged: 0,
    missing: 0,
    calls: 0,
  };
  for (const batch of chunk(rest, TRIAGE_BATCH)) {
    if (opts.expired?.()) break;
    const res = await ctx.llm.complete({
      name: "announcement_triage",
      system: TRIAGE_SYSTEM,
      user: inputMessage({ items: batch.map(triageItemInput) }),
      schema: triageBatchSchema,
      maxOutputTokens: 3_000,
      temperature: 0,
    });
    stats.calls++;
    const matched = reconcileTriage(batch, res.data.items);
    stats.missing += batch.length - matched.length;
    const perItemPrompt = Math.round(res.promptTokens / batch.length);
    const perItemCompletion = Math.round(res.completionTokens / batch.length);
    for (const { candidate, item } of matched) {
      const input = triageItemInput(candidate);
      throwIfAborted();
      await ctx.db
        .update(announcements)
        .set({
          materiality: item.materiality,
          triageCategory: item.category,
          soWhat: item.soWhat,
          triageModelVersion: TRIAGE_MODEL_VERSION,
        })
        .where(eq(announcements.id, candidate.id));
      await ctx.db
        .insert(insights)
        .values({
          companyId: candidate.companyId,
          kind: "announcement_triage",
          subjectId: candidate.id,
          modelVersion: TRIAGE_MODEL_VERSION,
          model: res.model,
          inputHash: sha256(JSON.stringify(input)),
          inputs: input,
          output: item,
          confidence: null,
          promptTokens: perItemPrompt,
          completionTokens: perItemCompletion,
        })
        .onConflictDoNothing();
      stats.triaged++;
    }
  }
  return stats;
}
