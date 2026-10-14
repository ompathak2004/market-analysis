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

`r_h(c)` is the adjusted-close return from the price basis below (model version 2). A counterparty without a usable return is left out of both sums, never counted as zero; `inputs.coverage` records how many counterparties were priced and the reasons the rest were missing, and each contributor records the price `generation` it was computed on.

## 4. Distress score (`packages/intel/src/risk.ts`)

DuPont decomposition on the latest annual statement: `roe = taxBurden × interestBurden × operatingMargin × assetTurnover × leverage`, plus `interestCoverage` and `debtToEquity`. Features are z-scored across the non-financial universe (banks/NBFCs/insurers are excluded — their leverage is structural) and combined:

```
distress = logistic(0.9·z(D/E) − 0.8·z(coverage) − 0.7·z(opMargin) − 0.5·z(ROE) − 0.3·z(turnover) − 1.5)
```

A score needs ≥3 available features. This is an *ordering* signal, not a calibrated probability.

## 5. Event impact (`packages/intel/src/exposure.ts`)

Replicates the Dieselgate analysis: for a shock company and window, take its suppliers, compute `exposure_pct = estimated value / supplier revenue`, and regress supplier returns on DuPont features + distress with and without exposure. The `exposureCoefficient` and ΔR² tell whether supply-chain exposure explained the drawdown. Exposed via `GET /v1/events/impact?symbol=&from=&to=`.

Returns use the same price basis as momentum. Every supplier that drops out is listed in `missing` with its reason (a price coverage reason, `no_fundamentals` or `incomplete_fundamentals`), and the result carries `priceBasis`.

## 6. Analyst calls (`packages/ingest/src/pipelines/analysts.ts`)

Broker reports are aggregated from the broker research cards on each company's Moneycontrol stock page; a card with no date takes the date embedded in its report PDF URL, and cards with neither are dropped. Each call is deduped on (symbol, broker, date, rating, target) and classified against the same broker's prior call: `initiate | upgrade | downgrade | raise_target | lower_target | maintain`. The UI links to the original report so users read the source, not a summary.

## 7. Price basis (`packages/ingest/src/pipelines/prices.ts`, `packages/intel/src/prices.ts`)

Each company and each of the seven tracked indices has five years of daily bars from Yahoo's chart API, fetched in annual windows and validated before any write. A response whose symbol, currency, exchange or instrument type does not match, or that has duplicate or future bars, is rejected whole and recorded as an `invalid_bars` gap. Individual bars with non-positive or non-finite prices, impossible OHLC, negative volume or a day move above 40% that no split explains are dropped and their sessions become gaps. NSE's own history endpoints fill sessions that Yahoo lacks, but only when at least one overlapping close (from this fetch or stored Yahoo rows within two weeks of the window) agrees within 0.05% and none disagrees. An NSE history with no overlap is uncorroborated and adds nothing; the gap stays open.

- Equity `open/high/low/close` are split-adjusted; `adj_close` is split- and dividend-adjusted (a total-return proxy). Index rows are price-return levels. The basis is versioned as `PRICE_BASIS` in `@ma/db`.
- The expected-session calendar is `trading_sessions` (NSE). A missing session is stored as a `price_gaps` range with a reason and rechecked with exponential backoff (1 day doubling to 30 days). A series is `complete` only when every expected session in its window is present or exempt. The window ends at the last NSE session before today, the latest session that can be final. A fetch that leaves an expected session in its window unexplained is `incomplete` and is retried, as is a fetch where Yahoo returned nothing or invalid bars for a window with expected sessions; sessions before Yahoo's first trade date are `prelisting` gaps. An equity window is not fetched until the calendar spans it (`calendar_pending`), so it cannot be judged against a calendar that is still being backfilled.
- A bar becomes final once its IST day has passed. A new or corrected split or dividend sets the series to `rebuild_required`; the whole window is refetched and moved to the next `adjustment_generation` in one transaction, so readers never mix bases. The rebuild is refused, and the old generation kept, unless the refetch covers every expected session that was not already a known gap. The prices API serves only the current generation and flags non-final bars.
- Returns (`seriesReturn`) are `close(to) / close(from) − 1` on `adj_close` over final rows of the current generation. Each endpoint uses the last close on or before the boundary, and that close must be no more than one expected session older than the boundary's session. Otherwise the return is missing with a reason: `no_series`, `rebuild_required`, `no_final_bars`, `no_calendar`, `stale_start` or `stale_end`.

