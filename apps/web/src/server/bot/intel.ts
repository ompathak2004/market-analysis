import { defineTool, portfolioSymbols, replay, value as valuePortfolio } from "@ma/agent";
import { eventImpact } from "@ma/intel";
import { z } from "zod";
import type { AppContext } from "../context";
import { findCompany, supplyChain } from "../queries";
import {
  type BotFiling,
  type BotLink,
  botSignals,
  filingsFor,
  holdingLinks,
  marketFilings,
  policyEventsFor,
} from "../queries/bot";
import { ChartBuilder, r2 } from "./charts";
import { loadState, PORTFOLIO_IDS, resolvePortfolio } from "./portfolio";

const portfolioId = z
  .enum(PORTFOLIO_IDS)
  .nullable()
  .describe("Demo portfolio id; null means the portfolio selected in the UI");

const symbol = z.string().describe("NSE symbol, e.g. HAL");

const SIGNAL_NATURE: Record<string, string> = {
  distress_score: "model estimate: DuPont-feature logistic ordering score 0-1, not a probability",
  customer_momentum_1m: "model estimate: relationship-weighted 1m return of disclosed customers, %",
  customer_momentum_3m: "model estimate: relationship-weighted 3m return of disclosed customers, %",
  supplier_momentum_1m: "model estimate: relationship-weighted 1m return of disclosed suppliers, %",
  supplier_momentum_3m: "model estimate: relationship-weighted 3m return of disclosed suppliers, %",
  customer_hhi:
    "model estimate: HHI over customers with estimated rupee value (1 = single customer)",
  customer_concentration_pct: "disclosed: share of revenue from customers named in filings, %",
  top5_customers_pct: "disclosed: top-5 customer share of revenue, %",
  top10_customers_pct: "disclosed: top-10 customer share of revenue, %",
  travel_legs_7d: "observed: corporate aircraft flight legs in 7 days (ADS-B)",
  travel_counterparty_visit: "inference: aircraft landed near a counterparty site",
  travel_event_window: "inference: travel clustered around a corporate event",
  travel_operating_site_arrivals_30d:
    "observed: aircraft arrivals at known operating sites, 30 days",
  logistics_chokepoint_exposure:
    "model estimate: share of linked vessel activity through chokepoints",
  logistics_fleet_activity: "observed: owned-fleet AIS activity",
  logistics_arrivals_7d: "observed: linked vessel arrivals at company facilities, 7 days",
};

const MAT_TONE = { high: "neg", medium: "warn" } as const;

