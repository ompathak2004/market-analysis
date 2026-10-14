import { Suspense } from "react";
import { Badge, type ChipTone, Sym } from "@/components/ui/chip";
import { type Column, DataTable } from "@/components/ui/data-table";
import { Empty } from "@/components/ui/empty";
import { EvidenceLine } from "@/components/ui/evidence";
import { Num } from "@/components/ui/num";
import { Pane, PaneSkeleton } from "@/components/ui/pane";
import { clampText, istDateTime, num, shortDate, toNum } from "@/lib/format";
import { confidenceLabel, sourceLabel } from "@/lib/splc";
import { getContext } from "@/server/context";
import {
  type InfluenceDirector,
  type InfluenceEntity,
  type InfluenceEvent,
  type InfluenceEvidence,
  type InfluencePolicyEvent,
  type InfluencePoliticalLink,
  type InfluenceResponse,
  influenceFor,
} from "@/server/queries";
import { attempt, PaneError } from "../shared";

const ROLE_LABEL: Record<string, string> = {
  chairman: "CHAIR",
  md: "MD",
  ceo: "CEO",
  cfo: "CFO",
  independent_director: "INDEP",
  director: "DIR",
  kmp: "KMP",
  promoter: "PROMO",
  other: "OTHER",
};

const EVENT_LABEL: Record<string, string> = {
  director_change: "BOARD",
  material_rpt: "RPT",
  office_gained: "OFFICE+",
  office_lost: "OFFICE−",
  donation: "DONATION",
  policy_change: "POLICY",
};

const EVENT_TONE: Record<string, ChipTone> = {
  director_change: "info",
  material_rpt: "warn",
  office_gained: "accent",
  office_lost: "neu",
  donation: "warn",
  policy_change: "info",
};

const POLITICAL_LABEL: Record<InfluencePoliticalLink["kind"], string> = {
  holds_office: "OFFICE",
  declared_interest: "INTEREST",
  declared_family: "FAMILY",
  member_of_party: "PARTY",
  donated_to: "DONATION",
};

type BoardRow = {
  key: string;
  name: string;
  symbol: string | null;
  role: string;
  detail: string | null;
  since: string | null;
  until: string | null;
  past: boolean;
  confidence: number;
  evidence: InfluenceEvidence[];
};

type CoverageRow = {
  key: string;
  label: string;
  readAt: string | null;
  detail: string;
};

const QUOTE_FIELDS: ReadonlyArray<readonly [string, (v: string) => string]> = [
  ["name", (v) => v],
  ["counterparty", (v) => v],
  ["category", (v) => v],
  ["relationship", (v) => v],
  ["type", (v) => v],
  ["valueCr", (v) => `₹${num(v)} Cr`],
  ["din", (v) => `DIN ${v}`],
  ["appointedOn", (v) => `appointed ${shortDate(v)}`],
  ["ceasedOn", (v) => `ceased ${shortDate(v)}`],
];

function readableQuote(quote: string): string {
  if (!quote.startsWith("{")) return quote;
  try {
    const fact: unknown = JSON.parse(quote);
    if (!fact || typeof fact !== "object" || Array.isArray(fact)) return quote;
    const record = fact as Record<string, unknown>;
    const parts = QUOTE_FIELDS.flatMap(([key, show]) => {
      const v = record[key];
      return (typeof v === "string" && v.trim()) || typeof v === "number" ? [show(String(v))] : [];
    });
    return parts.length ? parts.join(" · ") : quote;
  } catch {
    return quote;
  }
}

function readable(items: readonly InfluenceEvidence[]): InfluenceEvidence[] {
  return items.map((e) => ({ ...e, quote: readableQuote(e.quote) }));
}

function digest(items: readonly InfluenceEvidence[]): string | null {
  const ev = items[0];
  return ev ? clampText(`${readableQuote(ev.quote)} — ${sourceLabel(ev.source)}`, 220) : null;
}

function confidenceTitle(confidence: number, past?: string | null): string {
  return [`confidence ${confidenceLabel(confidence)}`, past ? `until ${shortDate(past)}` : null]
    .filter(Boolean)
    .join(" · ");
}

