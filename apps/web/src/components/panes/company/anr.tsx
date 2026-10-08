import { Suspense } from "react";
import { Callout, CalloutGroup } from "@/components/ui/callout";
import { Badge, Ext } from "@/components/ui/chip";
import { DataTable } from "@/components/ui/data-table";
import { type DistPart, Distribution } from "@/components/ui/distribution";
import { Empty } from "@/components/ui/empty";
import { KeyValue } from "@/components/ui/key-value";
import { Chg, Num } from "@/components/ui/num";
import { Pane, PaneSkeleton } from "@/components/ui/pane";
import { Bars } from "@/components/ui/sparkline";
import { TargetRange } from "@/components/ui/target-range";
import { Timeline } from "@/components/ui/timeline";
import { fyLabel, num, pct, ratingBucket, shortDate } from "@/lib/format";
import { getContext } from "@/server/context";
import {
  type BrokerCall,
  brokerDigest,
  type CompanyCalls,
  type CompanyResearch,
  companyCalls,
  companyResearch,
} from "@/server/queries";
import { callDigest } from "../home/flow";
import { ActionBadge, attempt, modelFoot, PaneError, ratingTone } from "../shared";

function latestByBroker(calls: BrokerCall[]): BrokerCall[] {
  const seen = new Map<string, BrokerCall>();
  for (const c of calls) if (!seen.has(c.broker)) seen.set(c.broker, c);
  return [...seen.values()];
}

type Research = CompanyResearch & CompanyCalls;

function distParts(r: Research): { parts: DistPart[]; source: string } {
  if (r.ratings)
    return {
      source: `Moneycontrol · ${r.ratings.analystCount ?? "?"} analysts`,
      parts: [
        { key: "sb", label: "BUY", value: r.ratings.buyPct ?? 0 },
        { key: "b", label: "OUT", value: r.ratings.outperformPct ?? 0 },
        { key: "h", label: "HOLD", value: r.ratings.holdPct ?? 0 },
        { key: "u", label: "UNDER", value: r.ratings.underperformPct ?? 0 },
        { key: "s", label: "SELL", value: r.ratings.sellPct ?? 0 },
      ],
    };
  const counts = { SB: 0, B: 0, H: 0, S: 0, "—": 0 };
  for (const c of latestByBroker(r.calls)) counts[ratingBucket(c.rating)]++;
  return {
    source: "latest call per broker",
    parts: [
      { key: "sb", label: "STRONG BUY", value: counts.SB },
      { key: "b", label: "BUY", value: counts.B },
      { key: "h", label: "HOLD", value: counts.H },
      { key: "s", label: "SELL", value: counts.S },
    ],
  };
}

async function load(symbol: string) {
  const ctx = getContext();
  return attempt(
    Promise.all([companyResearch(ctx, symbol), companyCalls(ctx, symbol)]).then(
      ([research, calls]): Research => ({ ...research, ...calls }),
    ),
  );
}

export async function ConsensusPane({ symbol }: { symbol: string }) {
  const res = await load(symbol);
  if (!res.ok)
    return <PaneError id="consensus" title="CONSENSUS" area="consensus" code={res.code} />;
  const r = res.data;
  const { parts, source } = distParts(r);
  const total = parts.reduce((s, p) => s + p.value, 0);
  const history = r.consensusHistory.map((m) => {
    const buy = (m.buy ?? 0) + (m.outperform ?? 0);
    const all = buy + (m.hold ?? 0) + (m.underperform ?? 0) + (m.sell ?? 0);
    return {
      label: m.month.slice(5, 7),
      value: all ? (buy / all) * 100 : 0,
      tone: "pos" as const,
    };
  });
  return (
    <Pane
      id="consensus"
      title="CONSENSUS"
      area="consensus"
      meta={r.ratings?.finalRating ?? (total ? `${total} ratings` : "—")}
      foot={<output>{source}</output>}
      pad
    >
      {total ? (
        <>
          <Distribution parts={parts} label={`Rating distribution for ${symbol}`} />
          {history.length ? (
            <div className="pane-section">
              <div className="section-title">Buy share · monthly</div>
              <Bars data={history} label="Monthly buy share" height={56} />
            </div>
          ) : null}
        </>
      ) : (
        <Empty title="No ratings" hint="Moneycontrol research">
          No broker ratings are on file for {symbol}.
        </Empty>
      )}
    </Pane>
  );
}

