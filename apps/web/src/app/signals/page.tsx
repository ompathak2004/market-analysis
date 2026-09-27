import { Leaderboard, Panel, Unavailable } from "@/components/panels";
import { ApiError, attempt, getLeaderboard } from "@/lib/api";
import { signalLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

const KINDS = [
  "distress_score",
  "customer_momentum_1m",
  "customer_momentum_3m",
  "supplier_momentum_3m",
  "customer_concentration_pct",
  "top5_customers_pct",
  "top10_customers_pct",
  "customer_hhi",
];

export default async function SignalsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const { kind } = await searchParams;
  const kinds = kind ? [kind] : KINDS;
  const boards = await Promise.all(kinds.map((k) => attempt(getLeaderboard(k, 25))));
  return (
    <div className="grid grid-2">
      {kinds.map((k, i) => (
        <Panel key={k} title={signalLabel(k)} sub={<a href={`/signals?kind=${k}`}>{k}</a>}>
          <div className="panel-body tight">
            {boards[i]?.ok ? (
              <Leaderboard kind={k} rows={boards[i].data.rows} />
            ) : (
              <Unavailable error={boards[i]?.error ?? new ApiError(0, "missing", "no result")} />
            )}
          </div>
        </Panel>
      ))}
    </div>
  );
}
