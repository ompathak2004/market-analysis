import { Chip, Ext, Sym } from "@/components/ui/chip";
import { DataTable } from "@/components/ui/data-table";
import { Empty } from "@/components/ui/empty";
import { Chg, Num } from "@/components/ui/num";
import { Pane } from "@/components/ui/pane";
import { Timeline, type TimelineItem } from "@/components/ui/timeline";
import { clampText, shortDate } from "@/lib/format";
import { getContext } from "@/server/context";
import {
  type AltdataActivityItem,
  altdataActivity,
  type LatestBrokerCall,
  latestBrokerCalls,
} from "@/server/queries";
import { ActionBadge, attempt, PaneError, ratingTone } from "../shared";

export function callDigest(c: {
  thesis: { keyPoints: string[] } | null;
  summary: string | null;
  title: string | null;
}): string | null {
  const s = c.thesis?.keyPoints[0] ?? c.summary ?? c.title;
  return s ? clampText(s, 200) : null;
}

export async function BrokerCallsPane() {
  const res = await attempt(latestBrokerCalls(getContext(), 40));
  if (!res.ok)
    return (
      <PaneError
        id="calls"
        title="BROKER CALLS"
        area="calls"
        code={res.code}
        source="Moneycontrol"
      />
    );
  const rows = res.data;
  return (
    <Pane
      id="calls"
      title="BROKER CALLS"
      area="calls"
      meta="latest research"
      hints="j/k rows · ↵ company · ⇧↵ report PDF"
      foot={
        <>
          <output data-digest-out>Moneycontrol · targets in INR</output>
          <span className="right">⇧↵ report</span>
        </>
      }
    >
      <DataTable<LatestBrokerCall>
        label="Latest broker calls"
        rows={rows}
        rowKey={(r) => r.id}
        rowLink={(r) => `/c/${encodeURIComponent(r.symbol)}/anr`}
        rowExternal={(r) => r.reportUrl}
        rowDigest={(r) => callDigest(r) ?? `${r.broker} · ${r.rating}`}
        rowSub={(r) => callDigest(r)}
        columns={[
          {
            key: "d",
            header: "DATE",
            width: "sm",
            sortable: true,
            sortValue: (r) => r.publishedAt,
            cell: (r) => <span className="dim">{shortDate(r.publishedAt).slice(0, 6)}</span>,
          },
          {
            key: "s",
            header: "SYMBOL",
            width: "sym",
            cell: (r) => <Sym symbol={r.symbol} tab="anr" />,
          },
          { key: "b", header: "BROKER", cell: (r) => r.broker, title: (r) => r.broker },
          {
            key: "a",
            header: "ACTION",
            width: "sm",
            priority: 2,
            cell: (r) => <ActionBadge action={r.action} />,
          },
          {
            key: "r",
            header: "RATING",
            width: "sm",
            cell: (r) => <span className={ratingTone(r.rating)}>{r.rating}</span>,
            title: (r) => (r.priorRating ? `prior ${r.priorRating}` : r.rating),
          },
          {
            key: "t",
            header: "TARGET",
            width: "num",
            align: "right",
            sortable: true,
            sortValue: (r) => r.targetPrice,
            cell: (r) => <Num v={r.targetPrice} digits={0} />,
          },
          {
            key: "u",
            header: "UPSIDE",
            width: "pct",
            align: "right",
            sortable: true,
            sortValue: (r) => r.upsidePct,
            cell: (r) => <Chg v={r.upsidePct} digits={1} />,
          },
          {
            key: "p",
            header: "PDF",
            width: "sm",
            priority: 3,
            cell: (r) => <Ext href={r.reportUrl}>PDF</Ext>,
          },
        ]}
        empty={
          <Empty title="No broker calls" hint="Moneycontrol research">
            Moneycontrol research has not been ingested yet.
          </Empty>
        }
      />
    </Pane>
  );
}

function altItem(a: AltdataActivityItem, tab: "jet" | "ship"): TimelineItem {
  return {
    key: String(a.id),
    at: a.occurredAt,
    tone: a.severity >= 3 ? "neg" : a.severity >= 2 ? "warn" : "accent",
    ...(a.symbol ? { href: `/c/${encodeURIComponent(a.symbol)}/${tab}` } : {}),
    body: (
      <>
        {a.symbol ? <span className="sym">{a.symbol}</span> : null}
        {a.symbol ? " · " : ""}
        <span title={a.headline}>{a.headline}</span>
      </>
    ),
  };
}

export async function AltDataPane({ layer }: { layer?: "air" | "sea" }) {
  const res = await attempt(altdataActivity(getContext(), 40));
  if (!res.ok) return <PaneError id="alt" title="ALT-DATA ACTIVITY" area="alt" code={res.code} />;
  const air = res.data.filter((a) => a.layer === "air");
  const sea = res.data.filter((a) => a.layer === "sea");
  const show = (l: "air" | "sea") => !layer || layer === l;
  return (
    <Pane
      id="alt"
      title="ALT-DATA ACTIVITY"
      area="alt"
      meta={`${res.data.length} flags`}
      tabs={
        <>
          <Chip href="/" active={!layer}>
            ALL
          </Chip>
          <Chip href="/?alt=air" active={layer === "air"}>
            JETS
          </Chip>
          <Chip href="/?alt=sea" active={layer === "sea"}>
            SHIPS
          </Chip>
        </>
      }
      foot={<output>ADS-B · AIS · company links provisional · no intent inferred</output>}
    >
      {show("air") ? (
        <section className="pane-section">
          <h3>Jets · ADS-B · {air.length}</h3>
          {air.length ? (
            <Timeline items={air.slice(0, 8).map((a) => altItem(a, "jet"))} />
          ) : (
            <Empty title="No travel flags" hint="ADS-B · corporate registry">
              Corporate aircraft legs appear here once the registry is seeded and the jets job runs.
            </Empty>
          )}
        </section>
      ) : null}
      {show("sea") ? (
        <section className="pane-section">
          <h3>Ships · AIS · {sea.length}</h3>
          {sea.length ? (
            <Timeline items={sea.slice(0, 8).map((a) => altItem(a, "ship"))} />
          ) : (
            <Empty title="No logistics flags" hint="AIS · facility geofences">
              Port calls and chokepoint loitering appear here once facilities are seeded and AIS
              coverage is confirmed.
            </Empty>
          )}
        </section>
      ) : null}
    </Pane>
  );
}