function directorRow(d: InfluenceDirector): BoardRow {
  return {
    key: `d${d.edgeId}`,
    name: d.name,
    symbol: null,
    role: d.role ? (ROLE_LABEL[d.role] ?? d.role.toUpperCase()) : "DIR",
    detail: [d.din ? `DIN ${d.din}` : null, d.category].filter(Boolean).join(" · ") || null,
    since: d.validFrom,
    until: d.validTo,
    past: d.status === "past",
    confidence: d.confidence,
    evidence: d.evidence,
  };
}

function promoterRow(p: InfluenceEntity): BoardRow {
  return {
    key: `p${p.edgeId}`,
    name: p.name,
    symbol: p.symbol,
    role: "PROMO",
    detail: [p.pct != null ? `${num(p.pct, 2)}% held` : null, p.relationship]
      .filter(Boolean)
      .join(" · "),
    since: p.asOf ?? p.periodEnd,
    until: null,
    past: false,
    confidence: p.confidence,
    evidence: p.evidence,
  };
}

function entityLabel(e: InfluenceEntity): string {
  if (e.kind === "owns") return e.pct != null ? `SUBSIDIARY ${num(e.pct, 1)}%` : "SUBSIDIARY";
  return e.relationship ?? (e.nodeKind === "person" ? "KMP" : "RELATED PARTY");
}

const BOARD_COLUMNS: Column<BoardRow>[] = [
  {
    key: "n",
    header: "NAME",
    cell: (r) => (
      <span className="row">
        {r.symbol ? <Sym symbol={r.symbol} tab="infl" /> : null}
        <span className="truncate">{r.name}</span>
        {r.past ? <Badge tone="neu">PAST</Badge> : null}
      </span>
    ),
    title: (r) =>
      [r.name, r.detail, confidenceTitle(r.confidence, r.until)].filter(Boolean).join(" · "),
  },
  {
    key: "r",
    header: "ROLE",
    width: "sm",
    cell: (r) => (
      <Badge tone={r.role === "PROMO" ? "accent" : r.role === "INDEP" ? "neu" : "info"}>
        {r.role}
      </Badge>
    ),
  },
  {
    key: "x",
    header: "DETAIL",
    width: "md",
    priority: 2,
    cell: (r) => <span className="dim truncate">{r.detail ?? "—"}</span>,
    title: (r) => r.detail,
  },
  {
    key: "s",
    header: "SINCE",
    width: "date",
    priority: 2,
    sortable: true,
    sortValue: (r) => r.since,
    cell: (r) => (r.since ? shortDate(r.since) : "—"),
    title: (r) => (r.until ? `until ${shortDate(r.until)}` : null),
  },
];

const RELATED_COLUMNS: Column<InfluenceEntity>[] = [
  {
    key: "n",
    header: "ENTITY",
    cell: (r) => (
      <span className="row">
        {r.symbol ? <Sym symbol={r.symbol} tab="infl" /> : null}
        <span className="truncate">{r.name}</span>
      </span>
    ),
    title: (r) =>
      [r.name, r.counterpartyKind ?? r.nodeKind, confidenceTitle(r.confidence)].join(" · "),
  },
  {
    key: "k",
    header: "RELATIONSHIP",
    width: "md",
    cell: (r) => <span className="dim truncate">{entityLabel(r)}</span>,
    title: (r) =>
      [entityLabel(r), r.transactionType ? `largest: ${r.transactionType}` : null]
        .filter(Boolean)
        .join(" · "),
  },
  {
    key: "v",
    header: "Σ ₹CR",
    width: "num",
    align: "right",
    sortable: true,
    sortValue: (r) => toNum(r.totalCr),
    cell: (r) =>
      r.totalCr == null ? <span className="muted">—</span> : <Num v={r.totalCr} digits={1} />,
    title: (r) => (r.transactions > 1 ? `${r.transactions} transaction lines in the period` : null),
  },
  {
    key: "p",
    header: "PERIOD",
    width: "date",
    priority: 2,
    cell: (r) => (r.periodEnd ? shortDate(r.periodEnd) : r.asOf ? shortDate(r.asOf) : "—"),
  },
];

