import {
  type AgentTool,
  allocation,
  type CorporateActions,
  compareToBenchmark,
  concentration,
  DEMO_ASSUMPTIONS,
  DEMO_PORTFOLIOS,
  DEMO_PORTFOLIOS_VERSION,
  type DemoPortfolio,
  defineTool,
  demoPortfolio,
  drawdown,
  estimateGains,
  longTermFrom,
  movement,
  portfolioSymbols,
  type Quote,
  replay,
  type SecurityMeta,
  type Shock,
  scenario,
  TAX_RULES_VERSION,
  type TaxLotInput,
  type ToolContext,
  value as valuePortfolio,
  valueSeries,
  xirr,
} from "@ma/agent";
import { z } from "zod";
import type { AppContext } from "../context";
import { type BotMarket, botMarket, indexLevels } from "../queries/bot";
import { ChartBuilder, presentMoney, r2, toneOf } from "./charts";

export const PORTFOLIO_IDS = DEMO_PORTFOLIOS.map((p) => p.id) as [string, ...string[]];

const portfolioId = z
  .enum(PORTFOLIO_IDS)
  .nullable()
  .describe("Demo portfolio id; null means the portfolio selected in the UI");

export function resolvePortfolio(id: string | null, ctx: ToolContext): DemoPortfolio {
  const p = demoPortfolio(id ?? ctx.portfolioId ?? "");
  if (!p) throw new Error("no portfolio selected; ask the user to choose a demo portfolio");
  return p;
}

export interface PortfolioState {
  portfolio: DemoPortfolio;
  market: BotMarket;
  actions: CorporateActions;
  asOf: string;
  quotes: Map<string, Quote>;
  closes: Map<string, Quote[]>;
  meta: Map<string, SecurityMeta>;
}

export async function loadState(app: AppContext, p: DemoPortfolio): Promise<PortfolioState> {
  const first = p.transactions.reduce((m, t) => (t.date < m ? t.date : m), p.basisAsOf);
  const market = await botMarket(app, portfolioSymbols(p), first);
  const lastClose = market.securities.reduce<string | null>((m, s) => {
    const d = s.closes.at(-1)?.date ?? null;
    return d && (m == null || d > m) ? d : m;
  }, null);
  const asOf =
    [market.latestSession, lastClose]
      .filter((d): d is string => d != null)
      .sort()
      .at(-1) ?? new Date().toISOString().slice(0, 10);
  const closes = new Map<string, Quote[]>();
  const quotes = new Map<string, Quote>();
  const meta = new Map<string, SecurityMeta>();
  for (const s of market.securities) {
    const series = s.closes.filter((c) => c.date <= asOf);
    closes.set(s.symbol, series);
    const last = series.at(-1);
    if (last) quotes.set(s.symbol, last);
    meta.set(s.symbol, { name: s.name, sector: s.sector, industry: s.industry });
  }
  return {
    portfolio: p,
    market,
    actions: { splits: market.splits, dividends: market.dividends },
    asOf,
    quotes,
    closes,
    meta,
  };
}

const PRICE_SOURCE = "NSE end-of-day closes (split-adjusted) from the MA price store";

function citeData(ctx: ToolContext, s: PortfolioState): string {
  ctx.cite({
    kind: "dataset",
    label: `Synthetic demo ledger "${s.portfolio.name}" v${DEMO_PORTFOLIOS_VERSION}`,
    url: null,
    publishedAt: s.portfolio.basisAsOf,
    ref: `demo:${s.portfolio.id}`,
  });
  return ctx.cite({
    kind: "dataset",
    label: `${PRICE_SOURCE}, last session ${s.asOf}`,
    url: null,
    publishedAt: s.asOf,
    ref: "prices_daily",
  });
}

function warnings(s: PortfolioState, v: ReturnType<typeof valuePortfolio>): string[] {
  const out: string[] = [];
  if (v.missingPrices.length)
    out.push(`no price for ${v.missingPrices.join(", ")}; excluded from totals`);
  for (const h of v.holdings)
    if (h.stale)
      out.push(`${h.symbol} last close ${h.priceDate} is stale versus latest session ${s.asOf}`);
  if (s.market.dividendCoverageFrom)
    out.push(
      `dividends are counted only from ${s.market.dividendCoverageFrom} (corporate-action coverage start)`,
    );
  return out;
}

