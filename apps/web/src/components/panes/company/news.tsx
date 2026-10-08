import { Suspense } from "react";
import { Badge, Ext } from "@/components/ui/chip";
import { DataTable } from "@/components/ui/data-table";
import { Empty } from "@/components/ui/empty";
import { KeyValue } from "@/components/ui/key-value";
import { Pane, PaneSkeleton } from "@/components/ui/pane";
import { istDateTime, istTime, shortDate } from "@/lib/format";
import { getContext } from "@/server/context";
import { companyAnnouncements } from "@/server/queries";
import { announcementDetail } from "@/server/queries/ui";
import { attempt, PaneError } from "../shared";

type Ann = NonNullable<Awaited<ReturnType<typeof companyAnnouncements>>>[number];

const MATERIALITY_TONE: Record<string, "neg" | "warn" | "info" | "neu"> = {
  high: "neg",
  medium: "warn",
  low: "neu",
};

function when(d: Date | string) {
  const iso = typeof d === "string" ? d : d.toISOString();
  const today = new Date().toISOString().slice(0, 10) === iso.slice(0, 10);
  return today ? istTime(iso) : shortDate(iso);
}

export function parseAnnouncementId(v: string | string[] | undefined): number | null {
  const s = Array.isArray(v) ? v[0] : v;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function FeedPane({ symbol, selected }: { symbol: string; selected: number | null }) {
  const res = await attempt(companyAnnouncements(getContext(), symbol, 80));
  if (!res.ok)
    return <PaneError id="feed" title="FILINGS & NEWS" area="feed" code={res.code} source="NSE" />;
  const rows = res.data ?? [];
  const active = selected ?? rows[0]?.id ?? null;
  const base = `/c/${encodeURIComponent(symbol)}/news`;
  return (
    <Pane
      id="feed"
      title="FILINGS & NEWS"
      area="feed"
      meta={`${rows.length} latest`}
      hints="j/k filings · ↵ read · z zoom"
      foot={
        <>
          <output>NSE corporate announcements · triage by materiality</output>
          <span className="right">↵ detail</span>
        </>
      }
    >
      <DataTable<Ann>
        label="Announcements"
        rows={rows}
        rowKey={(a) => a.id}
        rowLink={(a) => `${base}?a=${a.id}`}
        rowExternal={(a) => a.attachmentUrl}
        rowSelected={(a) => a.id === active}
        columns={[
          {
            key: "t",
            header: "TIME",
            width: "date",
            sortable: true,
            sortValue: (a) => new Date(a.publishedAt).getTime(),
            cell: (a) => <span className="dim">{when(a.publishedAt)}</span>,
            title: (a) => istDateTime(a.publishedAt),
          },
          {
            key: "c",
            header: "CATEGORY",
            width: "md",
            priority: 2,
            cell: (a) => (
              <span className="dim truncate">{a.triageCategory ?? a.category ?? "—"}</span>
            ),
          },
          {
            key: "s",
            header: "SUBJECT",
            cell: (a) => <span className="truncate">{a.subject}</span>,
            title: (a) => a.subject,
          },
          {
            key: "m",
            header: "MAT",
            width: "sm",
            priority: 3,
            cell: (a) =>
              a.materiality ? (
                <Badge tone={MATERIALITY_TONE[a.materiality] ?? "neu"}>
                  {a.materiality.slice(0, 3).toUpperCase()}
                </Badge>
              ) : null,
          },
        ]}
        empty={
          <Empty title="No filings" hint="pnpm job announcements">
            NSE announcements for {symbol} have not been ingested yet.
          </Empty>
        }
      />
    </Pane>
  );
}

export async function DetailPane({
  symbol,
  selected,
}: {
  symbol: string;
  selected: number | null;
}) {
  const ctx = getContext();
  let id = selected;
  if (id == null) {
    const list = await attempt(companyAnnouncements(ctx, symbol, 80));
    id = list.ok ? (list.data?.[0]?.id ?? null) : null;
  }
  if (id == null)
    return (
      <Pane id="detail" title="DETAIL" area="detail">
        <Empty title="Nothing selected">Pick a filing on the left to read it here.</Empty>
      </Pane>
    );
  const res = await attempt(announcementDetail(ctx, symbol, id));
  if (!res.ok) return <PaneError id="detail" title="DETAIL" area="detail" code={res.code} />;
  const a = res.data;
  if (!a)
    return (
      <Pane id="detail" title="DETAIL" area="detail">
        <Empty title="Filing not found">
          Announcement {id} does not belong to {symbol}.
        </Empty>
      </Pane>
    );
  return (
    <Pane
      id="detail"
      title="DETAIL"
      area="detail"
      meta={istDateTime(a.publishedAt)}
      actions={<Ext href={a.attachmentUrl}>ATTACHMENT</Ext>}
      foot={<output>NSE filing #{a.id}</output>}
    >
      <div className="pane-section">
        <div className="headline">{a.subject}</div>
      </div>
      {a.soWhat ? (
        <div className="pane-section">
          <h3>So what</h3>
          <p className="read">{a.soWhat}</p>
        </div>
      ) : null}
      <KeyValue
        label="Filing metadata"
        groups={[
          {
            items: [
              { label: "Category", value: a.category ?? "—" },
              { label: "Triage", value: a.triageCategory ?? "pending" },
              {
                label: "Materiality",
                value: a.materiality ? (
                  <Badge tone={MATERIALITY_TONE[a.materiality] ?? "neu"}>
                    {a.materiality.toUpperCase()}
                  </Badge>
                ) : (
                  "—"
                ),
              },
              { label: "Published", value: istDateTime(a.publishedAt) },
            ],
          },
        ]}
      />
      <div className="pane-section">
        <h3>Details</h3>
        {a.details ? (
          <p className="read">{a.details}</p>
        ) : (
          <p className="dim">
            The exchange filing carries no text body; open the attachment for the full document.
          </p>
        )}
      </div>
    </Pane>
  );
}

export function NewsView({ symbol, selected }: { symbol: string; selected: number | null }) {
  return (
    <div className="grid grid-news">
      <Suspense fallback={<PaneSkeleton id="feed" title="FILINGS & NEWS" area="feed" lines={20} />}>
        <FeedPane symbol={symbol} selected={selected} />
      </Suspense>
      <Suspense
        key={String(selected)}
        fallback={<PaneSkeleton id="detail" title="DETAIL" area="detail" />}
      >
        <DetailPane symbol={symbol} selected={selected} />
      </Suspense>
    </div>
  );
}
