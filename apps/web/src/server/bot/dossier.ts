import { defineTool, type ToolContext } from "@ma/agent";
import { z } from "zod";
import type { AppContext } from "../context";
import {
  companyAnnouncements,
  companyBrief,
  companyCalls,
  companyLogistics,
  companyResearch,
  companyTravel,
  financials,
  findCompany,
  keyStats,
  latestSignals,
  peers,
  rangeStats,
  type SupplyChainEdge,
  supplyChain,
} from "../queries";
import { latestRevenueCr, lookupCompanies, sharedEstimates } from "../queries/bot";
import { ChartBuilder, r2 } from "./charts";

export const DOSSIER_VERSION = 1;

const GENERIC =
  /^(the )?(business|businesses|office|others?|segments?|company|companies|customers?|suppliers?|clients?|vendors?|dealers?|distributors?|exports?|domestic|oems?|group|subsidiar(y|ies)|government)$/i;
const EXCHANGE = /^(bse|national stock exchange|nse|metropolitan stock exchange)\b/i;
const AUTHORITY =
  /securities and exchange board|\bsebi\b|appellate|tribunal|registrar of companies|income[- ]tax|reserve bank|stock exchange|ministry of corporate affairs|competition commission|depositor(y|ies)|\bnsdl\b|\bcdsl\b|share transfer agent|registrar and transfer|kfin|link intime/i;
const ENTITY =
  /\b(ltd|limited|inc|corp|corporation|co\.|company|plc|gmbh|ag|s\.a\.|llc|llp|pvt|private|bank|railways?|ministry|department|navy|army|air force|forces|organi[sz]ation|agency|undertaking|nigam|board|motors?|industries|enterprises|group|holdings?)\b/i;
const SUPPLIER_AWARD = /supplier[^.]{0,60}award|award[^.]{0,80}supplier|vendor[^.]{0,40}award/i;
const BOILERPLATE =
  /independent director|serves as|serving as|experience (in|serving)|declaration pursuant|circular no|board of directors|chairman|code of conduct|details of business activities|deputy .*manager/i;

type Quality = "usable" | "weak" | "excluded";

interface CleanEdge {
  name: string;
  symbol: string | null;
  kind: string;
  quality: Quality;
  reason: string | null;
  valueCr: number | null;
  sharePct: number | null;
  basis: "disclosed" | "estimated" | "unquantified";
  method: string | null;
  confidence: number;
  lastDisclosedAt: string | null;
  quote: string | null;
  url: string | null;
  source: string | null;
}

function classify(
  e: SupplyChainEdge,
  side: "customers" | "suppliers",
  revenueOf: ReadonlyMap<string, number>,
): { quality: Quality; reason: string | null } {
  const name = e.counterparty.name.trim();
  if (GENERIC.test(name))
    return { quality: "excluded", reason: "generic label, not a counterparty" };
  if (EXCHANGE.test(name))
    return { quality: "excluded", reason: "stock exchange named in compliance text" };
  if (AUTHORITY.test(name))
    return { quality: "excluded", reason: "regulator or authority named in compliance text" };
  if (!e.counterparty.symbol && !ENTITY.test(name))
    return {
      quality: "excluded",
      reason: "not an identifiable company or institution (place, year or generic phrase)",
    };
  const quote = e.evidence[0]?.quote ?? "";
  if (side === "suppliers" && SUPPLIER_AWARD.test(quote))
    return {
      quality: "weak",
      reason:
        "evidence is a supplier award given by this counterparty, which suggests it is a customer; direction doubtful",
    };
  const value = e.estimate?.valueCr ?? null;
  const cpRevenue = e.counterparty.symbol ? revenueOf.get(e.counterparty.symbol) : undefined;
  if (side === "suppliers" && value != null && cpRevenue != null && value > cpRevenue)
    return {
      quality: "weak",
      reason: "estimated flow exceeds the supplier's own annual revenue; estimate implausible",
    };
  if (BOILERPLATE.test(quote))
    return {
      quality: "weak",
      reason: "evidence is director-bio or compliance text, not a trading relationship",
    };
  if (e.confidence < 0.6) return { quality: "weak", reason: "low extraction confidence" };
  return { quality: "usable", reason: null };
}

