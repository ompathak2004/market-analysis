import {
  type Conversation,
  defineTool,
  LTCG_EXEMPTION,
  RATE_WINDOWS,
  TAX_ASSUMPTIONS,
  TAX_RULES_VERSION,
  type ToolContext,
} from "@ma/agent";
import type { Evidence } from "@ma/intel";
import { z } from "zod";
import type { AppContext } from "../context";
import {
  companyBrief,
  companyCalls,
  financials,
  findCompany,
  keyStats,
  latestSignals,
  marketBrief,
  priceSnapshot,
} from "../queries";
import { lookupCompanies, marketFilings, policyEventsFor } from "../queries/bot";
import { ChartBuilder, r2, toneOf } from "./charts";

const symbol = z.string().describe("NSE symbol, e.g. BEL");

function remapEvidence(value: unknown, ids: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => remapEvidence(v, ids));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        k === "evidence" && Array.isArray(v)
          ? v.map((id) => ids.get(String(id))).filter(Boolean)
          : remapEvidence(v, ids),
      ]),
    );
  }
  return value;
}

function citeEvidence(
  ctx: ToolContext,
  evidence: readonly Evidence[],
  prefix: string,
): Map<string, string> {
  const ids = new Map<string, string>();
  for (const e of evidence.slice(0, 20)) {
    ids.set(
      e.id,
      ctx.cite({
        kind:
          e.kind === "broker_pdf"
            ? "research"
            : e.kind === "filing" || e.kind === "announcement"
              ? "filing"
              : "insight",
        label: `${prefix}: ${e.label}`.slice(0, 160),
        url: e.url,
        publishedAt: null,
        ref: e.id,
      }),
    );
  }
  return ids;
}