export async function TargetsPane({ symbol }: { symbol: string }) {
  const ctx = getContext();
  const [res, dg] = await Promise.all([load(symbol), attempt(brokerDigest(ctx, symbol))]);
  if (!res.ok)
    return <PaneError id="targets" title="TARGET PRICE" area="targets" code={res.code} />;
  const r = res.data;
  const current = latestByBroker(r.calls)
    .map((c) => c.targetPrice)
    .filter((t): t is number => t != null && t > 0)
    .sort((a, b) => a - b);
  const target = r.priceTargets;
  const low = target?.low ?? current[0] ?? null;
  const high = target?.high ?? current.at(-1) ?? null;
  const mean =
    target?.mean ?? (current.length ? current.reduce((s, t) => s + t, 0) / current.length : null);
  const median = current.length ? (current[Math.floor((current.length - 1) / 2)] ?? null) : null;
  const upside = mean != null && r.price ? ((mean - r.price) / r.price) * 100 : null;
  const digest = dg.ok && dg.data.digest ? { ...dg.data, digest: dg.data.digest } : null;
  return (
    <Pane
      id="targets"
      title="TARGET PRICE"
      area="targets"
      meta={target ? `as of ${shortDate(target.asOf)}` : `${current.length} targets`}
      foot={<output>{digest?.meta ? modelFoot(digest.meta) : "Moneycontrol targets · INR"}</output>}
    >
      {low != null && high != null ? (
        <>
          <div className="pane-section">
            <TargetRange low={low} high={high} mean={mean} price={r.price} />
          </div>
          <KeyValue
            label="Target summary"
            groups={[
              {
                items: [
                  { label: "Price", value: num(r.price) },
                  { label: "Mean target", value: num(mean, 0) },
                  { label: "Median target", value: num(median, 0) },
                  { label: "Low / high", value: `${num(low, 0)} / ${num(high, 0)}` },
                  { label: "Upside to mean", value: <Chg v={upside} digits={1} /> },
                  { label: "Brokers with target", value: String(current.length) },
                ],
              },
            ]}
          />
          {digest ? (
            <CalloutGroup title="Broker digest">
              <Callout tone="info" title="Consensus read" row={false}>
                {digest.digest.consensusRead}
              </Callout>
              <Callout
                tone={
                  digest.digest.revisionMomentum.direction === "up"
                    ? "pos"
                    : digest.digest.revisionMomentum.direction === "down"
                      ? "neg"
                      : "neu"
                }
                title={`Revisions ${digest.digest.revisionMomentum.direction}`}
                row={false}
              >
                {digest.digest.revisionMomentum.read}
              </Callout>
            </CalloutGroup>
          ) : null}
        </>
      ) : (
        <Empty title="No targets">No broker has published a price target for {symbol}.</Empty>
      )}
    </Pane>
  );
}

type Estimate = CompanyResearch["estimates"][number];
type SurpriseQuarter = CompanyResearch["surprises"][number];
type Surprise = NonNullable<SurpriseQuarter["eps"]> & { metric: string; quarterEnd: string };

const SURPRISE_METRICS = ["eps", "revenue", "netProfit"] as const;

function flattenSurprises(quarters: SurpriseQuarter[]): Surprise[] {
  return quarters.flatMap((q) =>
    SURPRISE_METRICS.flatMap((metric) => {
      const s = q[metric];
      return s ? [{ ...s, metric, quarterEnd: q.quarterEnd }] : [];
    }),
  );
}

