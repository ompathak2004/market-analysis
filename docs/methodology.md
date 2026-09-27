# Methodology

How raw filings and prices become the signals shown in the terminal. Sources: Bloomberg *Supply Chain (SPLC) case study* (Dieselgate, 2015), Bloomberg *Supply Chain Customer Momentum* white paper, and *Journal of Supply Chain Management* 10.1111/jscm.12294 (supplier exposure and financial distress).

## 1. Relationship discovery (`packages/ingest/src/extract/relationships.ts`)

Indian issuers rarely name customers in the way US 10-K Item 1 does, so evidence is assembled from several disclosure layers:

| Layer | Where | What we extract | Confidence base |
| --- | --- | --- | --- |
| Ind AS 108 segment note | Annual report | "No. of customers exceeding 10% of revenue" and "revenue from such customers" → `customer_concentration_pct` | 0.70 (+0.15 if a % is stated) |
| Management commentary | Concall transcripts | Named counterparties near customer/supplier cues (`supplies to`, `orders from`, `our customer …`), single-% statements ("X contributes 12% of revenue") | 0.55 (+0.15 with %, −0.15 without) |
| Top-N statements | Concalls, AR MD&A | "top 5 customers contribute 51%" → `top5_customers_pct` | signal only |

Alias matching uses `company_aliases` (legal name, short name, NSE symbol ≥4 chars) with a stoplist of generic tokens (`india`, `industries`, `bank`, …) so "Engineers India" does not match every "engineers". A relationship row is `supplier → customer` with `disclosed_by`, `disclosure_kind` (`major_customer` | `press` | `segment`), `valid_from` = period end, `valid_to` = +4 years (Bloomberg treats undisclosed relationships as decaying, not permanent).

## 2. Relationship value estimation (`packages/intel/src/estimates.ts`)

Bloomberg's SPLC publishes a *disclosed / derived / estimated* waterfall; we mirror it.

1. **Disclosed** — a rupee value is stated. Range = value.
2. **Derived** — a percentage of supplier revenue is stated. `value = supplierRevenue × pct / 100`, range ±10%.
3. **Estimated** — nothing quantitative. Prior `pct` is chosen from the disclosure type: `major_customer` → 10% (the Ind AS 108 threshold), `press` → 6%, otherwise 4%; a "largest customer" cue uses the company's `top1_customers_pct` signal when present. Spread = `1 − clamp(confidence, 0.1, 0.9)` on both sides.

Every estimate is capped at the customer's COGS (a supplier cannot sell a customer more than the customer spends). Output: `value_cr`, `value_low_cr`, `value_high_cr`, `supplier_revenue_pct`, `customer_cost_pct`, `model_version`.

## 3. Customer momentum (`packages/intel/src/momentum.ts`)

From the white paper: a supplier's future returns correlate with the recent price performance of its customers, weighted by relationship size. For horizon *h* ∈ {1m, 2m, 3m}:

```
customer_momentum_h(S) = Σ_c w_c · r_h(c) / Σ_c w_c
w_c = estimated value_cr (fallback: supplier_revenue_pct, then 1)
```

`supplier_momentum_h` is the mirror image for customers. `customer_hhi` = Σ share² over customer weights measures concentration (1.0 = single customer). Signals store their contributors in `inputs` so the UI can show *why*.

## 4. Distress score (`packages/intel/src/risk.ts`)

DuPont decomposition on the latest annual statement: `roe = taxBurden × interestBurden × operatingMargin × assetTurnover × leverage`, plus `interestCoverage` and `debtToEquity`. Features are z-scored across the non-financial universe (banks/NBFCs/insurers are excluded — their leverage is structural) and combined:

```
distress = logistic(0.9·z(D/E) − 0.8·z(coverage) − 0.7·z(opMargin) − 0.5·z(ROE) − 0.3·z(turnover) − 1.5)
```

A score needs ≥3 available features. This is an *ordering* signal, not a calibrated probability.

## 5. Event impact (`packages/intel/src/exposure.ts`)

Replicates the Dieselgate analysis: for a shock company and window, take its suppliers, compute `exposure_pct = estimated value / supplier revenue`, and regress supplier returns on DuPont features + distress with and without exposure. The `exposureCoefficient` and ΔR² tell whether supply-chain exposure explained the drawdown. Exposed via `GET /v1/events/impact?symbol=&from=&to=`.

## 6. Analyst calls (`packages/ingest/src/pipelines/analysts.ts`)

Broker reports are aggregated from Trendlyne's public research listing. Each call is deduped on (symbol, broker, date, rating, target) and classified against the same broker's prior call: `initiate | upgrade | downgrade | raise_target | lower_target | maintain`. The UI links to the original report so users read the source, not a summary.

## Known limitations

- Trendlyne headlines are upstream data and occasionally name the wrong company; the stock link and `reportUrl` are row-aligned.
- Relationship extraction is regex/cue based; recall on concalls is modest. A sentence-classifier is the natural upgrade.
- Fundamentals come from Screener's consolidated tables; quarterly balance sheets are not available there.
