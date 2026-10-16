# Political exposure and economically useful alternative data

Research and implementation review: 16 October 2026. Production was inspected read-only. Source-ingestion trials and migrations used a disposable local database.

## What an analyst should ask

Start with the business dependency, then identify the decision maker and the evidence of a relationship. For a manufacturer, the useful chain is:

**Disclosed plant → state and local jurisdiction → permits, land, power, water, incentives and labour dependencies → relevant authority at the event date → documented company interactions → measurable decision or operating outcome.**

A registered office in Chennai does not establish that production is in Chennai. TVS's own [manufacturing-location disclosure](https://www.tvsmotor.com/en/tz/about-us/overview) identifies Hosur, Mysore and Nalagarh in three different states. Each can have different operational and regulatory dependencies. Plant-level capacity, asset value and planned capex would establish materiality; counting locations alone cannot supply a percentage of revenue at risk.

The [National Portal's chief-minister directory](https://www.india.gov.in/directory/whos-who/chief-ministers-of-states-and-union-territories) supplies a dated leadership observation. It does not establish party affiliation, coalition composition, a minister's portfolio, a term's start date, personal access or lobbying. An absent chief minister can reflect an omitted record or a different form of administration. The reader therefore uses only the newest directory snapshot and exposes missing and stale observations.

## Electoral bonds and current influence

The Supreme Court struck down the electoral-bond scheme on 15 February 2024; its [11 March 2024 order](https://www.webapi.sci.gov.in/supremecourt/2024/10382/10382_2024_1_301_51365_Judgement_11-Mar-2024.pdf) records the judgment and disclosure directions. Keep those disclosures as dated historical funding evidence. Importing them repeatedly cannot create a current political-access signal.

| Question | Source to prioritise | Interpretation limit |
| --- | --- | --- |
| Who is funding parties now? | [ECI contribution reports](https://www.eci.gov.in/contribution-reports), electoral-trust contribution reports, company annual reports | Preserve financial year, filing date, donor legal entity, amount and recipient. Reporting lag is material. |
| How does a trust connect a donor to a party? | [ECI electoral-trust reports](https://www.eci.gov.in/electoral-trusts-reports) | Record donor → trust and trust → party separately. Pooled money does not establish a particular donor's intended beneficiary or permit a fabricated pro-rata allocation. |
| Is there a documented attempt to shape policy? | Published consultation submissions, industry-body representations, ministry meeting records and company disclosures | A representation can evidence an attempt to influence a policy. Attendance, a donation, a shared surname or an aircraft co-location cannot establish that claim alone. |
| What government decisions affect a plant? | [PARIVESH](https://parivesh.nic.in/), state pollution-control boards, state gazettes, government orders and industrial-development agencies | Track proposal and approval identifiers, competent authority, conditions, status and decision date. A routine approval is not proof of preferential treatment. |
| Is government a material customer? | Award notices, procurement portals and exchange filings | Separate award value, contract period, annual revenue recognition and execution risk. An award total is not annual sales. |
| Do management promises become outcomes? | Results calls, investor presentations, exchange filings, annual reports and subsequent commissioning disclosures | Maintain a dated commitment ledger: original quote, metric, unit, deadline, revisions and actual outcome. Preserve original targets after revisions. |

This is a policy-dependency and documented-relationship system. It should not generate a numerical "lobbying score" from weak correlations. A policy benefit following a donation is a research lead; a causal claim needs substantially stronger evidence and comparison with the policy's wider beneficiaries.

## Flight audit and changes

The production read on 16 October found five VT-TVM legs, four incomplete, with 98 stored observations during the previous week. Direct checks of adsb.lol history returned 162 points for 11 October and 101 for 12 October. Several departure or arrival endpoints were still absent in those fuller histories. The current-day trace likewise began after departure. Those endpoints cannot be recovered reliably from this source alone.

Implemented:

- Reject stale ground fixes, invalid coordinates, cruise-altitude airport matches and ambiguous nearby approach airports. Recover a missing boundary coordinate only from the immediate low-altitude boundary observations.
- Use the exact first-observation timestamp for deduplication so distinct short flights cannot collide inside one half-hour bucket.
- Replay treats adjoining flight intervals as distinct, preserving a previous landing when the next flight shares its ground-bracket timestamp. Repair planning scans past cooling-down candidates instead of starving older eligible days behind a fixed first page, and leaves provider-only OpenSky records outside sampled-track repair.
- Persist parser version and endpoint method. Re-derivation replaces unsupported sampled endpoints; provider-supplied OpenSky endpoints retain their provenance. OpenSky merging shares the aircraft advisory lock and requires actual temporal overlap.
- `aircraft.repair` plans at most 60 aircraft/day units per pass from incomplete or older-parser flights in the last 29 days. Each historical `aircraft.trace` unit validates a date within 30 days, uses the existing HTTP limiter and atomically stores positions and re-derives flights under the aircraft lock. Historical replay can reach beyond the normal 48-hour incremental window. Unavailable days cool down for six hours; successful reads for seven days. Targeted upstream failures reach the job retry policy.
- The JET table explains unobserved endpoints and open tracks. Partial track duration is a lower bound on the observed interval. An open track does not prove the aircraft is still flying.
- Travel model v2 adds arrivals near mapped operating sites as a prompt to check capex and commissioning disclosures. It removes financing/deal speculation from hub and co-location text, and excludes legacy SPLC relationships from counterparty attribution.

An airport estimate, corporate aircraft association and passenger identity remain different facts. More samples do not necessarily resolve missing endpoints. A second independently licensed historical provider or stronger receiver coverage is the next acquisition decision; test recall and endpoint precision before buying it.

## Shipping audit and changes

The production read found no AIS samples at most watched Indian facilities across 775 collection windows over seven days. Singapore Strait and Cape coverage was much stronger. Watching an uncovered facility more frequently cannot establish throughput or a quiet port.

The [AISStream documentation](https://www.aisstream.io/documentation/) describes an event-driven WebSocket feed and subscription filters. A collection-window success ratio measures our observations, not a guarantee that all vessel movements were received. The [Ministry of Ports' monthly cargo publications](https://shipmin.gov.in/en/publication/trw-publication?qt-trw_publication=0) and [Commerce trade analytics](https://www.trade-analytics.commerce.gov.in/public/de) are useful independent series for checking the direction of a port or commodity trend; neither automatically supplies company-level shipment ownership.

Implemented:

- Logistics model v2 compares recent median dwell with the prior eight weeks only with at least five observed exits in both samples and sufficient current collection coverage. Coverage-timeout closures are excluded from dwell comparisons, congestion baselines and completed export departures.
- SHIP shows a coverage timeout as a lower-bound observation, and suppresses a zero arrivals tile when coverage is insufficient.
- Company maps show vessels linked by a facility call, declared destination or disclosed owned fleet. The old query could plot unrelated traffic at any watched chokepoint. Stale vessel observations no longer sustain a current chokepoint watch.
- Cargo value identifies its actual class-typical-barrels assumption. It remains a scenario proxy, not a manifest, revenue estimate, demurrage invoice or loss.

The next useful signals are observed inbound cargo timing, congestion/turnaround changes, a validated physical-volume series and working-capital sensitivity with explicit assumptions. Do not translate vessel count into refinery utilisation, tonnes or earnings without stable coverage, cargo information, facility attribution and out-of-sample validation. Paid AIS should be evaluated on Indian-port completeness and history against a fixed acceptance sample, rather than a global dot count.

## Delivered architecture and remaining acquisition work

Migrations `0014` and `0015` add endpoint provenance, facility jurisdictions, dated state leadership and source-backed operating sites. All political facts cite immutable document-revision spans. `influence.states` refreshes the official directory daily through budgeted Firecrawl; parsing rejects incomplete or conflicting responses. `influence.sites` imports bounded, exact-quote-grounded locations from a document belonging to the company. Site/state association and state code must agree; newer document revisions hide unrefreshed site facts. Locations without coordinates participate in regional analysis without becoming invented maritime or aviation geofences.

The existing company influence API and INFL pane share the regional read model. Every ingest path remains in the worker, with existing contracts, fencing and family cache invalidation. Web remains read-only. Active signal-version filtering prevents superseded model outputs from leaking into the panes.

The local live-source trial ingested 29 official leadership observations and TVS's three disclosed Indian manufacturing locations, each with source evidence. This is an initial operating-footprint capability. Nationwide plant extraction, ruling-party/coalition and ministerial-tenure ingestion, post-bond direct/trust funding ingestion, consultation/approval feeds, materiality weights and the management-commitment ledger remain explicit acquisition work, not implemented claims.

[Tijori Stack](https://www.tijoristack.ai/) and the user's report-on-demand screenshot suggest a useful delivery pattern: a bounded research question with dated evidence and testable conclusions. The app could not be scraped with Firecrawl during this research; no paid report was purchased or evaluated. The report descriptions in the screenshot support prioritising risk investigation and management commitments, rather than copying a generic generated company summary.

## Validation

The merged regression run passed 655 tests across 93 files. Focused database checks also cover repair candidates beyond the first 500 cooling-down entries, provider-only flight exclusion, historical replay beyond 48 hours, exact evidence offsets, source revision changes and unrelated vessel-map exclusion. Workspace typechecking, the production web build, worker compilation and the full Biome check passed. INFL, JET and SHIP were inspected at 1440×900 with document dimensions matching the viewport and internal pane scrolling. Both additive migrations were applied successfully to an empty local Postgres database and production.

Working-copy line endings were normalized for verification without changing unrelated tracked contents. Biome retains ten existing CSS-specificity warnings, and the web build retains the existing `unpdf` webpack `import.meta` warning. Production Vercel and ECS deployments of application commit `275e994` succeeded on 2026-10-17, including the GitHub verification workflow. Live health, travel, logistics and influence endpoints returned HTTP 200; JET, SHIP and INFL rendered without unavailable panes. The initial official leadership refresh loaded 29 records, and a 58-unit historical repair campaign was enqueued. Rollout details are in `docs/ops.md`.