export function portfolioTools(app: AppContext) {
  const overview = defineTool({
    name: "portfolio_overview",
    description:
      "Current valuation of a demo portfolio: holdings, weights, invested capital, realized/unrealized P&L, dividends, sector allocation and concentration (HHI, top-N). Use for 'analyze my portfolio', allocation, exposure-to-sector and concentration questions.",
    input: z.object({ portfolioId }),
    timeoutMs: 8_000,
    async run(input, ctx) {
      const s = await loadState(app, resolvePortfolio(input.portfolioId, ctx));
      const ledger = replay(s.portfolio, s.asOf, s.actions);
      const v = valuePortfolio(ledger, s.quotes, s.meta, s.asOf);
      const sectors = allocation(v, "sector");
      const conc = concentration(v);
      const src = citeData(ctx, s);
      const c = new ChartBuilder(ctx.callId);
      const gainPct = v.netDeposits > 0 ? (v.totalGain / v.netDeposits) * 100 : null;
      const charts = [
        c.kpis({ title: s.portfolio.name, asOf: s.asOf, source: PRICE_SOURCE }, [
          { label: "Value", value: r2(v.totalValue), format: "inr" },
          { label: "Net deposits", value: r2(v.netDeposits), format: "inr" },
          { label: "Total gain", value: r2(v.totalGain), format: "inr", tone: toneOf(v.totalGain) },
          { label: "Total gain %", value: r2(gainPct), format: "pct", tone: toneOf(gainPct) },
          {
            label: "Unrealized",
            value: r2(v.unrealized),
            format: "inr",
            tone: toneOf(v.unrealized),
          },
          { label: "Realized", value: r2(v.realized), format: "inr", tone: toneOf(v.realized) },
          { label: "Cash", value: r2(v.cash), format: "inr" },
        ]),
        c.donut(
          {
            title: "Sector allocation",
            asOf: s.asOf,
            source: PRICE_SOURCE,
            notes: ["Weights of total value including cash"],
          },
          "inr",
          sectors.map((a) => ({ label: a.key, value: r2(a.value) ?? 0 })),
        ),
        c.table(
          { title: "Holdings", asOf: s.asOf, source: PRICE_SOURCE, notes: warnings(s, v) },
          [
            { key: "symbol", label: "Symbol", format: "text" },
            { key: "qty", label: "Qty", format: "qty" },
            { key: "avgCost", label: "Avg cost", format: "inr" },
            { key: "price", label: "Last", format: "inr" },
            { key: "value", label: "Value", format: "inr" },
            { key: "weight", label: "Weight", format: "pct" },
            { key: "pnlPct", label: "P&L %", format: "pct", tone: true },
          ],
          v.holdings.map((h) => ({
            symbol: h.symbol,
            qty: h.quantity,
            avgCost: r2(h.avgCost),
            price: r2(h.price),
            value: r2(h.value),
            weight: r2(h.weightPct),
            pnlPct: r2(h.unrealizedPct),
          })),
        ),
      ];
      return {
        summary: `${s.portfolio.name}: value ₹${Math.round(v.totalValue).toLocaleString("en-IN")} on ${s.asOf}, ${v.holdings.length} holdings, largest sector ${sectors.find((x) => x.key !== "Cash")?.key ?? "n/a"}`,
        freshness: s.asOf,
        charts,
        data: {
          portfolio: {
            id: s.portfolio.id,
            name: s.portfolio.name,
            benchmark: s.portfolio.benchmark,
            synthetic: true,
            thesis: s.portfolio.thesis,
          },
          asOf: s.asOf,
          sourceId: src,
          totals: {
            totalValue: r2(v.totalValue),
            marketValue: r2(v.marketValue),
            cash: r2(v.cash),
            investedInOpenLots: r2(v.invested),
            unrealized: r2(v.unrealized),
            realized: r2(v.realized),
            dividends: r2(v.dividends),
            netDeposits: r2(v.netDeposits),
            totalGain: r2(v.totalGain),
            totalGainPct: r2(gainPct),
          },
          holdings: v.holdings.map((h) => ({
            symbol: h.symbol,
            name: h.name,
            sector: h.sector,
            industry: h.industry,
            qty: h.quantity,
            avgCost: r2(h.avgCost),
            price: r2(h.price),
            priceDate: h.priceDate,
            value: r2(h.value),
            weightPct: r2(h.weightPct),
            unrealized: r2(h.unrealized),
            unrealizedPct: r2(h.unrealizedPct),
            since: h.firstAcquired,
          })),
          sectorWeightsPct: sectors.map((a) => ({
            sector: a.key,
            weightPct: r2(a.weightPct),
            symbols: a.symbols,
          })),
          concentration: conc && {
            hhi: r2(conc.hhi * 10_000),
            effectiveHoldings: r2(conc.effectiveHoldings),
            top1Pct: r2(conc.top1Pct),
            top3Pct: r2(conc.top3Pct),
            top5Pct: r2(conc.top5Pct),
            largestSector: conc.largestSector && {
              sector: conc.largestSector.sector,
              pctOfEquity: r2(conc.largestSector.weightPct),
            },
            basis: "weights of equity market value; HHI on a 0-10,000 scale",
          },
          warnings: warnings(s, v),
          assumptions: DEMO_ASSUMPTIONS,
        },
      };
    },
  });

  const performance = defineTool({
    name: "portfolio_performance",
    description:
      "Returns of a demo portfolio over a window: time-weighted return, P&L with per-holding contributions (what moved it), XIRR since inception, max drawdown and comparison with its benchmark index. Use for 'why is my portfolio down this week', returns, drawdown and benchmark questions.",
    input: z.object({
      portfolioId,
      window: z.enum(["1w", "1m", "3m", "since_inception"]).describe("Lookback window"),
    }),
    timeoutMs: 10_000,
    async run(input, ctx) {
      const s = await loadState(app, resolvePortfolio(input.portfolioId, ctx));
      const series = valueSeries(s.portfolio, s.actions, s.closes, s.asOf);
      const sessions = { "1w": 5, "1m": 21, "3m": 63, since_inception: Number.MAX_SAFE_INTEGER }[
        input.window
      ];
      const pts = series.points.slice(-Math.min(series.points.length, sessions + 1));
      const windowFrom = pts[0]?.date ?? null;
      const mv = movement(
        s.portfolio,
        s.actions,
        series,
        s.closes,
        Math.min(sessions, Math.max(0, series.points.length - 1)),
      );
      const ledger = replay(s.portfolio, s.asOf, s.actions);
      const v = valuePortfolio(ledger, s.quotes, s.meta, s.asOf);
      const irr = xirr([...ledger.flows, { date: s.asOf, amount: v.totalValue }]);
      const dd = drawdown(pts);
      const bench = windowFrom ? await indexLevels(app, s.portfolio.benchmark, windowFrom) : [];
      const cmp = compareToBenchmark(pts, s.portfolio.benchmark, bench);
      const src = citeData(ctx, s);
      const c = new ChartBuilder(ctx.callId);
      const notes: string[] = [];
      if (series.limitedBy.length)
        notes.push(
          `history starts ${series.start} because prices for ${series.limitedBy.join(", ")} begin later`,
        );
      if (cmp && cmp.sessions < pts.length)
        notes.push(
          `benchmark ${s.portfolio.benchmark} levels cover only ${cmp.sessions} of ${pts.length} sessions`,
        );
      if (mv?.tradedInWindow)
        notes.push("trades inside the window: contributions use end-of-window quantities");
      const charts = [
        cmp
          ? c.line(
              {
                title: `Portfolio vs ${cmp.benchmark} (rebased to 100)`,
                asOf: s.asOf,
                source: PRICE_SOURCE,
                notes,
              },
              "num",
              [
                {
                  name: "Portfolio (TWR)",
                  points: cmp.series.map((x) => ({ x: x.date, y: r2(x.portfolio) ?? 0 })),
                },
                {
                  name: cmp.benchmark,
                  points: cmp.series.map((x) => ({ x: x.date, y: r2(x.benchmark) ?? 0 })),
                },
              ],
            )
          : c.line({ title: "Portfolio value", asOf: s.asOf, source: PRICE_SOURCE, notes }, "inr", [
              { name: "Value", points: pts.map((x) => ({ x: x.date, y: r2(x.value) ?? 0 })) },
            ]),
        ...(mv
          ? [
              c.bar(
                {
                  title: `Contribution to P&L, ${mv.from} → ${mv.to}`,
                  asOf: s.asOf,
                  source: PRICE_SOURCE,
                },
                "inr",
                mv.contributions
                  .filter((x) => x.contribution != null)
                  .map((x) => ({ label: x.symbol, value: r2(x.contribution) ?? 0 })),
              ),
            ]
          : []),
      ];
      return {
        summary: mv
          ? `${input.window} return ${r2(mv.returnPct)}% (${mv.from}→${mv.to}), P&L ₹${Math.round(mv.pnl).toLocaleString("en-IN")}${cmp ? `; ${cmp.benchmark} ${r2(cmp.benchmarkReturnPct)}% over ${cmp.from}→${cmp.to}` : ""}`
          : "insufficient price history for this window",
        freshness: s.asOf,
        charts,
        data: {
          portfolioId: s.portfolio.id,
          sourceId: src,
          window: input.window,
          history: {
            start: series.start,
            sessions: series.points.length,
            forwardFilledPoints: series.forwardFilled,
            limitedBy: series.limitedBy,
          },
          windowReturn: mv && {
            from: mv.from,
            to: mv.to,
            twrPct: r2(mv.returnPct),
            pnl: r2(mv.pnl),
            netFlows: r2(mv.netFlows),
            startValue: r2(mv.startValue),
            endValue: r2(mv.endValue),
            contributions: mv.contributions.map((x) => ({
              symbol: x.symbol,
              changePct: r2(x.changePct),
              contribution: r2(x.contribution),
            })),
          },
          sinceInception: {
            xirrPct: irr == null ? null : r2(irr * 100),
            netDeposits: r2(v.netDeposits),
            totalValue: r2(v.totalValue),
            note: "XIRR uses deposits/withdrawals as cash flows and current value as the terminal flow",
          },
          drawdown: dd && {
            maxDrawdownPct: r2(dd.maxDrawdownPct),
            peak: dd.peakDate,
            trough: dd.troughDate,
            currentDrawdownPct: r2(dd.currentDrawdownPct),
            measuredOver: `${windowFrom} → ${s.asOf}`,
          },
          benchmark: cmp
            ? {
                index: cmp.benchmark,
                from: cmp.from,
                to: cmp.to,
                sessions: cmp.sessions,
                portfolioPct: r2(cmp.portfolioReturnPct),
                benchmarkPct: r2(cmp.benchmarkReturnPct),
                excessPct: r2(cmp.excessPct),
                basis:
                  "price-return index levels vs portfolio TWR including dividends credited as cash",
              }
            : {
                index: s.portfolio.benchmark,
                unavailable: "no overlapping index levels in this window",
              },
          notes,
        },
      };
    },
  });

  const scenarioTool = defineTool({
    name: "portfolio_scenario",
    description:
      "Deterministic what-if: apply percentage price shocks to a symbol, a sector, the largest holding or everything, and get the change in portfolio value. Use for 'what if my largest holding falls 15%' or 'banks drop 10%'. Shocks are hypothetical inputs, not forecasts.",
    input: z.object({
      portfolioId,
      shocks: z
        .array(
          z.object({
            target: z.enum(["symbol", "sector", "largest_holding", "all"]),
            value: z
              .string()
              .nullable()
              .describe("NSE symbol or sector name; null for largest_holding/all"),
            pct: z.number().min(-95).max(300).describe("Price change in percent, e.g. -15"),
          }),
        )
        .min(1)
        .max(6),
    }),
    timeoutMs: 8_000,
    async run(input, ctx) {
      const s = await loadState(app, resolvePortfolio(input.portfolioId, ctx));
      const v = valuePortfolio(replay(s.portfolio, s.asOf, s.actions), s.quotes, s.meta, s.asOf);
      const largest = v.holdings[0]?.symbol ?? null;
      const shocks: Shock[] = input.shocks.map((x) =>
        x.target === "largest_holding"
          ? { target: { kind: "symbol", value: largest }, pct: x.pct }
          : { target: { kind: x.target, value: x.value }, pct: x.pct },
      );
      const unmatched = shocks
        .filter((x) => x.target.kind !== "all")
        .filter(
          (x) =>
            !v.holdings.some((h) =>
              x.target.kind === "symbol"
                ? h.symbol === x.target.value?.toUpperCase()
                : h.sector.toLowerCase() === x.target.value?.toLowerCase(),
            ),
        )
        .map((x) => `${x.target.kind}:${x.target.value}`);
      const r = scenario(v, shocks);
      const src = citeData(ctx, s);
      const c = new ChartBuilder(ctx.callId);
      const hit = r.holdings.filter((h) => h.shockPct !== 0);
      return {
        summary: `scenario changes value by ₹${Math.round(r.change).toLocaleString("en-IN")} (${r2(r.changePct)}%)`,
        freshness: s.asOf,
        charts: [
          c.bar(
            {
              title: "Scenario impact by holding (₹)",
              asOf: s.asOf,
              source: "Deterministic shock on last close",
              notes: ["Hypothetical shock, not a forecast"],
            },
            "inr",
            (hit.length ? hit : r.holdings).map((h) => ({
              label: h.symbol,
              value: r2(h.after - h.before) ?? 0,
            })),
          ),
        ],
        data: {
          portfolioId: s.portfolio.id,
          sourceId: src,
          asOf: s.asOf,
          largestHolding: largest,
          before: r2(r.before),
          after: r2(r.after),
          change: r2(r.change),
          changePct: r2(r.changePct),
          affected: hit.map((h) => ({
            symbol: h.symbol,
            sector: h.sector,
            shockPct: h.shockPct,
            change: r2(h.after - h.before),
          })),
          unmatchedShocks: unmatched,
          unpriced: r.unpriced,
          sectors: [...new Set(v.holdings.map((h) => h.sector))],
          nature: "scenario analysis on a static portfolio; no second-order or correlation effects",
        },
      };
    },
  });

  const tax = defineTool({
    name: "portfolio_tax",
    description:
      "Indian capital-gains estimate for a demo portfolio from versioned, date-aware rules: realized gains already booked, gains if open lots were sold at the last close, or short-term lots compared with waiting until they turn long-term. Returns lot-level holding periods, sections, rates, exemption use and assumptions.",
    input: z.object({
      portfolioId,
      mode: z.enum(["realized", "if_sold_today", "wait_for_long_term"]),
      symbol: z.string().nullable().describe("Limit to one NSE symbol; null for all"),
    }),
    timeoutMs: 8_000,
    async run(input, ctx) {
      const s = await loadState(app, resolvePortfolio(input.portfolioId, ctx));
      const ledger = replay(s.portfolio, s.asOf, s.actions);
      const sym = input.symbol?.toUpperCase() ?? null;
      const lotInput = (
        l: { symbol: string; acquired: string; quantity: number; costPerShare: number },
        disposed: string,
        sale: number,
      ): TaxLotInput => ({
        symbol: l.symbol,
        assetClass: "listed_equity",
        acquired: l.acquired,
        disposed,
        quantity: l.quantity,
        costPerShare: l.costPerShare,
        salePerShare: sale,
        fmv2018PerShare: null,
      });
      const open = ledger.lots.filter((l) => !sym || l.symbol === sym);
      const unpriced = open.filter((l) => !s.quotes.has(l.symbol)).map((l) => l.symbol);
      const priced = open.filter((l) => s.quotes.has(l.symbol));
      let scenarios: Array<{ name: string; estimate: ReturnType<typeof estimateGains> }> = [];
      if (input.mode === "realized") {
        const lots = ledger.disposals
          .filter((d) => !sym || d.symbol === sym)
          .map((d) => lotInput(d, d.sold, d.pricePerShare));
        scenarios = [{ name: "realized", estimate: estimateGains(lots) }];
      } else if (input.mode === "if_sold_today") {
        scenarios = [
          {
            name: `sell on ${s.asOf} at last close`,
            estimate: estimateGains(
              priced.map((l) => lotInput(l, s.asOf, (s.quotes.get(l.symbol) as Quote).close)),
            ),
          },
        ];
      } else {
        const shortLots = priced.filter((l) => longTermFrom(l.acquired) > s.asOf);
        scenarios = [
          {
            name: `sell short-term lots on ${s.asOf}`,
            estimate: estimateGains(
              shortLots.map((l) => lotInput(l, s.asOf, (s.quotes.get(l.symbol) as Quote).close)),
            ),
          },
          {
            name: "sell each lot on its first long-term day at the same price",
            estimate: estimateGains(
              shortLots.map((l) =>
                lotInput(l, longTermFrom(l.acquired), (s.quotes.get(l.symbol) as Quote).close),
              ),
            ),
          },
        ];
      }
      const statute = ctx.cite({
        kind: "statute",
        label: `Capital gains rules v${TAX_RULES_VERSION}: Income-tax Act 2025 s.196/s.198, Income-tax Act 1961 s.111A/s.112A`,
        url: "https://www.incometaxindia.gov.in/w/section-198-78",
        publishedAt: null,
        ref: `tax-rules:${TAX_RULES_VERSION}`,
      });
      const src = citeData(ctx, s);
      const c = new ChartBuilder(ctx.callId);
      const first = scenarios[0]?.estimate;
      const charts = [
        c.table(
          {
            title: "Tax lots",
            asOf: s.asOf,
            source: `Rules v${TAX_RULES_VERSION}`,
            notes: ["Educational estimate; prices assumed unchanged for future sale dates"],
          },
          [
            { key: "symbol", label: "Symbol", format: "text" },
            { key: "acquired", label: "Bought", format: "date" },
            { key: "disposed", label: "Sold", format: "date" },
            { key: "term", label: "Term", format: "text" },
            { key: "ltFrom", label: "LT from", format: "date" },
            { key: "gain", label: "Gain", format: "inr", tone: true },
            { key: "rate", label: "Rate", format: "pct" },
          ],
          (first?.lots ?? []).map((l) => ({
            symbol: l.symbol,
            acquired: l.acquired,
            disposed: l.disposed,
            term: l.term === "long" ? "LTCG" : "STCG",
            ltFrom: l.longTermFrom,
            gain: r2(l.gain),
            rate: r2(l.rate * 100),
          })),
        ),
        ...(scenarios.length > 1
          ? [
              c.bar(
                {
                  title: "Estimated tax: sell now vs wait",
                  asOf: s.asOf,
                  source: `Rules v${TAX_RULES_VERSION}`,
                },
                "inr",
                scenarios.map((x) => ({
                  label: x.name.slice(0, 60),
                  value: r2(x.estimate.years.reduce((t, y) => t + y.total, 0)) ?? 0,
                  tone: "accent" as const,
                })),
              ),
            ]
          : []),
      ];
      return {
        summary: scenarios
          .map(
            (x) =>
              `${x.name}: tax ≈ ₹${Math.round(x.estimate.years.reduce((t, y) => t + y.total, 0)).toLocaleString("en-IN")}`,
          )
          .join("; "),
        freshness: s.asOf,
        charts,
        data: {
          portfolioId: s.portfolio.id,
          sourceIds: { rules: statute, prices: src },
          rulesVersion: TAX_RULES_VERSION,
          scenarios: scenarios.map((x) => ({
            name: x.name,
            exact: x.estimate.exact,
            missingInputs: x.estimate.missing,
            years: x.estimate.years.map((y) => ({
              year: y.year,
              stcg: r2(y.stcg),
              stcl: r2(y.stcl),
              ltcg: r2(y.ltcg),
              ltcl: r2(y.ltcl),
              exemptionUsed: r2(y.exemptionUsed),
              taxableShortTerm: r2(y.taxableShortTerm),
              taxableLongTerm: r2(y.taxableLongTerm),
              tax: r2(y.tax),
              cess: r2(y.cess),
              total: r2(y.total),
              sections: y.buckets.map((b) => `${b.section} @ ${b.rate * 100}%`),
            })),
            lots: x.estimate.lots.map((l) => ({
              symbol: l.symbol,
              acquired: l.acquired,
              disposed: l.disposed,
              qty: l.quantity,
              term: l.term,
              daysHeld: l.daysHeld,
              longTermFrom: l.longTermFrom,
              gain: r2(l.gain),
              section: l.section,
            })),
          })),
          unpricedSymbols: unpriced,
          assumptions: first?.assumptions ?? [],
          disclaimer: first?.disclaimer ?? "",
        },
      };
    },
  });

  return [overview, performance, scenarioTool, tax].map(
    (t): AgentTool => ({
      ...t,
      run: async (input, ctx) => {
        const out = await t.run(input, ctx);
        return { ...out, data: presentMoney(out.data) };
      },
    }),
  );
}