const POLITICAL_COLUMNS: Column<InfluencePoliticalLink>[] = [
  { key: "f", header: "PERSON", cell: (r) => <span className="truncate">{r.from}</span> },
  {
    key: "k",
    header: "LINK",
    width: "sm",
    cell: (r) => <Badge tone="warn">{POLITICAL_LABEL[r.kind]}</Badge>,
  },
  { key: "t", header: "TO", cell: (r) => <span className="dim truncate">{r.to}</span> },
  {
    key: "d",
    header: "SINCE",
    width: "date",
    priority: 2,
    cell: (r) => (r.validFrom ? shortDate(r.validFrom) : "—"),
  },
];

const POLICY_COLUMNS: Column<InfluencePolicyEvent>[] = [
  {
    key: "d",
    header: "DATE",
    width: "date",
    sortable: true,
    sortValue: (r) => r.publishedAt,
    cell: (r) => shortDate(r.publishedAt),
  },
  { key: "s", header: "SRC", width: "xs", cell: (r) => r.source.toUpperCase() },
  {
    key: "t",
    header: "TITLE",
    cell: (r) => <span className="truncate">{r.title}</span>,
    title: (r) => `${r.title} · applies to ${r.target}`,
  },
  {
    key: "m",
    header: "MINISTRY",
    width: "md",
    priority: 2,
    cell: (r) => <span className="dim truncate">{r.ministry ?? "—"}</span>,
  },
];

const EVENT_COLUMNS: Column<InfluenceEvent>[] = [
  {
    key: "d",
    header: "DATE",
    width: "date",
    sortable: true,
    sortValue: (r) => r.occurredAt,
    cell: (r) => shortDate(r.occurredAt),
  },
  {
    key: "k",
    header: "KIND",
    width: "sm",
    cell: (r) => (
      <Badge tone={EVENT_TONE[r.kind] ?? "neu"}>
        {EVENT_LABEL[r.kind] ?? r.kind.toUpperCase()}
      </Badge>
    ),
  },
  {
    key: "s",
    header: "CHANGE",
    cell: (r) => <span className={`truncate ${r.reviewed ? "" : "dim"}`}>{r.summary}</span>,
    title: (r) => (r.reviewed ? r.summary : `${r.summary} · awaiting review`),
  },
];

function coverageRows(data: InfluenceResponse): CoverageRow[] {
  const c = data.coverage;
  return [
    {
      key: "gov",
      label: "Board · NSE governance",
      readAt: c.governanceReadAt,
      detail: `${c.directorsListed} current`,
    },
    {
      key: "rpt",
      label: "Related parties · NSE",
      readAt: c.rptReadAt,
      detail: c.rptPeriodEnd ? `${c.rptRows} lines · ${shortDate(c.rptPeriodEnd)}` : "no filing",
    },
    {
      key: "per",
      label: "Perimeter",
      readAt: c.perimeterReadAt,
      detail: `${data.promoters.length} promoters · ${data.related.filter((r) => r.kind === "owns").length} subs`,
    },
    {
      key: "pol",
      label: "Political",
      readAt: null,
      detail: `${data.political.length} links`,
    },
    {
      key: "pcy",
      label: "Policy",
      readAt: null,
      detail: `${data.policy.length} events`,
    },
  ];
}

async function load(symbol: string) {
  return attempt(influenceFor(getContext(), symbol));
}