function clean(
  edges: readonly SupplyChainEdge[],
  side: "customers" | "suppliers",
  revenueOf: ReadonlyMap<string, number>,
): CleanEdge[] {
  const rows = edges.map((e) => {
    const { quality, reason } = classify(e, side, revenueOf);
    const share =
      side === "customers" ? e.estimate?.supplierRevenuePct : e.estimate?.customerCostPct;
    return { e, quality, reason, valueCr: e.estimate?.valueCr ?? null, share: share ?? null };
  });
  const shared = sharedEstimates(
    rows.map((r) => ({ group: side, valueCr: r.valueCr, pct: r.share })),
  );
  return rows.map((r, i) => {
    const ev = r.e.evidence[0];
    const disclosed = r.e.disclosedPct != null;
    const valueCr = shared[i] ? null : r.valueCr;
    const sharePct = disclosed ? r.e.disclosedPct : shared[i] ? null : r.share;
    return {
      name: r.e.counterparty.name,
      symbol: r.e.counterparty.symbol,
      kind: r.e.counterparty.kind,
      quality: r.quality,
      reason:
        r.reason ??
        (shared[i] ? "estimate is a company-level aggregate copied to several links" : null),
      valueCr: r2(valueCr),
      sharePct: r2(sharePct),
      basis: disclosed
        ? "disclosed"
        : valueCr != null || sharePct != null
          ? "estimated"
          : "unquantified",
      method: r.e.estimate?.method ?? null,
      confidence: r.e.confidence,
      lastDisclosedAt: r.e.lastDisclosedAt,
      quote: ev?.quote.slice(0, 180) ?? null,
      url: ev?.url ?? null,
      source: ev?.source ?? null,
    };
  });
}

function rank(rows: CleanEdge[]): CleanEdge[] {
  return rows
    .filter((r) => r.quality === "usable")
    .sort(
      (a, b) => (b.sharePct ?? -1) - (a.sharePct ?? -1) || (b.valueCr ?? -1) - (a.valueCr ?? -1),
    );
}

function fiscalQuarter(end: string): string {
  const y = Number(end.slice(0, 4));
  const m = Number(end.slice(5, 7));
  const fy = m >= 4 ? y + 1 : y;
  const q = m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 ? 3 : 4;
  return `Q${q} FY${String(fy).slice(2)}`;
}

function cagr(first: number | null, last: number | null, years: number): number | null {
  if (first == null || last == null || first <= 0 || last <= 0 || years <= 0) return null;
  return ((last / first) ** (1 / years) - 1) * 100;
}

