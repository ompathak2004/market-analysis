import { sql } from "@ma/db";
import { RELATIONSHIP_EXTRACTOR_VERSION } from "@ma/ingest";
import { CONCENTRATION_MODEL_VERSION } from "./concentration.js";
import { HORIZONS, MOMENTUM_MODEL_VERSION } from "./momentum.js";
import { RISK_MODEL_VERSION } from "./risk.js";

const TOP_CUSTOMERS_KIND = /^top\d+_customers_pct$/;
const TOP_CUSTOMERS_PATTERN = "^top[0-9]+_customers_pct$";

export const ACTIVE_SIGNAL_VERSIONS: Readonly<Record<string, number>> = {
  customer_concentration_pct: RELATIONSHIP_EXTRACTOR_VERSION,
  customer_hhi: CONCENTRATION_MODEL_VERSION,
  ...Object.fromEntries(
    Object.keys(HORIZONS).flatMap((h) => [
      [`customer_momentum_${h}`, MOMENTUM_MODEL_VERSION],
      [`supplier_momentum_${h}`, MOMENTUM_MODEL_VERSION],
    ]),
  ),
  distress_score: RISK_MODEL_VERSION,
};

export function activeSignalVersion(kind: string): number | null {
  return (
    ACTIVE_SIGNAL_VERSIONS[kind] ??
    (TOP_CUSTOMERS_KIND.test(kind) ? RELATIONSHIP_EXTRACTOR_VERSION : null)
  );
}

type SqlFragment = ReturnType<typeof sql>;

export function activeSignalVersionClause(kind: SqlFragment, version: SqlFragment): SqlFragment {
  const cases = sql.join(
    Object.entries(ACTIVE_SIGNAL_VERSIONS).map(([k, v]) => sql`when ${k}::text then ${v}::int`),
    sql` `,
  );
  return sql`${version} = coalesce(
    case ${kind} ${cases} end,
    case when ${kind} ~ ${TOP_CUSTOMERS_PATTERN} then ${RELATIONSHIP_EXTRACTOR_VERSION}::int end,
    ${version})`;
}
