import type { MarketBrief } from "@ma/intel";
import { Callout, CalloutGroup } from "@/components/ui/callout";
import { Chip, Sym } from "@/components/ui/chip";
import { DataTable } from "@/components/ui/data-table";
import { Empty } from "@/components/ui/empty";
import { EvidenceRefs } from "@/components/ui/evidence";
import { Pane } from "@/components/ui/pane";
import { clampText, num, pct, shortDate } from "@/lib/format";
import { getContext } from "@/server/context";
import {
  type FeedItem,
  type FilingItem,
  intelligenceFeed,
  latestBrokerCalls,
  marketBrief,
  marketOverview,
  movers,
  recentFilings,
} from "@/server/queries";
import { asOf, attempt, modelFoot, PaneError, VerdictBadge } from "../shared";

interface RuleBullet {
  title: string;
  text: string;
  tone: "pos" | "neg" | "neu" | "warn";
}

async function ruleBrief(): Promise<{ headline: string; bullets: RuleBullet[]; inputs: number }> {
  const ctx = getContext();
  const [ov, mv, calls] = await Promise.all([
    marketOverview(ctx).catch(() => null),
    movers(ctx, 60).catch(() => null),
    latestBrokerCalls(ctx, 20).catch(() => []),
  ]);
  const idx = (s: string) => ov?.indices.find((i) => i.symbol === s) ?? null;
  const nifty = idx("^NSEI");
  const vix = idx("^INDIAVIX");
  const bank = idx("^NSEBANK");
  const it = idx("^CNXIT");
  const brent = idx("BZ=F");
  const inr = idx("USDINR=X");
  const all = mv?.gainers ?? [];
  const adv = all.filter((r) => r.changePct > 0).length;
  const dec = all.filter((r) => r.changePct < 0).length;
  const sorted = [...all].map((r) => r.changePct).sort((a, b) => a - b);
  const median = sorted.length ? (sorted[Math.floor(sorted.length / 2)] as number) : null;
  const bullets: RuleBullet[] = [];
  if (all.length)
    bullets.push({
      title: "Breadth",
      text: `${adv} of ${all.length} NIFTY 50 names advanced, ${dec} declined; median move ${pct(median)}.`,
      tone: adv > dec ? "pos" : adv < dec ? "neg" : "neu",
    });
  if (bank?.changePct != null || it?.changePct != null)
    bullets.push({
      title: "Rotation",
      text: `Banks ${pct(bank?.changePct)} vs IT ${pct(it?.changePct)}; ${
        (bank?.changePct ?? 0) >= (it?.changePct ?? 0) ? "domestic cyclicals" : "exporters"
      } led.`,
      tone: "neu",
    });
  const top = all[0];
  const bottom = all.at(-1);
  if (top && bottom)
    bullets.push({
      title: "Leaders",
      text: `${top.symbol} ${pct(top.changePct)} led; ${bottom.symbol} ${pct(bottom.changePct)} lagged.`,
      tone: "neu",
    });
  if (calls.length) {
    const ups = calls.filter((c) => c.action === "upgrade").length;
    const downs = calls.filter((c) => c.action === "downgrade").length;
    bullets.push({
      title: "Broker calls",
      text: `${calls.length} recent calls; ${ups} upgrades, ${downs} downgrades. Latest: ${calls[0]?.symbol} by ${calls[0]?.broker}.`,
      tone: ups > downs ? "pos" : downs > ups ? "neg" : "neu",
    });
  }
  if (vix?.price != null || brent?.changePct != null)
    bullets.push({
      title: "Risk flags",
      text: `INDIA VIX ${num(vix?.price)} (${pct(vix?.changePct)}); Brent ${pct(brent?.changePct)}; USD/INR ${num(inr?.price)}.`,
      tone: (vix?.changePct ?? 0) > 3 ? "warn" : "neu",
    });
  const headline =
    nifty?.changePct != null
      ? `NIFTY ${nifty.changePct >= 0 ? "up" : "down"} ${pct(Math.abs(nifty.changePct), 2, false)} at ${num(nifty.price)}; ${adv >= dec ? "breadth supportive" : "breadth narrow"}.`
      : "Market data is still loading.";
  return { headline, bullets, inputs: (ov?.indices.length ?? 0) + all.length + calls.length };
}

function LlmBrief({ brief }: { brief: MarketBrief }) {
  return (
    <>
      <div className="pane-section">
        <ol className="bullets">
          {brief.bullets.map((b, i) => (
            <li key={String(i)}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              <span>
                {b.text} <EvidenceRefs ids={b.evidence} />
              </span>
            </li>
          ))}
        </ol>
      </div>
      <CalloutGroup title="Read">
        <Callout title="Sector rotation" row={false}>
          {brief.sectorRotation}
        </Callout>
        <Callout title="Breadth" row={false}>
          {brief.breadth}
        </Callout>
        {brief.notableCalls.map((c, i) => (
          <Callout key={`n${String(i)}`} tone="info" title="Notable call" row={false}>
            {c}
          </Callout>
        ))}
        {brief.riskFlags.map((r, i) => (
          <Callout key={`r${String(i)}`} tone="warn" title="Risk flag" row={false}>
            {r}
          </Callout>
        ))}
      </CalloutGroup>
    </>
  );
}