export async function BoardPane({ symbol }: { symbol: string }) {
  const res = await load(symbol);
  if (!res.ok)
    return <PaneError id="board" title="BOARD & PROMOTERS" area="board" code={res.code} />;
  const board = res.data.board.map(directorRow);
  const promoters = res.data.promoters.map(promoterRow);
  const current = board.filter((r) => !r.past).length;
  const groups = [
    ...(board.length ? [{ label: `BOARD · ${current} current`, rows: board }] : []),
    ...(promoters.length ? [{ label: `PROMOTERS · ${promoters.length}`, rows: promoters }] : []),
  ];
  return (
    <Pane
      id="board"
      title="BOARD & PROMOTERS"
      area="board"
      meta={`${current} directors · ${promoters.length} promoters`}
      hints="j/k rows · ↵ open company · ⇧↵ evidence · z zoom"
      foot={
        <>
          <output data-digest-out>DIN-keyed directors from NSE governance filings</output>
          <span className="right">confirmed edges only</span>
        </>
      }
    >
      <DataTable<BoardRow>
        label="Board and promoters"
        groups={groups}
        rowKey={(r) => r.key}
        rowLink={(r) => (r.symbol ? `/c/${encodeURIComponent(r.symbol)}/infl` : null)}
        rowExternal={(r) => r.evidence[0]?.url ?? null}
        rowDigest={(r) => digest(r.evidence)}
        rowSub={(r) => <EvidenceLine items={readable(r.evidence)} />}
        rowClass={(r) => (r.past ? "dim" : undefined)}
        columns={BOARD_COLUMNS}
        empty={
          <Empty title="NO BOARD ON FILE" hint="pnpm worker:cli run influence.governance.fanout">
            No confirmed directors or promoters for {symbol} yet.
          </Empty>
        }
      />
    </Pane>
  );
}

export async function RelatedPane({ symbol }: { symbol: string }) {
  const res = await load(symbol);
  if (!res.ok)
    return <PaneError id="related" title="RELATED ENTITIES" area="related" code={res.code} />;
  const rows = res.data.related;
  const total = rows.reduce((s, r) => s + (toNum(r.totalCr) ?? 0), 0);
  return (
    <Pane
      id="related"
      title="RELATED ENTITIES"
      area="related"
      meta={`${rows.length} confirmed`}
      hints="j/k rows · ↵ open company · ⇧↵ evidence · z zoom"
      foot={
        <>
          <output data-digest-out>
            {total ? `Σ ₹${Math.round(total).toLocaleString("en-IN")} Cr disclosed` : "—"}
            {res.data.coverage.pending
              ? ` · ${res.data.coverage.pending} links awaiting review`
              : ""}
          </output>
          <span className="right">NSE related-party disclosures</span>
        </>
      }
    >
      <DataTable<InfluenceEntity>
        label="Related entities"
        rows={rows}
        rowKey={(r) => r.edgeId}
        rowLink={(r) => (r.symbol ? `/c/${encodeURIComponent(r.symbol)}/infl` : null)}
        rowExternal={(r) => r.evidence[0]?.url ?? null}
        rowDigest={(r) => digest(r.evidence)}
        rowSub={(r) => <EvidenceLine items={readable(r.evidence)} />}
        columns={RELATED_COLUMNS}
        empty={
          <Empty
            title="NO CONFIRMED RELATED ENTITIES"
            hint="pnpm worker:cli run influence.rpt.fanout"
          >
            {res.data.coverage.pending
              ? `${res.data.coverage.pending} name-matched links for ${symbol} are awaiting review.`
              : `No related-party filing has been read for ${symbol}.`}
          </Empty>
        }
      />
    </Pane>
  );
}

export async function PoliticalPane({ symbol }: { symbol: string }) {
  const res = await load(symbol);
  if (!res.ok)
    return <PaneError id="political" title="POLITICAL LINKS" area="political" code={res.code} />;
  const rows = res.data.political;
  return (
    <Pane
      id="political"
      title="POLITICAL LINKS"
      area="political"
      meta={rows.length ? `${rows.length} links` : "not read"}
      foot={<output>public declarations only · no inference from names</output>}
    >
      <DataTable<InfluencePoliticalLink>
        label="Political links"
        rows={rows}
        rowKey={(r) => r.edgeId}
        rowExternal={(r) => r.evidence[0]?.url ?? null}
        rowDigest={(r) => digest(r.evidence)}
        rowSub={(r) => <EvidenceLine items={readable(r.evidence)} />}
        columns={POLITICAL_COLUMNS}
        empty={
          <Empty title="NOT YET READ" hint="parliament · myneta · eci bonds">
            Officeholder, affidavit and electoral-bond sources are not ingested yet.
          </Empty>
        }
      />
    </Pane>
  );
}

