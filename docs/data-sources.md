# Data sources

| Source | Used for | Access | Rate limit (`HOST_LIMITS`) | Cache |
| --- | --- | --- | --- | --- |
| NSE (`nseindia.com`, `nsearchives.nseindia.com`) | Index constituents (CSV), corporate announcements | HTTP with browser-like headers | 3/10s, 5/10s | announcements deduped by hash |
| Yahoo Finance chart API | Daily OHLCV, live quotes, world indices | HTTP | 10/10s | quotes 1m TTL / 5m stale |
| Screener.in | Fundamentals (annual/quarterly), sector, market cap, annual report and concall links | HTTP → `documents` | 5/10s | `documents` row, re-parse on `SCREENER_PARSER_VERSION` bump |
| Moneycontrol stock page (`www.moneycontrol.com`) | Broker research cards (firm, rating, reco price, target, report PDF), stock score and verdict, MC Insights teasers, shareholding trend with promoter pledge, SWOT, registered office and management | HTTP → `documents` (trimmed, 12h); SWOT page as `moneycontrol_swot` (7d) | 5/10s | `documents` row, re-parse on `MONEYCONTROL_PARSER_VERSION` bump; calls deduped by (symbol, broker, date, rating, target) |
| Moneycontrol estimates API (`api.moneycontrol.com/mcapi/v1/stock/estimates/*`) | Analyst rating mix, monthly consensus, EPS/net profit/revenue forecasts, price target range, quarterly hits and misses | HTTP JSON keyed by Moneycontrol `scId` (204 = no coverage) | 10/10s | Redis `moneycontrol:estimates:<scId>` (12h), upserted into the research tables |
| Broker report PDFs (`images.moneycontrol.com/static-mcnews/*`) | Report text for broker theses | `DocumentStore` as `broker_pdf` (unpdf, first 12 pages, 30d) | 5/10s | linked via `analyst_calls.report_document_id`; failures skipped for 24h |
| Annual reports (BSE/NSE PDFs) | Ind AS 108 concentration, customer mentions | `DocumentStore` (unpdf) | host-based | stored text, `RELATIONSHIP_EXTRACTOR_VERSION` |
| Concall transcripts (PDF) | Customer/supplier mentions, top-N statements | `DocumentStore` | host-based | same |
| Firecrawl | Fallback for JS-heavy or blocked pages | API key | provider | `documents` |

## Storage policy

Every fetched document is stored once in `documents` (URL, content hash, text, `fetched_at`, `parser_version`, `status`). Pipelines re-fetch only when `maxAgeMs` is exceeded and re-parse only when the parser version changed. The API caches read models in Redis + in-process LRU with stale-while-revalidate; worker jobs invalidate affected prefixes after each run.