## 8. Influence graph (`packages/intel/src/influence`, `packages/ingest/src/pipelines/influence.ts`)

INFL records who sits on a company's board, who controls it and which entities it transacts with. Facts live in typed tables (`person_roles`, `ownership`, `related_party_transactions`); `influence_edges` link `graph_nodes` (person, company or counterparty) and point at exactly one fact row, and every edge cites `evidence_spans` through `influence_edge_evidence`. Readers use the `influence_edges_confirmed` view, so pending and rejected edges never reach the API.

- Identity. People are resolved by DIN first, then by a parliamentary member id, and only then by name. Confidence bands: 0.98 for an identifier from a structured primary filing, 0.95 for an identifier from another primary source or a name corroborated by two independent primary documents, 0.80 for a single-document name match, 0.60 for news or inference and 0.40 when the name matches more than one person (no person is created). Names are normalized by `PERSON_NORMALIZER_VERSION` (honorifics, suffixes and punctuation stripped; initials kept compatible with full names).
- Auto-confirm. An edge is `confirmed` only when it comes from a structured primary source, carries an identifier and scores at least 0.95. Everything else is `pending` until an operator decides through `review_influence_edge`, a SECURITY DEFINER function with an optimistic version check that records the decision in `influence_reviews`. In practice DIN-keyed `director_of` edges confirm automatically, while name-matched related-party, promoter and subsidiary edges wait for review.
- Governance. `influence.governance` reads the latest NSE governance XBRL, upserts one `person_roles` row per director (`nse_governance:<company>:<person>`) and one `director_of` edge. A director missing from a newer filing is closed with the filing's period end as `to_date`.
- Related parties. `influence.rpt` reads the latest related-party XBRL and keeps one row per counterparty, relationship and transaction type for the period. Relationships are classed as holding, group, associate/JV, KMP, employee benefit or other; employee-benefit trusts get no edge, and KMP rows resolve to people. Each target gets one `related_party` edge pointing at its largest transaction.
- Perimeter. `influence.perimeter` derives `promoter_of` edges from holding-company counterparties and group memberships, and `owns` edges with an `ownership` row from listed subsidiaries.
- Events. `director_change` (joined or left the board) and `material_rpt` events go to `influence_events`. A transaction is material from ₹10 Cr or 1% of the latest annual revenue, whichever is lower (`INFLUENCE_EVENT_RULE_VERSION`). The first read of a filing sets the baseline and emits no events.
- Idempotency. Each filing read is an `influence_extractions` row keyed by `input_hash = sha256(content sha : parser version : normalizer version : resolver version : event-rule version)`. An unchanged hash short-circuits to `unchanged` with no writes, and events are unique on `(company, kind, input_hash)`, so reruns never duplicate the feed. `influence_coverage` records the last read of each source per company.

## Known limitations

- Moneycontrol research cards carry no headline or abstract and the reco price is sometimes missing (`-`, stored as null). Free-tier hits and misses expose the reported actual and a beat/inline/miss outcome but not the consensus estimate, so `earnings_surprises.estimate` and `surprise_pct` are usually null.
- Relationship extraction is regex/cue based; recall on concalls is modest. A sentence-classifier is the natural upgrade.
- INFL reads NSE governance and related-party XBRL only. Political offices, affidavits, electoral bonds and policy releases are modelled but not ingested yet, `company_group_memberships` is not populated, and name-matched related-party edges stay pending until reviewed.
- Fundamentals come from Screener's consolidated tables; quarterly balance sheets are not available there.
- The NSE calendar is derived from ^NSEI trading dates, not imported from NSE holiday notices, so a session on which Yahoo has no index bar is invisible to gap detection.
- Yahoo's `adj_close` follows Yahoo's dividend data; rights issues, demergers and other non-split/dividend actions are not modelled and show up as return discontinuities.