export async function PolicyPane({ symbol }: { symbol: string }) {
  const res = await load(symbol);
  if (!res.ok) return <PaneError id="policy" title="POLICY EVENTS" area="policy" code={res.code} />;
  const rows = res.data.policy;
  return (
    <Pane
      id="policy"
      title="POLICY EVENTS"
      area="policy"
      meta={rows.length ? `${rows.length} events` : "not read"}
      foot={<output>tagged to company or sector</output>}
    >
      <DataTable<InfluencePolicyEvent>
        label="Policy events"
        rows={rows}
        rowKey={(r) => r.edgeId}
        rowExternal={(r) => r.url}
        rowDigest={(r) => clampText(r.title, 220)}
        rowSub={(r) => <EvidenceLine items={readable(r.evidence)} />}
        columns={POLICY_COLUMNS}
        empty={
          <Empty title="NOT YET READ" hint="pib · e-gazette · prs">
            Policy releases are not ingested yet.
          </Empty>
        }
      />
    </Pane>
  );
}

export async function ChangeFeedPane({ symbol }: { symbol: string }) {
  const res = await load(symbol);
  if (!res.ok) return <PaneError id="feed" title="CHANGE FEED" area="feed" code={res.code} />;
  const rows = res.data.events;
  return (
    <Pane
      id="feed"
      title="CHANGE FEED"
      area="feed"
      meta={rows.length ? `latest ${shortDate(rows[0]?.occurredAt)}` : "—"}
      foot={<output>board changes · material related-party transactions</output>}
    >
      <DataTable<InfluenceEvent>
        label="Influence change feed"
        rows={rows}
        rowKey={(r) => r.id}
        rowDigest={(r) => clampText(r.summary, 220)}
        columns={EVENT_COLUMNS}
        empty={
          <Empty title="NO CHANGES YET" hint="changes appear after the second filing read">
            The first read of each filing sets the baseline for {symbol}.
          </Empty>
        }
      />
    </Pane>
  );
}

export async function InflCoveragePane({ symbol }: { symbol: string }) {
  const res = await load(symbol);
  if (!res.ok)
    return <PaneError id="infl-coverage" title="COVERAGE" area="coverage" code={res.code} />;
  const c = res.data.coverage;
  return (
    <Pane
      id="infl-coverage"
      title="COVERAGE"
      area="coverage"
      meta={`${c.confirmed} confirmed · ${c.pending} pending`}
      foot={
        <output>
          {c.pendingByKind.length
            ? `pending ${c.pendingByKind.map((p) => `${p.kind.replaceAll("_", " ")} ${p.count}`).join(" · ")}`
            : "no links awaiting review"}
          {c.resolverVersion != null ? ` · resolver v${c.resolverVersion}` : ""}
        </output>
      }
    >
      <DataTable<CoverageRow>
        label="Influence coverage by source"
        rows={coverageRows(res.data)}
        rowKey={(r) => r.key}
        columns={[
          { key: "l", header: "SOURCE", cell: (r) => <span className="truncate">{r.label}</span> },
          {
            key: "r",
            header: "LAST READ",
            width: "date",
            cell: (r) =>
              r.readAt ? (
                <span title={istDateTime(r.readAt)}>{shortDate(r.readAt)}</span>
              ) : (
                <span className="muted">not read</span>
              ),
          },
          {
            key: "d",
            header: "DETAIL",
            width: "md",
            priority: 2,
            cell: (r) => <span className="dim truncate">{r.detail}</span>,
            title: (r) => r.detail,
          },
        ]}
      />
    </Pane>
  );
}

export function InflView({ symbol }: { symbol: string }) {
  return (
    <div className="grid grid-infl">
      <Suspense fallback={<PaneSkeleton id="board" title="BOARD & PROMOTERS" area="board" />}>
        <BoardPane symbol={symbol} />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="related" title="RELATED ENTITIES" area="related" />}>
        <RelatedPane symbol={symbol} />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="feed" title="CHANGE FEED" area="feed" />}>
        <ChangeFeedPane symbol={symbol} />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="political" title="POLITICAL LINKS" area="political" />}>
        <PoliticalPane symbol={symbol} />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="policy" title="POLICY EVENTS" area="policy" />}>
        <PolicyPane symbol={symbol} />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="infl-coverage" title="COVERAGE" area="coverage" />}>
        <InflCoveragePane symbol={symbol} />
      </Suspense>
    </div>
  );
}
