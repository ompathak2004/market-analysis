# Data sources

| Source | Used for | Access | Rate limit (`HOST_LIMITS`) | Cache |
| --- | --- | --- | --- | --- |
| NSE (`nseindia.com`, `nsearchives.nseindia.com`) | Index constituents (CSV), corporate announcements | HTTP with browser-like headers | 3/10s, 5/10s | announcements deduped by hash |
| Yahoo Finance chart API | Daily OHLCV, live quotes, world indices | HTTP | 10/10s | quotes 1m TTL / 5m stale |
| Screener.in | Fundamentals (annual/quarterly), sector, market cap, annual report and concall links | HTTP → `documents` | 5/10s | `documents` row, re-parse on `SCREENER_PARSER_VERSION` bump |
| Trendlyne research reports | Broker calls (firm, rating, target, report URL) | HTTP → `documents` (30 min) | 4/10s | dedupe key per call |
| Annual reports (BSE/NSE PDFs) | Ind AS 108 concentration, customer mentions | `DocumentStore` (unpdf) | host-based | stored text, `RELATIONSHIP_EXTRACTOR_VERSION` |
| Concall transcripts (PDF) | Customer/supplier mentions, top-N statements | `DocumentStore` | host-based | same |
| Firecrawl | Fallback for JS-heavy or blocked pages | API key | provider | `documents` |

## Storage policy

Every fetched document is stored once in `documents` (URL, content hash, text, `fetched_at`, `parser_version`, `status`). Pipelines re-fetch only when `maxAgeMs` is exceeded and re-parse only when the parser version changed. The API caches read models in Redis + in-process LRU with stale-while-revalidate; worker jobs invalidate affected prefixes after each run.
