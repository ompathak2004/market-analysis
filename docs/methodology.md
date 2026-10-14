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

**LLM extraction** (`packages/intel/src/relationships`, jobs `relationships.llm` → `relationships.llm.extract`). The regex extractor is the first pass; a second, schema-bound Cerebras read covers what it misses. Each adapter picks the highest-scoring cue sections of the stored text within a token budget, numbers them `S1…Sn`, and asks for claims that quote a section verbatim (`RELATIONSHIP_PROMPT_VERSION = 1`, temperature 0). A claim is kept only if its quote is found again inside the cited section after folding whitespace, curly quotes, dashes and ₹, is 20–600 characters long, names the counterparty, and contains any % or amount the model reports; otherwise it is dropped and counted by reason. Offsets map to evidence spans and pages exactly like regex observations.

| Adapter | Families | Roles | Max confidence | Notes |
| --- | --- | --- | --- | --- |
| `orders` | `order_filing`, `announcement_metadata` | customer | 0.85 | only filings where the order regex succeeded but found nothing |
| `annual_report` | `annual_report` | both | 0.85 | Ind AS 108, single-customer and purchase-of-goods passages score higher |
| `concall` | `concall` | both | 0.80 | analyst and moderator turns are blanked before section selection, offsets kept |
| `rating_rationale` | `rating_rationale` | both | 0.75 | third-party disclosure; text outside the rationale body is masked |
| `presentation` | `presentation` | both | 0.70 | pilot, off unless `SPLC_PRESENTATIONS_PILOT=true` |