export async function EstimatesPane({ symbol }: { symbol: string }) {
  const res = await load(symbol);
  if (!res.ok)
    return <PaneError id="estimates" title="ESTIMATES" area="estimates" code={res.code} />;
  const { estimates } = res.data;
  const surprises = flattenSurprises(res.data.surprises);
  const beats = surprises.filter((s) => s.outcome === "beat").length;
  const misses = surprises.filter((s) => s.outcome === "miss").length;
  return (
    <Pane
      id="estimates"
      title="ESTIMATES"
      area="estimates"
      meta={`${estimates.length} lines`}
      actions={
        surprises.length ? (
          <Badge tone={beats >= misses ? "pos" : "neg"}>
            BEATS {beats} · MISSES {misses}
          </Badge>
        ) : null
      }
      foot={<output>Moneycontrol consensus estimates · ₹ Cr / ₹ per share</output>}
    >
      <DataTable<Estimate>
        label="Consensus estimates"
        rows={estimates}
        rowKey={(e) => `${e.metric}-${e.fiscalYearEnd}`}
        columns={[
          { key: "m", header: "METRIC", cell: (e) => e.metric.toUpperCase() },
          { key: "fy", header: "FY", width: "sm", cell: (e) => fyLabel(e.fiscalYearEnd) },
          {
            key: "lo",
            header: "LOW",
            width: "num",
            align: "right",
            priority: 2,
            cell: (e) => <Num v={e.low} />,
          },
          {
            key: "avg",
            header: "AVG",
            width: "num",
            align: "right",
            sortable: true,
            sortValue: (e) => e.avg,
            cell: (e) => <Num v={e.avg} />,
          },
          {
            key: "hi",
            header: "HIGH",
            width: "num",
            align: "right",
            priority: 2,
            cell: (e) => <Num v={e.high} />,
          },
          {
            key: "act",
            header: "ACTUAL",
            width: "num",
            align: "right",
            priority: 3,
            cell: (e) => <Num v={e.actual} />,
          },
        ]}
        empty={
          <Empty title="No estimates">Consensus estimates are not available for {symbol}.</Empty>
        }
      />
      {surprises.length ? (
        <DataTable<Surprise>
          label="Hits and misses"
          caption="Hits & misses"
          rows={surprises}
          rowKey={(s) => `${s.metric}-${s.quarterEnd}`}
          columns={[
            { key: "q", header: "QTR", width: "sm", cell: (s) => fyLabel(s.quarterEnd, true) },
            { key: "m", header: "METRIC", cell: (s) => s.metric.toUpperCase() },
            {
              key: "a",
              header: "ACTUAL",
              width: "num",
              align: "right",
              cell: (s) => <Num v={s.actual} />,
            },
            {
              key: "e",
              header: "EST",
              width: "num",
              align: "right",
              priority: 2,
              cell: (s) => <Num v={s.estimate} />,
            },
            {
              key: "s",
              header: "SURPRISE",
              width: "pct",
              align: "right",
              sortable: true,
              sortValue: (s) => s.surprisePct,
              cell: (s) => <Chg v={s.surprisePct} digits={1} />,
            },
          ]}
        />
      ) : null}
    </Pane>
  );
}

