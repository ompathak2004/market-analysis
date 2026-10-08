import type { Evidence } from "@ma/intel";
import { Suspense } from "react";
import { DataTable } from "@/components/ui/data-table";
import { Empty } from "@/components/ui/empty";
import { Pane, PaneSkeleton } from "@/components/ui/pane";
import { Timeline, type TimelineItem } from "@/components/ui/timeline";
import { clampText, num } from "@/lib/format";
import { getContext } from "@/server/context";
import { companyAnnouncements } from "@/server/queries";
import { companyBrief, companyResearch } from "@/server/queries/ui";
import { attempt, PaneError } from "../shared";
import { BriefPane } from "./brief";

const EVIDENCE_KIND: Record<Evidence["kind"], string> = {
  filing: "FILING",
  broker_pdf: "BROKER",
  announcement: "ANN",
  concall: "CONCALL",
  source: "SOURCE",
  altdata: "ALT",
};

const CALL_TONE: Record<string, TimelineItem["tone"]> = {
  upgrade: "pos",
  raise_target: "pos",
  initiate: "accent",
  downgrade: "neg",
  lower_target: "neg",
};

export async function ChangesPane({ symbol }: { symbol: string }) {
  const ctx = getContext();
  const base = `/c/${encodeURIComponent(symbol)}`;
  const [brief, anns, research] = await Promise.all([
    attempt(companyBrief(ctx, symbol)),
    attempt(companyAnnouncements(ctx, symbol, 80)),
    attempt(companyResearch(ctx, symbol)),
  ]);
  if (!anns.ok && !research.ok)
    return <PaneError id="changes" title="WHAT CHANGED" area="changes" code={anns.code} />;
  const view = brief.ok ? brief.data : null;
  const items: Array<TimelineItem & { t: number }> = [];
  if (anns.ok)
    for (const a of anns.data ?? []) {
      if (a.materiality !== "high" && a.materiality !== "medium") continue;
      const at = new Date(a.publishedAt).toISOString();
      items.push({
        key: `a${a.id}`,
        at,
        t: Date.parse(at),
        tone: a.materiality === "high" ? "warn" : "neu",
        href: `${base}/news?a=${a.id}`,
        body: (
          <>
            <span className="muted">ANN</span> {clampText(a.soWhat ?? a.subject, 120)}
          </>
        ),
      });
    }
  if (research.ok)
    for (const c of research.data.calls) {
      if (c.action === "maintain" || c.action === "reiterate") continue;
      items.push({
        key: `c${c.id}`,
        at: c.publishedAt,
        t: Date.parse(c.publishedAt),
        tone: CALL_TONE[c.action] ?? "neu",
        href: `${base}/anr`,
        body: (
          <>
            <span className="muted">BROKER</span> {c.broker} {c.action.replace("_", " ")} ·{" "}
            {c.rating}
            {c.targetPrice ? ` · TGT ${num(c.targetPrice, 0)}` : ""}
          </>
        ),
      });
    }
  items.sort((a, b) => b.t - a.t);
  const shown = items.slice(0, 30).map(({ t: _t, ...rest }) => rest);
  return (
    <Pane
      id="changes"
      title="WHAT CHANGED"
      area="changes"
      meta={
        view?.previous
          ? `score ${view.previous.score} → ${view.brief.verdict.score}`
          : `${shown.length} material events`
      }
      foot={<output>material filings · rating and target changes</output>}
    >
      {view?.brief.whatChanged.length ? (
        <div className="pane-section">
          <h3>Since last brief</h3>
          <ul className="bullets">
            {view.brief.whatChanged.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {shown.length ? (
        <Timeline items={shown} />
      ) : (
        <Empty title="Nothing material">
          No high or medium materiality filings and no broker revisions on file.
        </Empty>
      )}
    </Pane>
  );
}

export async function EvidencePane({ symbol }: { symbol: string }) {
  const res = await attempt(companyBrief(getContext(), symbol));
  if (!res.ok) return <PaneError id="evidence" title="EVIDENCE" area="evidence" code={res.code} />;
  const ev = res.data?.evidence ?? [];
  return (
    <Pane
      id="evidence"
      title="EVIDENCE"
      area="evidence"
      meta={`${ev.length} sources`}
      hints="j/k sources · ↵ open source"
      foot={<output>every claim cites [eN] ids from this list</output>}
    >
      <DataTable<Evidence>
        label="Evidence used by the brief"
        rows={ev}
        rowKey={(e) => e.id}
        rowExternal={(e) => e.url}
        columns={[
          {
            key: "id",
            header: "ID",
            width: "sm",
            cell: (e) => <span className="muted">{e.id}</span>,
          },
          { key: "k", header: "KIND", width: "pct", cell: (e) => EVIDENCE_KIND[e.kind] ?? e.kind },
          {
            key: "l",
            header: "SOURCE",
            cell: (e) => <span className="truncate">{e.label}</span>,
            title: (e) => e.label,
          },
        ]}
        empty={
          <Empty title="No LLM evidence yet" hint="gpt-oss-120b · intel job">
            The rule-based read on the left uses fundamentals, prices, signals and broker calls
            directly. Cited evidence appears once the model brief for {symbol} is generated.
          </Empty>
        }
      />
    </Pane>
  );
}

export function IntlView({ symbol }: { symbol: string }) {
  return (
    <div className="grid grid-intl">
      <Suspense
        fallback={<PaneSkeleton id="thesis" title="INTELLIGENCE BRIEF" area="thesis" lines={16} />}
      >
        <BriefPane symbol={symbol} full area="thesis" />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="changes" title="WHAT CHANGED" area="changes" />}>
        <ChangesPane symbol={symbol} />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="evidence" title="EVIDENCE" area="evidence" />}>
        <EvidencePane symbol={symbol} />
      </Suspense>
    </div>
  );
}