Claims become observations through the same `writeExtraction` ledger (`extractor_version` = 100 + adapter version, so regex and LLM reads of one document never delete each other's pending rows). Confidence is the model's, capped per adapter, minus 0.1 when the counterparty had to be created; such observations stay `pending` for review. Generic names ("a leading OEM"), self, same-group and blocked pairs are dropped. A share claim without a quoted % becomes `unknown`, an order becomes `contract_total`, and an `annual_flow` needs a quoted amount. The token cost (`relationship_extractions.tokens`) is charged to the `relationships` LLM budget class; the daily fan-out plans documents round-robin across adapters until that class's remaining budget is used.

## 2. Relationship value estimation (`packages/intel/src/estimates.ts`, `packages/intel/src/priors.ts`)

Bloomberg's SPLC publishes a *disclosed / derived / estimated* waterfall; we mirror it (`ESTIMATE_MODEL_VERSION = 2`). Only `active` edges valid on `as_of` are estimated, and each edge is read in its own `value_basis`:

| Basis | Method | Value |
| --- | --- | --- |
| `revenue_share` with a quoted % | disclosed | supplier revenue for the fiscal year the disclosure names × pct / 100; no number when that year's revenue is missing (`no_supplier_revenue_for_period`) |
| `purchase_share` with a quoted % | derived | customer cost base for that year × pct / 100 (`no_customer_cost_base_for_period` otherwise) |
| `annual_flow` with a quoted ₹ amount | disclosed | the amount, period ending 31 March of the stated fiscal year |
| `contract_total` | disclosed | the order value as its own row with no period; it is never summed into annual flows, and the edge also gets a statistical row |
| anything else | estimated | statistical prior below |

The customer cost base follows the edge's `cost_bucket`: `CAPEX` uses capex, `SGA` SG&A, `RND` R&D and everything else purchases (falling back to COGS). Financials come from `relationship_financial_facts` when present, then from Screener `fundamentals`; purchases come only from the facts table, so until it is populated purchase shares divide by COGS.

**Priors.** `refreshPriors` (weekly job `relationships.priors`, `PRIOR_MODEL_VERSION = 1`) takes every active or expired `revenue_share` edge with a disclosed %, groups them by supplier sector × cost bucket × cue class (`order`, `customer_count`, `ownership`, `mention`, plus `all`) and stores p25/p50/p75 in `relationship_priors`. A group needs at least 20 disclosures from 5 distinct suppliers. A statistical estimate picks the edge's cue class first and falls back to `all`; with no qualifying prior, no sector, or an edge where neither side is in `INTEL_UNIVERSE` (default NIFTY100), the row is written with a null value and `inputs.reason` (`insufficient_prior`, `outside_universe`, `no_supplier_revenue`). Value = latest supplier revenue × p50, range p25 to p75.

**Aggregate cap.** For each customer, cost bucket and period, the estimated shares of the customer's cost base are scaled down so disclosed plus estimated shares never exceed 100%; disclosed and derived rows are never scaled and the factor is stored as `inputs.aggregateCapScale`. Every row's `inputs` records the basis, cue class, disclosed numbers, fiscal year and prior used, and `refreshEstimates` replaces the rows for `(as_of, model_version)` per batch of relationships.

## 3. Customer momentum (`packages/intel/src/momentum.ts`)

From the white paper: a supplier's future returns correlate with the recent price performance of its customers, weighted by relationship size. For horizon *h* ∈ {1m, 2m, 3m}:

```
customer_momentum_h(S) = Σ_c w_c · r_h(c) / Σ_c w_c
w_c = estimated value_cr (fallback: supplier_revenue_pct, then 1)
```

`supplier_momentum_h` is the mirror image for customers. Links are `active` edges with an estimate at the current `ESTIMATE_MODEL_VERSION`, excluding `contract_total` rows. Signals store their contributors in `inputs` so the UI can show *why*.

`r_h(c)` is the adjusted-close return from the price basis below (model version 2). A counterparty without a usable return is left out of both sums, never counted as zero; `inputs.coverage` records how many counterparties were priced and the reasons the rest were missing, and each contributor records the price `generation` it was computed on.

**Concentration** (`packages/intel/src/concentration.ts`, `CONCENTRATION_MODEL_VERSION = 3`): `customer_hhi` = Σ share² over customers that have an estimated rupee value (1.0 = single customer). Unvalued customers are counted in `inputs.unvalued` instead of being given an equal weight. `customer_concentration_pct` and `top{N}_customers_pct` still come from the regex extractor at `RELATIONSHIP_EXTRACTOR_VERSION`.

**Active versions.** Readers do not take the highest `model_version` for graph signals. `activeSignalVersionClause` in `packages/intel/src/signal-versions.ts` pins each kind to its current version (`customer_hhi` 3, momentum 2, concentration and top-N 3, `distress_score` 1), so stale versions are ignored and kinds outside the map pass through.

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
- Political offices. `influence.parliament` (weekly) reads the Sansad Lok Sabha and Rajya Sabha sitting-member APIs and the Council of Ministers list and snapshots each house (`DocumentStore.putInline`, family `parliament`). Members resolve by `lok_sabha_member`/`rajya_sabha_member` id first and then by name among people without that id; anyone left is created. Each member gets a `political_roles` row, a `holds_office` edge to the house (ministers to "Union Council of Ministers") and a `member_of_party` edge. Id matches score 0.98 and confirm; a name match onto an existing director scores 0.80 and waits for review. A member missing from a later read is closed (`status = past`, `to_date` = read date) and `office_gained`/`office_lost` events go to every company where the person holds a current board role; the first read sets the baseline.
- Affidavits. `influence.affidavits` (monthly) matches sitting MPs without a `myneta_candidate` identifier to the MyNeta Lok Sabha 2024 winners list by constituency, or the Rajya Sabha list by state, and fans out `influence.affidavit` per match. Declared share holdings and businesses become `affidavit_interests`; when the holding names a listed company, a `declared_interest` (self) or `declared_family` edge at 0.80 waits for review.
- Electoral bonds. `influence.bonds` is run by hand with the SBI purchase and redemption PDFs. Rows are joined on bond prefix and number (`matched_on`), purchasers resolve to companies or counterparties by name, and each purchaser-party pair becomes one `donated_to` edge at 0.80 (pending) spanning the first to the last donation, plus a `donation` event. Donation edges are historical, so the documented-path reader keeps them after `valid_to`.
- Policy events. `influence.policy.pib` (hourly RSS), `influence.policy.prs` (daily bill tracker) and `influence.policy.gazette` (PDF URLs given in the payload) store each release once as a `policy_events` row keyed by source and external id with an `input_hash` of the parsed text. `influence.sectors` (weekly) maps each company's NSE index industry to policy sectors (`POLICY_SECTOR_MAP_VERSION`) and writes a confirmed `operates_in_sector` edge at 0.95 citing the industry snapshot. Tagging (`influence.policy.tag`, `POLICY_TAGGER_VERSION`) is rules first: the issuing ministry maps to sectors at 0.95 (confirmed) and a company name of six or more characters in the title or text gives a `policy_applies_to` company tag at 0.80 (pending). Only when no ministry rule applies does the model read the first 6,000 characters of the policy text (budget class `influence`); a model tag must quote that text, scores 0.60 and stays pending. `policy_change` events reach companies only through confirmed tags, either by name or through `company_policy_sectors`. An unchanged extraction hash returns `unchanged` with no writes and no model call.
- Documented paths. The INFL pane lists a political path only when every hop is a confirmed edge with at least one evidence span (board, promoter, declared-interest, ownership or related-party hops ending in an office, a party membership or a donation); anything weaker stays in `/admin/review`, where `review_influence_edge` confirms or rejects it and the company's influence cache is invalidated.

## Known limitations

- Moneycontrol research cards carry no headline or abstract and the reco price is sometimes missing (`-`, stored as null). Free-tier hits and misses expose the reported actual and a beat/inline/miss outcome but not the consensus estimate, so `earnings_surprises.estimate` and `surprise_pct` are usually null.
- Relationship extraction is regex/cue based with an LLM second pass bounded by a daily token budget, so recall depends on how much of the queue the budget covers. Credit-rating rationales are found only through NSE `credit_rating` announcements; agency listing pages are not crawled.
- `relationship_financial_facts` is not populated yet, so purchase shares and cost bases use Screener COGS, capex and SG&A.
- INFL political data has gaps: Sansad lists carry no ministerial portfolio or term dates, so ministers are linked to the Council of Ministers only; the Rajya Sabha Register of Members' Interests is not published openly, so MyNeta affidavits stand in for it and carry no PDF link; the ECI bond page sits behind a WAF (406), so `influence.bonds` reads the SBI PDFs from URLs passed by hand; eGazette has an incomplete TLS chain and WebForms listings, so `influence.policy.gazette` only reads PDF URLs it is given. Sector mapping uses the NSE index industry, not annual-report segment notes. `company_group_memberships` is not populated, and name-matched edges (related parties, directors who are MPs, affidavit holdings, donations, policy name tags) stay pending until reviewed.
- Fundamentals come from Screener's consolidated tables; quarterly balance sheets are not available there.
- The NSE calendar is derived from ^NSEI trading dates, not imported from NSE holiday notices, so a session on which Yahoo has no index bar is invisible to gap detection.
- Yahoo's `adj_close` follows Yahoo's dividend data; rights issues, demergers and other non-split/dividend actions are not modelled and show up as return discontinuities.