export async function ResearchPane({ symbol }: { symbol: string }) {
  const res = await load(symbol);
  if (!res.ok)
    return <PaneError id="research" title="BROKER RESEARCH" area="research" code={res.code} />;
  const { calls, price } = res.data;
  return (
    <Pane
      id="research"
      title="BROKER RESEARCH"
      area="research"
      meta={`${calls.length} reports · 12M`}
      hints="j/k reports · ↵ open PDF"
      foot={
        <>
          <output>Moneycontrol research · digest from ingested report</output>
          <span className="right">↵ PDF</span>
        </>
      }
    >
      {calls.length ? (
        <ul data-rows>
          {calls.map((c) => {
            const up = c.targetPrice && price ? ((c.targetPrice - price) / price) * 100 : null;
            const tgtDelta =
              c.targetPrice && c.priorTargetPrice
                ? ((c.targetPrice - c.priorTargetPrice) / c.priorTargetPrice) * 100
                : null;
            return (
              <li
                key={c.id}
                className="broker-card"
                data-row=""
                data-ext={c.reportUrl ?? undefined}
              >
                <header>
                  <span className="dim">{shortDate(c.publishedAt)}</span>
                  <b>{c.broker}</b>
                  <ActionBadge action={c.action} />
                  <span className={ratingTone(c.rating)}>{c.rating}</span>
                  <span className="right">
                    <span>
                      TGT <Num v={c.targetPrice} digits={0} />{" "}
                      {up != null ? <Chg v={up} digits={1} /> : null}
                    </span>
                    {c.priceAtCall ? <span className="dim">@ {num(c.priceAtCall)}</span> : null}
                    <Ext href={c.reportUrl}>PDF</Ext>
                  </span>
                </header>
                <span className="dim clamp-2">{callDigest(c) ?? "No digest yet."}</span>
                <span className="muted sm">
                  Δ vs prior: target {tgtDelta != null ? pct(tgtDelta, 1) : "—"} · rating{" "}
                  {c.priorRating && c.priorRating !== c.rating
                    ? `${c.priorRating} → ${c.rating}`
                    : "unchanged"}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty title="No research in 12 months" hint="Moneycontrol research">
          Broker reports for {symbol} appear here with a digest of what each one says.
        </Empty>
      )}
    </Pane>
  );
}

export async function RevisionsPane({ symbol }: { symbol: string }) {
  const res = await load(symbol);
  if (!res.ok) return <PaneError id="timeline" title="REVISIONS" area="timeline" code={res.code} />;
  const events = res.data.calls.filter((c) =>
    c.action !== "maintain" && c.action !== "reiterate"
      ? true
      : c.priorTargetPrice != null && c.targetPrice !== c.priorTargetPrice,
  );
  return (
    <Pane
      id="timeline"
      title="REVISIONS"
      area="timeline"
      meta={`${events.length} events`}
      foot={<output>rating and target changes</output>}
    >
      {events.length ? (
        <Timeline
          items={events.map((c) => {
            const t =
              c.action === "upgrade" || c.action === "raise_target"
                ? "pos"
                : c.action === "downgrade" || c.action === "lower_target"
                  ? "neg"
                  : "neu";
            return {
              key: String(c.id),
              at: c.publishedAt,
              tone: t,
              body: (
                <>
                  <b>{c.broker}</b>{" "}
                  {c.priorRating && c.priorRating !== c.rating ? `${c.priorRating} → ` : ""}
                  {c.rating}
                  {c.targetPrice
                    ? ` · TGT ${c.priorTargetPrice ? `${num(c.priorTargetPrice, 0)} → ` : ""}${num(c.targetPrice, 0)}`
                    : ""}
                </>
              ),
            };
          })}
        />
      ) : (
        <Empty title="No revisions">No upgrades, downgrades or target changes on file.</Empty>
      )}
    </Pane>
  );
}

export function AnrView({ symbol }: { symbol: string }) {
  return (
    <div className="grid grid-anr">
      <Suspense fallback={<PaneSkeleton id="consensus" title="CONSENSUS" area="consensus" />}>
        <ConsensusPane symbol={symbol} />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="targets" title="TARGET PRICE" area="targets" />}>
        <TargetsPane symbol={symbol} />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="estimates" title="ESTIMATES" area="estimates" />}>
        <EstimatesPane symbol={symbol} />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="research" title="BROKER RESEARCH" area="research" />}>
        <ResearchPane symbol={symbol} />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="timeline" title="REVISIONS" area="timeline" />}>
        <RevisionsPane symbol={symbol} />
      </Suspense>
    </div>
  );
}