const num = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));
const pct = (v: number | null) => (v == null ? "n/a" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
const cr = (v: number | null) =>
  v == null ? "n/a" : `₹${Math.round(v).toLocaleString("en-IN")} Cr`;

async function settle<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

function edgeLine(
  sym: string,
  side: "customer" | "supplier",
  e: CleanEdge,
  id: string | null,
): string {
  const who = e.symbol ? `${e.name} (${e.symbol})` : e.name;
  const cite = id ? ` [${id}]` : "";
  if (e.basis === "unquantified")
    return `${who} is a ${side} named in filings; no value is disclosed or estimated${cite}.`;
  const share =
    e.sharePct == null
      ? ""
      : side === "customer"
        ? `, about ${e.sharePct}% of ${sym}'s revenue`
        : `, about ${e.sharePct}% of ${sym}'s cost base`;
  const value = e.valueCr == null ? "" : ` worth ${cr(e.valueCr)} a year`;
  return `${who}: ${e.basis} ${side}${value}${share}${cite}.`;
}

export function dossierTool(app: AppContext) {
  return defineTool({
    name: "company_research",
    description:
      "Analyst-style research dossier on ONE company that combines every dataset we hold: valuation and price behaviour, multi-year financials with CAGR and margins, cleaned supply chain (who it sells to and buys from, with disclosed vs estimated revenue shares and quality flags), concentration and momentum signals, corporate-aircraft travel (JET), vessel/port logistics (SHIP), ownership trend, broker consensus and targets, material filings and our AI brief, plus explicit data gaps. Use it for 'research', 'deep dive', 'analyse <company>' or 'research note' requests; call it once instead of many company tools.",
    input: z.object({
      symbol: z.string().max(30).describe("NSE symbol or company name, e.g. SHRIPISTON"),
    }),
    timeoutMs: 20_000,
    maxResultChars: 11_000,
    async run(input, ctx: ToolContext) {
      const co = await findCompany(app, input.symbol).catch(async (err) => {
        const hit = (await lookupCompanies(app, input.symbol))[0];
        if (!hit) throw err;
        return findCompany(app, hit.symbol);
      });
      const sym = co.nseSymbol ?? input.symbol.toUpperCase();
      const [
        stats,
        range,
        peerList,
        fin,
        chain,
        research,
        travel,
        logistics,
        brief,
        filings,
        calls,
        signals,
      ] = await Promise.all([
        settle(keyStats(app, sym)),
        settle(rangeStats(app, sym)),
        settle(peers(app, sym, 6)),
        settle(financials(app, sym)),
        settle(supplyChain(app, sym)),
        settle(companyResearch(app, sym)),
        settle(companyTravel(app, sym)),
        settle(companyLogistics(app, sym)),
        settle(companyBrief(app, sym)),
        settle(companyAnnouncements(app, sym, 60)),
        settle(companyCalls(app, sym)),
        settle(latestSignals(app, co.id)),
      ]);
      const gaps: string[] = [];
      const findings: string[] = [];
      const c = new ChartBuilder(ctx.callId);
      const charts: unknown[] = [];

      const statsId = ctx.cite({
        kind: "dataset",
        label: `${sym} fundamentals (₹ Cr, Screener/NSE filings) and prices`,
        url: null,
        publishedAt: stats?.latestQuarter ?? null,
        ref: `fundamentals:${co.id}`,
      });
      const lastClose = range?.last ?? null;
      if (stats) {
        findings.push(
          `Valuation: price ${lastClose ?? stats.price ?? "n/a"}, market cap ${cr(stats.marketCapCr)}, P/E ${r2(stats.peTtm) ?? "n/a"}, P/B ${r2(stats.pb) ?? "n/a"}, ROE ${stats.roePct == null ? "n/a" : `${r2(stats.roePct)}%`}, debt/equity ${r2(stats.debtToEquity) ?? "n/a"} [${statsId}].`,
        );
        charts.push(
          c.kpis(
            {
              title: `${sym} snapshot`,
              asOf: range?.lastDate ?? stats.latestQuarter,
              source: "Fundamentals and NSE closes",
            },
            [
              { label: "Price", value: r2(lastClose ?? stats.price), format: "inr" },
              { label: "Mkt cap Cr", value: r2(stats.marketCapCr), format: "num" },
              { label: "P/E TTM", value: r2(stats.peTtm), format: "num" },
              { label: "ROE %", value: r2(stats.roePct), format: "pct" },
              { label: "OPM %", value: r2(stats.opmPct), format: "pct" },
              { label: "D/E", value: r2(stats.debtToEquity), format: "num" },
              {
                label: "From 52w high",
                value: r2(range?.fromHighPct ?? null),
                format: "pct",
                tone: "neg",
              },
            ],
          ),
        );
      } else gaps.push("valuation ratios unavailable");

      const ret = Object.fromEntries((range?.returns ?? []).map((x) => [x.label, r2(x.pct)]));
      if (range?.bars) {
        const covered = (range.returns ?? []).filter((x) => x.pct != null).map((x) => x.label);
        findings.push(
          `Price: ${Object.entries(ret)
            .filter(([, v]) => v != null)
            .map(([k, v]) => `${k} ${pct(v as number)}`)
            .join(
              ", ",
            )}; ${pct(range.fromHighPct)} from the 52-week high; annualised volatility ${r2(range.volatilityPct) ?? "n/a"}% [${statsId}].`,
        );
        if (covered.length < 4)
          gaps.push(
            `price history covers only ${range.bars} sessions, so returns beyond ${covered.at(-1) ?? "1W"} are unavailable`,
          );
      }

      const annual = (fin?.annual ?? [])
        .filter((r) => num(r.revenue) != null && num(r.netIncome) != null)
        .slice(-6)
        .map((r) => ({
          year: String(r.periodEnd).slice(0, 4),
          revenue: num(r.revenue),
          op: num(r.operatingProfit),
          ni: num(r.netIncome),
        }));
      const quarterly = (fin?.quarterly ?? []).map((r) => ({
        end: String(r.periodEnd).slice(0, 10),
        revenue: num(r.revenue),
        ni: num(r.netIncome),
      }));
      if (annual.length >= 2) {
        const first = annual[0] as (typeof annual)[number];
        const last = annual.at(-1) as (typeof annual)[number];
        const years = annual.length - 1;
        const revCagr = cagr(first.revenue, last.revenue, years);
        const niCagr = cagr(first.ni, last.ni, years);
        const opmFirst =
          first.revenue && first.op != null ? (first.op / first.revenue) * 100 : null;
        const opmLast = last.revenue && last.op != null ? (last.op / last.revenue) * 100 : null;
        findings.push(
          `Financials FY${first.year}→FY${last.year}: revenue ${cr(first.revenue)} → ${cr(last.revenue)} (CAGR ${pct(r2(revCagr))}), net profit ${cr(first.ni)} → ${cr(last.ni)} (CAGR ${pct(r2(niCagr))}), operating margin ${pct(r2(opmFirst))} → ${pct(r2(opmLast))} [${statsId}].`,
        );
        charts.push(
          c.bar(
            {
              title: `${sym} revenue vs net profit (₹ Cr, annual)`,
              asOf: last.year,
              source: "Stored annual statements",
            },
            "num",
            annual.map((a) => ({
              label: `FY${a.year}`,
              value: a.revenue ?? 0,
              compare: a.ni,
              tone: "accent" as const,
            })),
            "Net profit",
          ),
        );
      } else gaps.push("fewer than two annual statements stored");
      const lq = quarterly.at(-1);
      const yq = quarterly.at(-5);
      if (lq && yq?.revenue) {
        findings.push(
          `Latest quarter ${fiscalQuarter(lq.end)} (ended ${lq.end}): revenue ${cr(lq.revenue)} (${pct(r2(lq.revenue != null ? (lq.revenue / yq.revenue - 1) * 100 : null))} YoY), net profit ${cr(lq.ni)}${yq.ni && yq.ni > 0 && lq.ni != null ? ` (${pct(r2((lq.ni / yq.ni - 1) * 100))} YoY)` : ""} [${statsId}].`,
        );
      }

      const cpSymbols = chain
        ? [...chain.customers, ...chain.suppliers]
            .map((e) => e.counterparty.symbol)
            .filter((x): x is string => !!x)
        : [];
      const revenueOf =
        (await settle(latestRevenueCr(app, [...new Set(cpSymbols)]))) ?? new Map<string, number>();
      const customers = chain ? clean(chain.customers, "customers", revenueOf) : [];
      const suppliers = chain ? clean(chain.suppliers, "suppliers", revenueOf) : [];
      const awardedBy = [
        ...new Set(
          suppliers
            .filter((e) => e.reason?.startsWith("evidence is a supplier award"))
            .map((e) => (e.symbol ? `${e.name} (${e.symbol})` : e.name)),
        ),
      ];
      if (awardedBy.length)
        findings.push(
          `Filings cite supplier awards that ${awardedBy.join(", ")} gave ${sym}, which indicates they are customers of ${sym}; the graph records them as suppliers, so their cost-share estimates are excluded and no revenue share is available for them.`,
        );
      const both = new Set(
        rank(customers)
          .map((e) => e.name)
          .filter((n) => rank(suppliers).some((x) => x.name === n)),
      );
      if (both.size)
        gaps.push(
          `${[...both].join(", ")} appear as both customer and supplier; the direction of these links is uncertain`,
        );
      const topC = rank(customers).slice(0, 6);
      const topS = rank(suppliers).slice(0, 6);
      const citeEdge = (e: CleanEdge, side: string) =>
        e.url
          ? ctx.cite({
              kind: "document",
              label: `${sym} ${side} ${e.name}: ${e.source ?? "filing"}`.slice(0, 160),
              url: e.url,
              publishedAt: e.lastDisclosedAt,
              ref: null,
            })
          : null;
      const awardIds = suppliers
        .filter((e) => e.reason?.startsWith("evidence is a supplier award"))
        .map((e) => citeEdge(e, "supplier award from"))
        .filter((x): x is string => !!x)
        .slice(0, 4);
      const custLines = [
        ...(awardedBy.length
          ? [
              `Most important: ${awardedBy.join(", ")} gave ${sym} supplier awards${awardIds.length ? ` [${awardIds.join("][")}]` : ""}, so they are its customers (OEMs it supplies); no revenue share is disclosed for them.`,
            ]
          : []),
        ...topC.map((e) => edgeLine(sym, "customer", e, citeEdge(e, "customer"))),
      ];
      const suppLines = topS.map((e) => edgeLine(sym, "supplier", e, citeEdge(e, "supplier")));
      if (chain) {
        const excluded = [...customers, ...suppliers].filter((r) => r.quality !== "usable");
        findings.push(
          `Supply chain: ${rank(customers).length} usable customer links and ${rank(suppliers).length} usable supplier links out of ${customers.length + suppliers.length} extracted; ${excluded.length} set aside as generic labels, exchanges or director/compliance text.`,
        );
        const quantified = rank(customers).filter((e) => e.sharePct != null);
        if (quantified.length) {
          const top = quantified[0] as CleanEdge;
          findings.push(
            `Largest quantified customer: ${top.name} at about ${top.sharePct}% of revenue (${top.basis}); quantified customers together sum to ${r2(quantified.reduce((s, e) => s + (e.sharePct ?? 0), 0))}% (estimates can overlap, so treat the sum as indicative).`,
          );
          charts.push(
            c.bar(
              {
                title: `${sym}: revenue share by customer (%)`,
                asOf: chain.coverage.lastReadAt,
                source: "MA SPLC graph",
                notes: ["Disclosed where filings state a share; otherwise model estimates"],
              },
              "pct",
              quantified.slice(0, 8).map((e) => ({
                label: e.symbol ?? e.name,
                value: e.sharePct ?? 0,
                tone: e.basis === "disclosed" ? ("pos" as const) : ("accent" as const),
              })),
            ),
          );
        } else if (topC.length)
          gaps.push(
            "customers are named in filings but no revenue share is disclosed or reliably estimated",
          );
        const nodes = [
          { id: sym, label: sym, role: "center" as const },
          ...topC.map((e) => ({
            id: `c:${e.name}`,
            label: e.symbol ?? e.name,
            role: "customer" as const,
          })),
          ...topS.map((e) => ({
            id: `s:${e.name}`,
            label: e.symbol ?? e.name,
            role: "supplier" as const,
          })),
        ];
        if (nodes.length > 1)
          charts.push(
            c.network(
              {
                title: `${sym} customers and suppliers (cleaned)`,
                asOf: chain.coverage.lastReadAt,
                source: "MA SPLC graph",
                notes: ["Generic labels and director/compliance mentions removed"],
              },
              sym,
              nodes,
              [
                ...topC.map((e) => ({
                  from: sym,
                  to: `c:${e.name}`,
                  label: e.sharePct != null ? `${e.sharePct}%` : null,
                  weight: e.sharePct,
                })),
                ...topS.map((e) => ({
                  from: `s:${e.name}`,
                  to: sym,
                  label: e.sharePct != null ? `${e.sharePct}%` : null,
                  weight: e.sharePct,
                })),
              ],
            ),
          );
        if (chain.coverage.read < chain.coverage.available)
          gaps.push(
            `only ${chain.coverage.read} of ${chain.coverage.available} source documents have been read for supply-chain extraction`,
          );
      } else gaps.push("supply-chain graph unavailable");

      const sig = new Map((signals ?? []).map((s) => [s.kind, s]));
      const sigLine = (kind: string, label: string, unit: string) => {
        const s = sig.get(kind);
        return s
          ? `${label} ${unit === "%" ? pct(r2(Number(s.value))) : r2(Number(s.value))} (as of ${String(s.asOf).slice(0, 10)})`
          : null;
      };
      const graphSignals = [
        sigLine("customer_momentum_1m", "customers' 1-month relationship-weighted return", "%"),
        sigLine("supplier_momentum_1m", "suppliers' 1-month relationship-weighted return", "%"),
        Number(sig.get("customer_hhi")?.value ?? 0) >= 0.99
          ? null
          : sigLine("customer_hhi", "customer HHI (1 = single customer)", ""),
        sigLine("distress_score", "distress ordering score (0-1)", ""),
      ].filter(Boolean);
      if (graphSignals.length) {
        const id = ctx.cite({
          kind: "dataset",
          label: `${sym} MA graph signals (active model versions)`,
          url: null,
          publishedAt: null,
          ref: `signals:${co.id}`,
        });
        findings.push(
          `Model signals: ${graphSignals.join("; ")} [${id}]. These are research signals, not forecasts.`,
        );
        const hhi = sig.get("customer_hhi");
        if (hhi && Number(hhi.value) >= 0.99)
          gaps.push(
            "customer HHI of 1.0 means only one customer has an estimated value, not that the company truly has one customer",
          );
      }

      if (travel && travel.aircraft.length) {
        const weeks = travel.weeklyLegCounts.map((w) => w.count);
        const recent = weeks.slice(-4).reduce((s, x) => s + x, 0);
        const prior = weeks.slice(-8, -4).reduce((s, x) => s + x, 0);
        const visits = travel.signals.filter((s) => s.kind === "travel_counterparty_visit").length;
        const id = ctx.cite({
          kind: "dataset",
          label: `${sym} corporate aircraft (ADS-B)`,
          url: null,
          publishedAt: travel.coverage.lastSampleAt,
          ref: `travel:${co.id}`,
        });
        findings.push(
          `Corporate aviation (observed): ${travel.aircraft.length} linked aircraft, ${travel.coverage.legs30d} flight legs in 30 days; legs in the last 4 weeks ${recent} vs ${prior} in the 4 before${visits ? `; ${visits} landings near counterparty sites (inference)` : ""} [${id}].`,
        );
      } else
        gaps.push(
          "no corporate aircraft linked to this company, so JET travel data does not apply",
        );

      if (logistics && (logistics.facilities.length || logistics.fleet)) {
        const calls30 = logistics.calls.filter(
          (x) => Date.parse(x.enteredAt) > Date.now() - 30 * 86_400_000,
        ).length;
        const choke = logistics.signals.find((s) => s.kind === "logistics_chokepoint_exposure");
        const id = ctx.cite({
          kind: "dataset",
          label: `${sym} vessel and port activity (AIS)`,
          url: null,
          publishedAt: logistics.coverage.lastSampleAt,
          ref: `logistics:${co.id}`,
        });
        findings.push(
          `Shipping (observed): ${logistics.facilities.length} linked facilities, ${calls30} vessel calls in 30 days${logistics.fleet ? `, owned fleet ${logistics.fleet.size} (${logistics.fleet.seen7d} seen in 7 days)` : ""}${choke ? `, chokepoint exposure ${r2(Number(choke.value))}` : ""}; AIS coverage factor ${r2(logistics.coverage.factor7d)} [${id}].`,
        );
      } else
        gaps.push(
          "no ports, facilities or fleet linked to this company, so SHIP logistics data does not apply",
        );

      const holding = [...(research?.shareholding ?? [])]
        .sort((a, b) => a.quarterEnd.localeCompare(b.quarterEnd))
        .slice(-4);
      if (holding.length >= 2) {
        const a = holding[0] as (typeof holding)[number];
        const b = holding.at(-1) as (typeof holding)[number];
        const d = (x: number | null, y: number | null) =>
          x != null && y != null ? r2(y - x) : null;
        const id = ctx.cite({
          kind: "research",
          label: `${sym} shareholding pattern (Moneycontrol)`,
          url: null,
          publishedAt: b.quarterEnd,
          ref: `shareholding:${co.id}`,
        });
        findings.push(
          `Ownership ${a.quarterEnd}→${b.quarterEnd}: promoter ${b.promoter ?? "n/a"}% (${d(a.promoter, b.promoter) ?? "n/a"} pp), FII ${b.fii ?? "n/a"}% (${d(a.fii, b.fii) ?? "n/a"} pp), DII ${b.dii ?? "n/a"}% (${d(a.dii, b.dii) ?? "n/a"} pp)${b.promoterPledgePct ? `, promoter pledge ${b.promoterPledgePct}%` : ""} [${id}].`,
        );
        charts.push(
          c.table(
            {
              title: `${sym} shareholding (%)`,
              asOf: b.quarterEnd,
              source: "Moneycontrol shareholding",
            },
            [
              { key: "q", label: "Quarter", format: "date" },
              { key: "promoter", label: "Promoter", format: "num" },
              { key: "fii", label: "FII", format: "num" },
              { key: "dii", label: "DII", format: "num" },
              { key: "public", label: "Public", format: "num" },
            ],
            holding.map((h) => ({
              q: h.quarterEnd,
              promoter: h.promoter,
              fii: h.fii,
              dii: h.dii,
              public: h.public,
            })),
          ),
        );
      } else gaps.push("no shareholding history stored");

      const price = lastClose ?? stats?.price ?? null;
      const tgt = research?.priceTargets;
      const recentCalls = (calls?.calls ?? []).slice(0, 5);
      if (research?.ratings || tgt || recentCalls.length) {
        const parts: string[] = [];
        if (research?.ratings)
          parts.push(
            `${research.ratings.analystCount ?? "?"} analysts, buy ${r2(research.ratings.buyPct) ?? "n/a"}%, hold ${r2(research.ratings.holdPct) ?? "n/a"}%, sell ${r2(research.ratings.sellPct) ?? "n/a"}%`,
          );
        if (tgt?.mean && price)
          parts.push(
            `mean target ${r2(tgt.mean)} (range ${r2(tgt.low)}–${r2(tgt.high)}), ${pct(r2((tgt.mean / price - 1) * 100))} versus the last close`,
          );
        const callIds = recentCalls.map((x) =>
          ctx.cite({
            kind: "research",
            label: `${x.broker} on ${sym} (${x.publishedAt.slice(0, 10)})`,
            url: x.reportUrl,
            publishedAt: x.publishedAt,
            ref: `call:${x.id}`,
          }),
        );
        if (recentCalls.length)
          parts.push(
            `latest calls: ${recentCalls.map((x, i) => `${x.broker} ${x.rating}${x.targetPrice ? ` ${r2(x.targetPrice)}` : ""} [${callIds[i]}]`).join(", ")}`,
          );
        findings.push(`Street view (consensus, not our view): ${parts.join("; ")}.`);
      } else gaps.push("no broker coverage stored");

      const material = (filings ?? [])
        .filter((f) => f.materiality === "high" || f.materiality === "medium")
        .slice(0, 8)
        .map((f) => ({
          date: new Date(f.publishedAt).toISOString().slice(0, 10),
          what: (f.soWhat ?? f.subject).slice(0, 180),
          category: f.triageCategory,
          materiality: f.materiality,
          sourceId: ctx.cite({
            kind: "filing",
            label: `${sym}: ${f.subject}`.slice(0, 160),
            url: f.attachmentUrl,
            publishedAt: new Date(f.publishedAt).toISOString(),
            ref: `announcement:${f.id}`,
          }),
        }));
      if (material.length)
        charts.push(
          c.timeline(
            {
              title: `${sym} material filings`,
              asOf: material[0]?.date ?? null,
              source: "NSE filings with LLM triage",
            },
            material.map((m) => ({
              date: m.date,
              label: m.what,
              tag: m.category,
              tone: m.materiality === "high" ? ("neg" as const) : ("warn" as const),
              sourceId: m.sourceId,
            })),
          ),
        );
      else gaps.push("no high or medium materiality filings in the stored window");

      let aiView: Record<string, unknown> | null = null;
      if (brief?.brief) {
        const ids = new Map(
          brief.evidence.slice(0, 12).map((e) => [
            e.id,
            ctx.cite({
              kind: e.kind === "broker_pdf" ? "research" : "filing",
              label: `${sym} brief: ${e.label}`.slice(0, 160),
              url: e.url,
              publishedAt: null,
              ref: e.id,
            }),
          ]),
        );
        const map = (ev: string[]) => ev.map((x) => ids.get(x)).filter(Boolean);
        aiView = {
          nature: "AI-generated interpretation grounded in cited filings; not a fact",
          generatedAt: brief.meta?.generatedAt ?? null,
          verdict: `${brief.brief.verdict.label} (${brief.brief.verdict.score}/100)`,
          oneLiner: brief.brief.verdict.oneLiner,
          risks: brief.brief.risks
            .slice(0, 3)
            .map((r) => ({ point: r.point, severity: r.severity, sources: map(r.evidence) })),
          catalysts: brief.brief.catalysts
            .slice(0, 3)
            .map((r) => ({ point: r.point, when: r.when, sources: map(r.evidence) })),
        };
      } else gaps.push("no AI company brief generated yet");

      return {
        summary: `${sym} dossier: ${findings.length} findings, ${customers.length + suppliers.length} supply-chain links (${topC.length + topS.length} usable shown), ${gaps.length} data gaps`,
        freshness: range?.lastDate ?? stats?.latestQuarter ?? null,
        charts: charts.slice(0, 6),
        data: {
          dossierVersion: DOSSIER_VERSION,
          company: { symbol: sym, name: co.name, sector: co.sector, industry: co.industry },
          findings,
          customers: custLines,
          suppliers: suppLines,
          setAside: [...customers, ...suppliers]
            .filter((r) => r.quality !== "usable")
            .sort((a, b) => (a.quality === "weak" ? 0 : 1) - (b.quality === "weak" ? 0 : 1))
            .slice(0, 8)
            .map((r) => `${r.name}: ${r.reason}`),
          peers: (peerList ?? [])
            .filter((p) => !p.self && p.industry != null && p.industry === co.industry)
            .map((p) => ({
              symbol: p.symbol,
              marketCapCr: r2(p.marketCapCr),
              distress: r2(p.distress),
            })),
          material,
          aiView,
          dataGaps: gaps,
          howToRead: [
            "findings are deterministic facts with source ids; quote their numbers as written",
            "disclosed = stated in a filing; estimated = MA model; unquantified = named only",
            "momentum and distress are research signals from our models, not predictions",
            "the AI brief is an interpretation; present it as such",
          ],
        },
      };
    },
  });
}
