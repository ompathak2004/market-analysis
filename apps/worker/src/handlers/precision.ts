import {
  fencedTransaction,
  relationshipPrecisionSampleItems,
  relationshipPrecisionSamples,
  sql,
} from "@ma/db";
import { NonRetryableError } from "@ma/jobs";
import { done, type HandlerMap } from "../registry.js";

const SAMPLE_SIZE_DEFAULT = 100;

export const precisionHandlers: Pick<HandlerMap, "relationships.sample"> = {
  "relationships.sample": async ({ ctx, payload, signal }) => {
    const seed = payload.seed ?? payload.name;
    const family = payload.family ?? null;
    const result = await fencedTransaction(
      ctx.db,
      async (tx) => {
        const [existing] = await tx.execute<{ id: number; items: number }>(sql`
          select s.id, (select count(*)::int from relationship_precision_sample_items i
                        where i.sample_id = s.id) as items
          from relationship_precision_samples s
          where s.name = ${payload.name}`);
        if (existing) return { id: Number(existing.id), items: Number(existing.items), created: 0 };
        const picked = await tx.execute<{ id: number }>(sql`
          select o.id from relationship_observations o
          join relationship_extractions ex on ex.id = o.extraction_id
          where o.status in ('auto', 'confirmed', 'rejected')
            ${family ? sql`and ex.extractor_family = ${family}` : sql``}
            and exists (
              select 1 from relationships r
              where r.status = 'active'
                and r.supplier_counterparty_id = o.supplier_counterparty_id
                and r.customer_counterparty_id = o.customer_counterparty_id
                and r.cost_bucket = o.cost_bucket)
          order by md5(${seed}::text || o.id::text), o.id
          limit ${payload.size ?? SAMPLE_SIZE_DEFAULT}`);
        if (!picked.length)
          throw new NonRetryableError(
            `no observations behind active edges${family ? ` from ${family}` : ""} to sample`,
          );
        const [sample] = await tx
          .insert(relationshipPrecisionSamples)
          .values({ name: payload.name, extractorFamily: family, size: picked.length, seed })
          .returning({ id: relationshipPrecisionSamples.id });
        const id = Number(sample?.id);
        await tx
          .insert(relationshipPrecisionSampleItems)
          .values(
            picked.map((p, i) => ({ sampleId: id, observationId: Number(p.id), position: i + 1 })),
          );
        return { id, items: picked.length, created: 1 };
      },
      signal,
    );
    return done({ sample: result.id, items: result.items, created: result.created });
  },
};