export function intelTools(app: AppContext) {
  const signals = defineTool({
    name: "portfolio_signals",
    description:
      "Our proprietary signals for every holding of a demo portfolio: distress score, customer/supplier momentum from the supply-chain graph, customer concentration, corporate-aircraft travel and vessel/logistics activity, each with as-of date, model version and nature (observed vs model estimate vs inference). Use for deteriorating momentum, distress, alt-data and 'what does our intelligence say' questions.",
    input: z.object({ portfolioId }),
    timeoutMs: 8_000,
    async run(input, ctx) {
      const p = resolvePortfolio(input.portfolioId, ctx);
      const symbols = portfolioSymbols(p);
      const rows = await botSignals(app, symbols);
      const src = ctx.cite({
        kind: "dataset",
        label: "MA graph and alt-data signals (active model versions)",
        url: null,
        publishedAt: rows.reduce<string | null>(
          (m, r) => (m == null || r.asOf > m ? r.asOf : m),
          null,
        ),
        ref: "signals",
      });
      const by = new Map<string, Record<string, number | string | null>>();
      for (const r of rows) {
        const row = by.get(r.symbol) ?? { symbol: r.symbol };
        row[r.kind] = r2(r.value);
        by.set(r.symbol, row);
      }
      const flags: string[] = [];
      for (const [sym, row] of by) {
        const m1 = row.customer_momentum_1m as number | undefined;
        const m3 = row.customer_momentum_3m as number | undefined;
        if (m1 != null && m1 < 0 && (m3 == null || m3 < 0))
          flags.push(`${sym}: customer momentum negative (1m ${m1}%)`);
        const d = row.distress_score as number | undefined;
        if (d != null && d >= 0.5)
          flags.push(`${sym}: distress score ${d} is in the upper half of the ordering`);
      }
      const c = new ChartBuilder(ctx.callId);
      const holdingsWithout = symbols.filter((s) => !by.has(s));
      return {
        summary: `${rows.length} signals across ${by.size}/${symbols.length} holdings; ${flags.length} flags`,
        freshness: rows.reduce<string | null>(
          (m, r) => (m == null || r.asOf > m ? r.asOf : m),
          null,
        ),
        charts: [
          c.table(
            {
              title: "Proprietary signals by holding",
              asOf: null,
              source: "MA signals",
              notes: ["Momentum in %, distress 0-1 ordering score; blank = no signal"],
            },
            [
              { key: "symbol", label: "Symbol", format: "text" },
              { key: "distress_score", label: "Distress", format: "num" },
              { key: "customer_momentum_1m", label: "Cust mom 1m", format: "pct", tone: true },
              { key: "supplier_momentum_1m", label: "Supp mom 1m", format: "pct", tone: true },
              { key: "customer_hhi", label: "Cust HHI", format: "num" },
              { key: "travel_legs_7d", label: "Jet legs 7d", format: "num" },
              { key: "logistics_chokepoint_exposure", label: "Chokepoint", format: "num" },
            ],
            [...by.values()].map((r) => ({
              symbol: r.symbol as string,
              distress_score: (r.distress_score as number) ?? null,
              customer_momentum_1m: (r.customer_momentum_1m as number) ?? null,
              supplier_momentum_1m: (r.supplier_momentum_1m as number) ?? null,
              customer_hhi: (r.customer_hhi as number) ?? null,
              travel_legs_7d: (r.travel_legs_7d as number) ?? null,
              logistics_chokepoint_exposure: (r.logistics_chokepoint_exposure as number) ?? null,
            })),
          ),
        ],
        data: {
          portfolioId: p.id,
          sourceId: src,
          signals: rows.map((r) => ({
            symbol: r.symbol,
            kind: r.kind,
            value: r2(r.value),
            asOf: r.asOf,
            modelVersion: r.modelVersion,
            nature: SIGNAL_NATURE[r.kind] ?? "model estimate",
            topContributors: Array.isArray(r.inputs.contributors)
              ? (r.inputs.contributors as Array<{ name?: string; momentum?: number }>)
                  .slice(0, 3)
                  .map((x) => ({ name: x.name, momentumPct: r2((x.momentum ?? 0) * 100) }))
              : undefined,
          })),
          flags,
          holdingsWithoutSignals: holdingsWithout,
          limitations: [
            "Graph signals cover only relationships disclosed in filings we have read; absence of a signal is not evidence of no exposure.",
            "Distress excludes banks, NBFCs and insurers by design.",
            "Momentum signals are research signals from the supply-chain literature, not calibrated forecasts.",
          ],
        },
      };
    },
  });

  const newsImpact = defineTool({
    name: "portfolio_news_impact",
    description:
      "News-to-portfolio impact map: recent material NSE filings and government policy events that touch holdings directly, their policy sectors, or their disclosed customers/suppliers (one hop in our supply-chain graph). Returns each channel with evidence ids, dates, observed price reaction since the event and an exposure estimate. Optional topic filters by keyword (e.g. 'tariff', 'RBI', 'defence order').",
    input: z.object({
      portfolioId,
      topic: z
        .string()
        .nullable()
        .describe("Keyword to filter events, or null for all material events"),
      days: z.number().int().min(1).max(30).describe("Lookback in days"),
    }),
    timeoutMs: 12_000,
    async run(input, ctx) {
      const s = await loadState(app, resolvePortfolio(input.portfolioId, ctx));
      const v = valuePortfolio(replay(s.portfolio, s.asOf, s.actions), s.quotes, s.meta, s.asOf);
      const holdings = v.holdings.map((h) => h.symbol);
      const weight = new Map(v.holdings.map((h) => [h.symbol, h.weightPct ?? 0]));
      const topic = input.topic?.trim() || null;
      const links = await holdingLinks(app, holdings);
      const cpSymbols = [
        ...new Set(
          links
            .map((l) => l.counterpartySymbol)
            .filter((x): x is string => !!x && !holdings.includes(x)),
        ),
      ];
      const [direct, linked, policy] = await Promise.all([
        filingsFor(app, holdings, input.days, topic),
        cpSymbols.length
          ? filingsFor(app, cpSymbols, input.days, topic)
          : Promise.resolve([] as BotFiling[]),
        policyEventsFor(app, holdings, input.days, topic),
      ]);
      const wider =
        topic && !direct.length && !linked.length && !policy.length
          ? {
              filings: await marketFilings(app, input.days, topic),
              policy: await policyEventsFor(app, null, input.days, topic),
            }
          : null;
      const citeFiling = (f: BotFiling) =>
        ctx.cite({
          kind: "filing",
          label: `${f.symbol}: ${f.subject}`.slice(0, 160),
          url: f.url,
          publishedAt: f.publishedAt,
          ref: `announcement:${f.id}`,
        });
      const reaction = (sym: string, at: string) => {
        const series = s.closes.get(sym) ?? [];
        const before = [...series].reverse().find((q) => q.date < at.slice(0, 10));
        const last = series.at(-1);
        return before && last && last.date > before.date
          ? r2((last.close / before.close - 1) * 100)
          : null;
      };
      type Channel = {
        holding: string;
        channel: "direct_filing" | "policy_sector" | "customer_event" | "supplier_event";
        event: string;
        date: string;
        sourceId: string;
        materiality: string | null;
        via: string | null;
        observedMovePct: number | null;
        exposurePctOfPortfolio: number | null;
        exposureBasis: string;
      };
      const channels: Channel[] = [];
      for (const f of direct) {
        channels.push({
          holding: f.symbol,
          channel: "direct_filing",
          event: f.soWhat ?? f.subject,
          date: f.publishedAt,
          sourceId: citeFiling(f),
          materiality: f.materiality,
          via: null,
          observedMovePct: reaction(f.symbol, f.publishedAt),
          exposurePctOfPortfolio: r2(weight.get(f.symbol) ?? null),
          exposureBasis: "observed: full holding weight",
        });
      }
      const linksByCp = new Map<string, BotLink[]>();
      for (const l of links)
        if (l.counterpartySymbol)
          linksByCp.set(l.counterpartySymbol, [...(linksByCp.get(l.counterpartySymbol) ?? []), l]);
      for (const f of linked) {
        for (const l of linksByCp.get(f.symbol) ?? []) {
          const share = l.side === "customer" ? l.holdingRevenuePct : null;
          channels.push({
            holding: l.holding,
            channel: l.side === "customer" ? "customer_event" : "supplier_event",
            event: f.soWhat ?? f.subject,
            date: f.publishedAt,
            sourceId: citeFiling(f),
            materiality: f.materiality,
            via: `${l.counterparty} is a disclosed ${l.side} of ${l.holding}${l.valueCr != null ? ` (est. ₹${r2(l.valueCr)} Cr/yr)` : ""}`,
            observedMovePct: reaction(l.holding, f.publishedAt),
            exposurePctOfPortfolio:
              share != null ? r2(((weight.get(l.holding) ?? 0) * share) / 100) : null,
            exposureBasis:
              share != null
                ? "model estimate: holding weight × estimated share of holding revenue from this customer"
                : "unquantified: link disclosed but no revenue share estimate",
          });
        }
      }
      for (const e of policy) {
        const id = ctx.cite({
          kind: "policy",
          label: `${e.ministry ?? "Government"}: ${e.title}`.slice(0, 160),
          url: e.url,
          publishedAt: e.publishedAt,
          ref: `policy:${e.id}`,
        });
        for (const h of e.symbols) {
          channels.push({
            holding: h,
            channel: "policy_sector",
            event: e.title,
            date: e.publishedAt,
            sourceId: id,
            materiality: null,
            via: `tagged to policy sector ${e.sectors.join(", ")}`,
            observedMovePct: reaction(h, e.publishedAt),
            exposurePctOfPortfolio: null,
            exposureBasis: "inference: sector tag only, magnitude unknown",
          });
        }
      }
      const linkCites = new Map<string, string>();
      for (const l of links)
        if (l.url && !linkCites.has(`${l.holding}|${l.counterparty}`))
          linkCites.set(
            `${l.holding}|${l.counterparty}`,
            ctx.cite({
              kind: "document",
              label: `Supply-chain evidence: ${l.holding} ↔ ${l.counterparty}`,
              url: l.url,
              publishedAt: l.lastDisclosedAt,
              ref: null,
            }),
          );
      const perHolding = holdings.map((h) => {
        const ch = channels.filter((c) => c.holding === h);
        const quantified = ch
          .map((c) => c.exposurePctOfPortfolio)
          .filter((x): x is number => x != null);
        return {
          holding: h,
          weightPct: r2(weight.get(h) ?? 0),
          channels: ch.length,
          maxQuantifiedExposurePct: quantified.length ? Math.max(...quantified) : null,
        };
      });
      const c = new ChartBuilder(ctx.callId);
      const touched = perHolding.filter((x) => x.channels > 0);
      const nodes = new Map<
        string,
        {
          id: string;
          label: string;
          role: "center" | "customer" | "supplier" | "holding" | "event";
        }
      >();
      const edges: Array<{
        from: string;
        to: string;
        label: string | null;
        weight: number | null;
      }> = [];
      nodes.set("portfolio", { id: "portfolio", label: s.portfolio.name, role: "center" });
      for (const ch of channels.slice(0, 30)) {
        nodes.set(ch.holding, { id: ch.holding, label: ch.holding, role: "holding" });
        edges.push({
          from: "portfolio",
          to: ch.holding,
          label: null,
          weight: weight.get(ch.holding) ?? null,
        });
        const evId = `ev:${ch.sourceId}`;
        nodes.set(evId, {
          id: evId,
          label: `${ch.sourceId} ${ch.event}`.slice(0, 80),
          role:
            ch.channel === "customer_event"
              ? "customer"
              : ch.channel === "supplier_event"
                ? "supplier"
                : "event",
        });
        edges.push({
          from: ch.holding,
          to: evId,
          label: ch.channel.replace("_", " "),
          weight: ch.exposurePctOfPortfolio,
        });
      }
      const charts = channels.length
        ? [
            c.network(
              {
                title: "Event exposure map",
                asOf: s.asOf,
                source: "NSE filings, PIB policy events, MA supply-chain graph",
                notes: ["Links show disclosed relationships, not proven causation"],
              },
              s.portfolio.name,
              [...nodes.values()],
              dedupe(edges),
            ),
            c.timeline(
              {
                title: "Events touching holdings",
                asOf: s.asOf,
                source: "NSE filings with triage; PIB",
              },
              channels
                .slice()
                .sort((a, b) => b.date.localeCompare(a.date))
                .map((ch) => ({
                  date: ch.date.slice(0, 10),
                  label: `${ch.holding} · ${ch.event}`.slice(0, 200),
                  tag: ch.channel.replace("_", " "),
                  tone:
                    ch.materiality === "high" || ch.materiality === "medium"
                      ? MAT_TONE[ch.materiality]
                      : null,
                  sourceId: ch.sourceId,
                })),
            ),
          ]
        : [];
      return {
        summary: `${channels.length} channels touching ${touched.length}/${holdings.length} holdings in ${input.days}d${topic ? ` for "${topic}"` : ""}`,
        freshness: s.asOf,
        charts,
        data: {
          portfolioId: s.portfolio.id,
          window: `${input.days} days to ${s.asOf}`,
          topic,
          channels: channels.slice(0, 40),
          perHolding,
          supplyChainLinksConsidered: links.length,
          linkEvidence: [...linkCites.entries()].map(([k, id]) => ({
            link: k.replace("|", " ↔ "),
            sourceId: id,
          })),
          unrelatedMatches: wider
            ? {
                note: "Events matched the topic but no holding is linked through filings, policy sectors or disclosed relationships.",
                filings: wider.filings.slice(0, 6).map((f) => ({
                  symbol: f.symbol,
                  subject: f.subject,
                  date: f.publishedAt,
                  sourceId: citeFiling(f),
                })),
                policy: wider.policy.slice(0, 6).map((e) => ({
                  title: e.title,
                  date: e.publishedAt,
                  sourceId: ctx.cite({
                    kind: "policy",
                    label: e.title.slice(0, 160),
                    url: e.url,
                    publishedAt: e.publishedAt,
                    ref: `policy:${e.id}`,
                  }),
                })),
              }
            : null,
          interpretation: [
            "direct_filing: observed event at the holding itself.",
            "customer_event/supplier_event: observed event at a disclosed counterparty; effect on the holding is an inference.",
            "policy_sector: government event tagged to the holding's policy sector; relevance is an inference.",
            "observedMovePct is the holding's close-to-close change since the event, which includes all other news; it is not attributable to the event.",
          ],
        },
      };
    },
  });

  const chain = defineTool({
    name: "supply_chain",
    description:
      "Disclosed customers and suppliers of one company from our SPLC graph, with relationship value estimates (₹ Cr/yr, share of revenue/cost), confidence and filing evidence. Use for 'who depends on this customer', supply-chain exposure between companies, and customer concentration.",
    input: z.object({ symbol, direction: z.enum(["customers", "suppliers", "both"]) }),
    timeoutMs: 8_000,
    async run(input, ctx) {
      const r = await supplyChain(app, input.symbol);
      const pick = (side: "customers" | "suppliers") =>
        (input.direction === side || input.direction === "both" ? r[side] : [])
          .slice(0, 15)
          .map((e) => {
            const ev = e.evidence[0];
            const sourceId = ev
              ? ctx.cite({
                  kind: "document",
                  label:
                    `${r.company.symbol} ${side === "customers" ? "customer" : "supplier"} ${e.counterparty.name}: ${ev.source}`.slice(
                      0,
                      160,
                    ),
                  url: ev.url,
                  publishedAt: ev.publishedAt,
                  ref: `observation:${ev.observationId}`,
                })
              : null;
            return {
              counterparty: e.counterparty.name,
              symbol: e.counterparty.symbol,
              kind: e.counterparty.kind,
              valueCr: r2(e.estimate?.valueCr),
              rangeCr: e.estimate ? [r2(e.estimate.lowCr), r2(e.estimate.highCr)] : null,
              supplierRevenuePct: r2(e.estimate?.supplierRevenuePct),
              customerCostPct: r2(e.estimate?.customerCostPct),
              estimateMethod: e.estimate?.method ?? null,
              disclosedPct: r2(e.disclosedPct),
              confidence: r2(e.confidence),
              lastDisclosedAt: e.lastDisclosedAt,
              quote: ev?.quote.slice(0, 160) ?? null,
              sourceId,
            };
          });
      const customers = pick("customers");
      const suppliers = pick("suppliers");
      const c = new ChartBuilder(ctx.callId);
      const nodes = [
        { id: r.company.symbol, label: r.company.symbol, role: "center" as const },
        ...customers.map((x) => ({
          id: `c:${x.counterparty}`,
          label: x.symbol ?? x.counterparty,
          role: "customer" as const,
        })),
        ...suppliers.map((x) => ({
          id: `s:${x.counterparty}`,
          label: x.symbol ?? x.counterparty,
          role: "supplier" as const,
        })),
      ];
      const edges = [
        ...customers.map((x) => ({
          from: r.company.symbol,
          to: `c:${x.counterparty}`,
          label: x.valueCr != null ? `₹${x.valueCr} Cr` : null,
          weight: x.valueCr,
        })),
        ...suppliers.map((x) => ({
          from: `s:${x.counterparty}`,
          to: r.company.symbol,
          label: x.valueCr != null ? `₹${x.valueCr} Cr` : null,
          weight: x.valueCr,
        })),
      ];
      return {
        summary: `${r.company.symbol}: ${r.totals.customers} customers, ${r.totals.suppliers} suppliers disclosed`,
        freshness: r.coverage.rebuiltAt,
        charts:
          nodes.length > 1
            ? [
                c.network(
                  {
                    title: `${r.company.symbol} supply chain`,
                    asOf: r.coverage.rebuiltAt,
                    source: "MA SPLC graph from filings",
                    notes: ["Values are model estimates unless disclosed"],
                  },
                  r.company.symbol,
                  nodes,
                  edges,
                ),
              ]
            : [],
        data: {
          symbol: r.company.symbol,
          totals: r.totals,
          customers,
          suppliers,
          coverage: {
            documentsRead: r.coverage.read,
            documentsAvailable: r.coverage.available,
            lastReadAt: r.coverage.lastReadAt,
          },
          signals: r.signals.map((x) => ({
            kind: x.kind,
            value: r2(x.value),
            asOf: x.asOf,
            nature: SIGNAL_NATURE[x.kind] ?? "model estimate",
          })),
          limitations: [
            "Only relationships disclosed in filings we have read; private and unnamed counterparties are under-covered.",
          ],
        },
      };
    },
  });

  const impact = defineTool({
    name: "event_impact",
    description:
      "Our event-impact regression (Dieselgate-style): for a shock company and date window, regress its disclosed suppliers' returns on DuPont features and distress, with and without supply-chain exposure. Reports whether exposure added explanatory power. Use for 'what does our event-impact model suggest'.",
    input: z.object({
      symbol,
      from: z.string().describe("Window start YYYY-MM-DD"),
      to: z.string().describe("Window end YYYY-MM-DD"),
    }),
    timeoutMs: 12_000,
    async run(input, ctx) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(input.from) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(input.to) ||
        input.from >= input.to
      )
        throw new Error("from/to must be YYYY-MM-DD with from < to");
      const co = await findCompany(app, input.symbol);
      const r = await app.api.getOrLoad(
        `event:${co.id}:${input.from}:${input.to}:0`,
        () => eventImpact(app.db, co.id, input.from, input.to, {}),
        { ttlMs: 30 * 60_000, staleMs: 6 * 3_600_000 },
      );
      if (!r) throw new Error("event impact unavailable");
      const k = r.withExposure?.coefficients.length ?? 0;
      const coef = r.exposureCoefficient;
      const t = r.withExposure && k ? r.withExposure.tStats[k - 1] : null;
      const src = ctx.cite({
        kind: "dataset",
        label: `MA event-impact OLS for ${co.nseSymbol} ${input.from}→${input.to}`,
        url: null,
        publishedAt: input.to,
        ref: "eventImpact",
      });
      const c = new ChartBuilder(ctx.callId);
      return {
        summary: `${r.observations.length} supplier observations (min ${r.minObservations}); exposure coefficient ${coef == null ? "n/a" : r2(coef)}`,
        freshness: input.to,
        charts: r.observations.length
          ? [
              c.bar(
                {
                  title: `Supplier returns ${input.from}→${input.to}`,
                  asOf: input.to,
                  source: "MA event-impact model",
                },
                "pct",
                r.observations
                  .slice(0, 20)
                  .map((o) => ({ label: o.name.slice(0, 30), value: r2(o.returnPct) ?? 0 })),
              ),
            ]
          : [],
        data: {
          shock: co.nseSymbol,
          sourceId: src,
          window: r.window,
          observations: r.observations.length,
          minObservations: r.minObservations,
          missing: r.missing.slice(0, 10),
          baselineR2: r2(r.baseline?.r2),
          withExposureR2: r2(r.withExposure?.r2),
          deltaR2: r.baseline && r.withExposure ? r2(r.withExposure.r2 - r.baseline.r2) : null,
          exposureCoefficient: coef == null ? null : r2(coef),
          exposureTStat: t == null ? null : r2(t),
          suppliers: r.observations.slice(0, 15).map((o) => ({
            name: o.name,
            exposurePct: r2(o.exposurePct),
            returnPct: r2(o.returnPct),
            distress: r2(o.distress),
          })),
          interpretation:
            r.observations.length < r.minObservations
              ? "Too few priced suppliers with fundamentals to fit the regression; no conclusion."
              : "Model estimate: a |t| below ~2 means exposure did not reliably explain supplier returns in this window; correlation, not causation.",
        },
      };
    },
  });

  return [signals, newsImpact, chain, impact];
}

function dedupe<T extends { from: string; to: string }>(edges: T[]): T[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const k = `${e.from}>${e.to}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