export async function MarketBriefPane() {
  const res = await attempt(marketBrief(getContext()));
  if (!res.ok) return <PaneError id="brief" title="MARKET BRIEF" area="brief" code={res.code} />;
  const today = shortDate(new Date());
  if (res.data.brief && res.data.meta) {
    const { brief, meta } = res.data;
    return (
      <Pane
        id="brief"
        title="MARKET BRIEF"
        area="brief"
        meta={`${brief.bullets.length} points`}
        pad
        foot={
          <>
            <output>{modelFoot(meta)}</output>
            <span className="right">inputs {meta.inputs}</span>
          </>
        }
      >
        <div className="kicker">{shortDate(meta.generatedAt)} / market read</div>
        <h3 className="headline">{brief.headline}</h3>
        <LlmBrief brief={brief} />
      </Pane>
    );
  }
  const rule = await ruleBrief();
  return (
    <Pane
      id="brief"
      title="MARKET BRIEF"
      area="brief"
      meta="rule-based"
      pad
      foot={
        <>
          <output>rule-based read · LLM brief pending</output>
          <span className="right">inputs {rule.inputs}</span>
        </>
      }
    >
      <div className="kicker">{today} / rule-based read</div>
      <h3 className="headline">{rule.headline}</h3>
      {rule.bullets.length ? (
        <ol className="bullets">
          {rule.bullets.map((b, i) => (
            <li key={b.title}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              <span>
                <b className={b.tone === "neu" ? undefined : b.tone}>{b.title}.</b> {b.text}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <Empty title="Nothing to read yet">Quotes and closes have not loaded.</Empty>
      )}
      <p className="fallback-note" style={{ marginTop: 8 }}>
        The gpt-oss-120b market brief runs after the close; this read is computed from quotes and
        closes.
      </p>
    </Pane>
  );
}

export async function IntelligenceFeedPane() {
  const ctx = getContext();
  const res = await attempt(intelligenceFeed(ctx, 30));
  if (!res.ok) return <PaneError id="feed" title="INTELLIGENCE FEED" area="feed" code={res.code} />;
  const items = res.data;
  if (items.length)
    return (
      <Pane
        id="feed"
        title="INTELLIGENCE FEED"
        area="feed"
        meta={`${items.length} briefs`}
        foot={
          <>
            <output>company briefs · gpt-oss-120b</output>
            <span className="right">↵ INTL</span>
          </>
        }
      >
        <ul className="feed-list" data-rows>
          {items.map((f: FeedItem) => (
            <li key={f.symbol} data-row="" data-href={`/c/${encodeURIComponent(f.symbol)}/intl`}>
              <div>
                <Sym symbol={f.symbol} tab="intl" />
                <VerdictBadge label={f.verdict.label} score={f.verdict.score} />
                <span className="dim truncate">{f.sector}</span>
                <span className="right">{asOf(f.generatedAt)}</span>
              </div>
              <p className="clamp-2">{f.whatChanged}</p>
            </li>
          ))}
        </ul>
      </Pane>
    );
  const filings = await attempt(recentFilings(ctx, 40));
  const rows = filings.ok ? filings.data : [];
  return (
    <Pane
      id="feed"
      title="INTELLIGENCE FEED"
      area="feed"
      meta="filings"
      actions={<Chip active>FILINGS</Chip>}
      foot={
        <>
          <output>NSE corporate filings · last 30 days</output>
          <span className="right">briefs pending</span>
        </>
      }
    >
      <div className="pane-section">
        <p className="fallback-note">
          No company briefs yet. Showing the latest exchange filings until the intel job runs.
        </p>
      </div>
      <DataTable<FilingItem>
        label="Recent filings"
        rows={rows}
        rowKey={(r) => r.id}
        rowLink={(r) => `/c/${encodeURIComponent(r.symbol)}/news?a=${r.id}`}
        rowExternal={(r) => r.attachmentUrl}
        columns={[
          {
            key: "t",
            header: "TIME",
            width: "sm",
            cell: (r) => <span className="dim">{asOf(r.publishedAt).replace(" IST", "")}</span>,
            sortValue: (r) => r.publishedAt,
            sortable: true,
          },
          {
            key: "s",
            header: "SYMBOL",
            width: "sym",
            cell: (r) => <Sym symbol={r.symbol} tab="news" />,
          },
          {
            key: "subj",
            header: "SUBJECT",
            cell: (r) => <span className="truncate">{clampText(r.soWhat ?? r.subject, 160)}</span>,
            title: (r) => r.subject,
          },
        ]}
        empty={<Empty title="No filings">No exchange filings in the last 30 days.</Empty>}
      />
    </Pane>
  );
}