export function researchTools(app: AppContext, conversation: Conversation) {
  const lookup = defineTool({
    name: "company_lookup",
    description:
      "Resolve a company name or partial symbol to NSE symbols in our universe. Use before company tools when the symbol is uncertain.",
    input: z.object({ query: z.string().describe("Name or symbol fragment") }),
    timeoutMs: 4_000,
    async run(input) {
      const hits = await lookupCompanies(app, input.query);
      return {
        summary: hits.length
          ? `matches: ${hits.map((h) => h.symbol).join(", ")}`
          : "no match in universe",
        freshness: null,
        charts: [],
        data: { matches: hits.map((h) => ({ ...h, marketCapCr: r2(h.marketCapCr) })) },
      };
    },
  });

  const snapshot = defineTool({
    name: "company_snapshot",
    description:
      "One company: price, valuation and profitability ratios, growth, our proprietary signals, and the latest AI company brief (verdict, thesis, risks, catalysts with filing evidence). Use for 'explain its valuation', 'major risks', comparisons (call once per company).",
    input: z.object({ symbol }),
    timeoutMs: 9_000,
    async run(input, ctx) {
      const co = await findCompany(app, input.symbol);
      const sym = co.nseSymbol ?? input.symbol.toUpperCase();
      const [stats, brief, sigs] = await Promise.all([
        keyStats(app, sym),
        companyBrief(app, sym).catch(() => null),
        latestSignals(app, co.id),
      ]);
      const ids = brief ? citeEvidence(ctx, brief.evidence, sym) : new Map<string, string>();
      const statSrc = ctx.cite({
        kind: "dataset",
        label: `${sym} fundamentals (Screener/NSE, ₹ Cr) and quote`,
        url: null,
        publishedAt: stats.latestQuarter,
        ref: `fundamentals:${co.id}`,
      });
      const c = new ChartBuilder(ctx.callId);
      return {
        summary: `${stats.symbol} ${stats.name}: price ${r2(stats.price)}, P/E ${r2(stats.peTtm)}, ROE ${r2(stats.roePct)}%${brief?.brief ? `, brief verdict ${brief.brief.verdict.label}` : ""}`,
        freshness: stats.latestQuarter,
        charts: [
          c.kpis(
            {
              title: `${stats.symbol} key stats`,
              asOf: stats.latestQuarter,
              source: "Fundamentals + quote",
            },
            [
              { label: "Price", value: r2(stats.price), format: "inr" },
              {
                label: "Day %",
                value: r2(stats.changePct),
                format: "pct",
                tone: toneOf(stats.changePct),
              },
              { label: "Mkt cap Cr", value: r2(stats.marketCapCr), format: "num" },
              { label: "P/E TTM", value: r2(stats.peTtm), format: "num" },
              { label: "P/B", value: r2(stats.pb), format: "num" },
              { label: "ROE %", value: r2(stats.roePct), format: "pct" },
              {
                label: "Rev growth %",
                value: r2(stats.revenueGrowthPct),
                format: "pct",
                tone: toneOf(stats.revenueGrowthPct),
              },
              { label: "D/E", value: r2(stats.debtToEquity), format: "num" },
            ],
          ),
        ],
        data: {
          sourceId: statSrc,
          stats: Object.fromEntries(
            Object.entries(stats).map(([k, v]) => [k, typeof v === "number" ? r2(v) : v]),
          ),
          signals: (sigs ?? []).map((x) => ({
            kind: x.kind,
            value: r2(x.value),
            asOf: x.asOf,
            modelVersion: x.modelVersion,
          })),
          brief: brief?.brief
            ? {
                generatedAt: brief.meta?.generatedAt ?? null,
                stale: brief.meta?.stale ?? null,
                nature:
                  "AI-generated research brief grounded in cited filings; an interpretation, not a fact",
                ...(remapEvidence(brief.brief, ids) as Record<string, unknown>),
              }
            : null,
        },
      };
    },
  });

  const fin = defineTool({
    name: "company_financials",
    description:
      "Revenue, operating profit, net income, margins and growth for one company from stored statements (₹ Cr), annual or the last 12 quarters. Use to plot financial performance or summarize results.",
    input: z.object({ symbol, period: z.enum(["annual", "quarterly"]) }),
    timeoutMs: 6_000,
    async run(input, ctx) {
      const co = await findCompany(app, input.symbol);
      const sym = co.nseSymbol ?? input.symbol.toUpperCase();
      const f = (await financials(app, sym)) ?? { annual: [], quarterly: [] };
      const rows = (input.period === "annual" ? f.annual.slice(-8) : f.quarterly).map((r) => {
        const rev = r.revenue == null ? null : Number(r.revenue);
        const op = r.operatingProfit == null ? null : Number(r.operatingProfit);
        const ni = r.netIncome == null ? null : Number(r.netIncome);
        return {
          periodEnd: String(r.periodEnd).slice(0, 10),
          revenueCr: r2(rev),
          operatingProfitCr: r2(op),
          netIncomeCr: r2(ni),
          opmPct: rev && op != null ? r2((op / rev) * 100) : null,
          npmPct: rev && ni != null ? r2((ni / rev) * 100) : null,
        };
      });
      const withGrowth = rows.map((r, i) => {
        const prev = input.period === "annual" ? rows[i - 1] : rows[i - 4];
        return {
          ...r,
          revenueGrowthPct:
            prev?.revenueCr && r.revenueCr != null
              ? r2((r.revenueCr / prev.revenueCr - 1) * 100)
              : null,
          netIncomeGrowthPct:
            prev?.netIncomeCr && r.netIncomeCr != null && prev.netIncomeCr > 0
              ? r2((r.netIncomeCr / prev.netIncomeCr - 1) * 100)
              : null,
        };
      });
      const src = ctx.cite({
        kind: "dataset",
        label: `${sym} ${input.period} statements (₹ Cr)`,
        url: null,
        publishedAt: rows.at(-1)?.periodEnd ?? null,
        ref: `fundamentals:${co.id}`,
      });
      const c = new ChartBuilder(ctx.callId);
      const charts = rows.length
        ? [
            c.bar(
              {
                title: `${sym} revenue and net income (₹ Cr, ${input.period})`,
                asOf: rows.at(-1)?.periodEnd ?? null,
                source: "Stored financial statements",
              },
              "num",
              rows.map((r) => ({
                label: r.periodEnd.slice(0, 7),
                value: r.revenueCr ?? 0,
                compare: r.netIncomeCr,
                tone: "accent" as const,
              })),
              "Net income",
            ),
          ]
        : [];
      return {
        summary: rows.length
          ? `${rows.length} ${input.period} periods, latest ${rows.at(-1)?.periodEnd}`
          : "no statements stored",
        freshness: rows.at(-1)?.periodEnd ?? null,
        charts,
        data: {
          symbol: sym,
          period: input.period,
          sourceId: src,
          rows: withGrowth,
          growthBasis: input.period === "annual" ? "year on year" : "same quarter last year",
        },
      };
    },
  });

  const prices = defineTool({
    name: "company_prices",
    description:
      "Daily closes for one company over a range with period return, high/low and data-quality flags. Use for 'plot the share price' or 'how has X moved'.",
    input: z.object({ symbol, range: z.enum(["1mo", "3mo", "6mo", "1y", "2y"]) }),
    timeoutMs: 6_000,
    async run(input, ctx) {
      const co = await findCompany(app, input.symbol);
      const sym = co.nseSymbol ?? input.symbol.toUpperCase();
      const snap = await priceSnapshot(app, sym, input.range);
      const bars = (snap?.bars ?? []).filter((b) => b.final);
      const first = bars[0];
      const last = bars.at(-1);
      const closes = bars.map((b) => Number(b.close));
      const src = ctx.cite({
        kind: "dataset",
        label: `${sym} NSE closes, final through ${snap?.meta.finalThrough ?? "n/a"}`,
        url: null,
        publishedAt: snap?.meta.finalThrough ?? null,
        ref: `prices:${co.id}`,
      });
      const c = new ChartBuilder(ctx.callId);
      return {
        summary:
          first && last
            ? `${sym} ${first.date}→${last.date}: ${r2((Number(last.close) / Number(first.close) - 1) * 100)}%`
            : "no price history",
        freshness: snap?.meta.finalThrough ?? null,
        charts:
          bars.length >= 2
            ? [
                c.line(
                  {
                    title: `${sym} close`,
                    asOf: last?.date ?? null,
                    source: "NSE closes, split-adjusted",
                  },
                  "inr",
                  [
                    {
                      name: sym,
                      points: bars.map((b) => ({ x: b.date, y: Number(b.close) })),
                    },
                  ],
                ),
              ]
            : [],
        data: {
          symbol: sym,
          sourceId: src,
          from: first?.date ?? null,
          to: last?.date ?? null,
          sessions: bars.length,
          returnPct:
            first && last ? r2((Number(last.close) / Number(first.close) - 1) * 100) : null,
          high: closes.length ? r2(Math.max(...closes)) : null,
          low: closes.length ? r2(Math.min(...closes)) : null,
          last: r2(last ? Number(last.close) : null),
          quality: snap?.meta.quality ?? null,
          openGaps: snap?.meta.openGaps ?? 0,
          historyNote:
            bars.length &&
            first &&
            first.date > new Date(Date.now() - 300 * 86_400_000).toISOString().slice(0, 10) &&
            input.range.endsWith("y")
              ? "stored history is shorter than the requested range"
              : null,
        },
      };
    },
  });

  const broker = defineTool({
    name: "broker_research",
    description:
      "Recent broker calls for one company (rating, target, action, thesis) with the consensus target range. Use for consensus/analyst questions and to contrast with our proprietary signals.",
    input: z.object({ symbol }),
    timeoutMs: 6_000,
    async run(input, ctx) {
      const co = await findCompany(app, input.symbol);
      const sym = co.nseSymbol ?? input.symbol.toUpperCase();
      const r = await companyCalls(app, sym);
      const calls = r.calls.slice(0, 10).map((x) => ({
        broker: x.broker,
        date: x.publishedAt.slice(0, 10),
        action: x.action,
        rating: x.rating,
        targetPrice: r2(x.targetPrice),
        priorTargetPrice: r2(x.priorTargetPrice),
        thesis: x.thesis
          ? JSON.stringify(x.thesis).slice(0, 300)
          : (x.summary?.slice(0, 200) ?? null),
        sourceId: ctx.cite({
          kind: "research",
          label: `${x.broker} on ${sym} (${x.publishedAt.slice(0, 10)})`,
          url: x.reportUrl,
          publishedAt: x.publishedAt,
          ref: `call:${x.id}`,
        }),
      }));
      const targets = calls
        .map((x) => x.targetPrice)
        .filter((t): t is number => t != null && t > 0);
      const c = new ChartBuilder(ctx.callId);
      return {
        summary: `${calls.length} recent broker calls; targets ${targets.length ? `${Math.min(...targets)}–${Math.max(...targets)}` : "n/a"} vs price ${r2(r.price)}`,
        freshness: calls[0]?.date ?? null,
        charts: targets.length
          ? [
              c.bar(
                {
                  title: `${sym} broker targets vs price ${r2(r.price) ?? "n/a"}`,
                  asOf: calls[0]?.date ?? null,
                  source: "Moneycontrol broker research",
                },
                "inr",
                calls
                  .filter((x) => x.targetPrice)
                  .map((x) => ({
                    label: `${x.broker.slice(0, 18)} ${x.date.slice(5)}`,
                    value: x.targetPrice as number,
                    tone: "accent" as const,
                  })),
              ),
            ]
          : [],
        data: {
          symbol: sym,
          price: r2(r.price),
          calls,
          nature: "broker opinions (consensus), not our view",
        },
      };
    },
  });

  const news = defineTool({
    name: "market_news",
    description:
      "Market-wide recent material NSE filings (LLM-triaged high/medium) and government policy events (PIB/PRS), optionally filtered by keyword, plus the latest AI market brief. Use for 'today's RBI announcement', tariffs, sector news. Our news coverage is filings and official releases, not a newswire.",
    input: z.object({
      query: z.string().nullable().describe("Keyword filter or null"),
      days: z.number().int().min(1).max(14),
    }),
    timeoutMs: 9_000,
    async run(input, ctx) {
      const q = input.query?.trim() || null;
      const [filings, policy, brief] = await Promise.all([
        marketFilings(app, input.days, q),
        policyEventsFor(app, null, input.days, q),
        q ? Promise.resolve(null) : marketBrief(app).catch(() => null),
      ]);
      const c = new ChartBuilder(ctx.callId);
      const items = [
        ...filings.slice(0, 12).map((f) => ({
          date: f.publishedAt,
          label: `${f.symbol}: ${f.soWhat ?? f.subject}`,
          tag: f.category,
          tone: f.materiality === "high" ? ("neg" as const) : ("warn" as const),
          sourceId: ctx.cite({
            kind: "filing",
            label: `${f.symbol}: ${f.subject}`.slice(0, 160),
            url: f.url,
            publishedAt: f.publishedAt,
            ref: `announcement:${f.id}`,
          }),
        })),
        ...policy.slice(0, 10).map((e) => ({
          date: e.publishedAt,
          label: `${e.ministry ?? "Govt"}: ${e.title}`,
          tag: e.sectors[0] ?? "policy",
          tone: null,
          sourceId: ctx.cite({
            kind: "policy",
            label: e.title.slice(0, 160),
            url: e.url,
            publishedAt: e.publishedAt,
            ref: `policy:${e.id}`,
          }),
        })),
      ].sort((a, b) => b.date.localeCompare(a.date));
      const ids = brief?.brief
        ? citeEvidence(ctx, brief.evidence, "Market brief")
        : new Map<string, string>();
      return {
        summary: `${filings.length} material filings, ${policy.length} policy events${q ? ` matching "${q}"` : ""}`,
        freshness: items[0]?.date ?? null,
        charts: items.length
          ? [
              c.timeline(
                {
                  title: q ? `News matching "${q}"` : "Material market events",
                  asOf: items[0]?.date.slice(0, 10) ?? null,
                  source: "NSE filings (triaged), PIB/PRS",
                },
                items.map((i) => ({
                  ...i,
                  date: i.date.slice(0, 10),
                  label: i.label.slice(0, 200),
                })),
              ),
            ]
          : [],
        data: {
          query: q,
          events: items.map((i) => ({
            date: i.date,
            event: i.label.slice(0, 220),
            tag: i.tag,
            sourceId: i.sourceId,
          })),
          marketBrief: brief?.brief
            ? {
                generatedAt: brief.meta?.generatedAt,
                stale: brief.meta?.stale,
                ...(remapEvidence(brief.brief, ids) as Record<string, unknown>),
              }
            : null,
          coverage:
            "NSE corporate filings with LLM triage and PIB/PRS releases. RBI, SEBI and foreign news are covered only when they appear in these sources.",
        },
      };
    },
  });

  const taxRules = defineTool({
    name: "tax_rules",
    description:
      "The versioned Indian capital-gains rules this assistant uses (rates by transfer date, sections, exemption, holding period, grandfathering, assumptions) for explanation questions like STCG vs LTCG.",
    input: z.object({
      topic: z.enum(["overview", "grandfathering", "holding_period", "assumptions"]),
    }),
    timeoutMs: 2_000,
    async run(input, ctx) {
      const ids = RATE_WINDOWS.flatMap((w) => w.sources)
        .filter((u, i, a) => a.indexOf(u) === i)
        .map((url) =>
          ctx.cite({
            kind: "statute",
            label: `Income Tax Department: ${url.split("/").pop()}`,
            url,
            publishedAt: null,
            ref: url,
          }),
        );
      return {
        summary: `rules v${TAX_RULES_VERSION}, ${RATE_WINDOWS.length} rate windows`,
        freshness: TAX_RULES_VERSION,
        charts: [],
        data: {
          topic: input.topic,
          rulesVersion: TAX_RULES_VERSION,
          sourceIds: ids,
          windows: RATE_WINDOWS.map((w) => ({
            transfersFrom: w.from,
            transfersTo: w.to,
            act: w.act,
            stcg: `${w.stcgSection} ${w.stcgRate * 100}%`,
            ltcg: `${w.ltcgSection} ${w.ltcgRate * 100}%`,
          })),
          ltcgExemption: LTCG_EXEMPTION.map((e) => ({
            fromYearStarting: e.fromYearStart,
            amountInr: e.amount,
          })),
          holdingPeriod:
            "Listed equity shares and equity-oriented fund units are long-term when held more than 12 months.",
          grandfathering:
            "For listed equity acquired before 1 Feb 2018, cost is the higher of actual cost and the lower of the 31 Jan 2018 fair market value (highest quoted price that day) and the sale value; it can reduce a gain but not create a loss.",
          sttCondition:
            "Concessional rates need STT on acquisition and transfer for shares, and on transfer for equity-oriented fund units.",
          assumptions: TAX_ASSUMPTIONS,
          notCovered: [
            "debt funds and other asset classes",
            "non-residents",
            "surcharge by income slab",
            "basic-exemption shortfall adjustment",
            "buy-back taxation",
          ],
        },
      };
    },
  });

  const recall = defineTool({
    name: "conversation_recall",
    description:
      "Read an earlier turn of this conversation in full by its turn id (listed in the compacted history). Use only when the compacted note is not enough.",
    input: z.object({ turnId: z.string() }),
    timeoutMs: 1_000,
    async run(input) {
      const t = conversation.turns.find((x) => x.id === input.turnId);
      if (!t) throw new Error(`no turn ${input.turnId} in this conversation`);
      return {
        summary: `turn ${t.id} from ${t.at}`,
        freshness: t.at,
        charts: [],
        data: {
          id: t.id,
          at: t.at,
          portfolioId: t.portfolioId,
          user: t.user,
          assistant: t.assistant.slice(0, 4_000),
          tools: t.tools,
          sources: t.citations.map((c) => c.label),
        },
      };
    },
  });

  return [lookup, snapshot, fin, prices, broker, news, taxRules, recall];
}
