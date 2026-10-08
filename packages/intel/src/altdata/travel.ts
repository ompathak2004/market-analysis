import { haversineKm } from "@ma/core";
import { type Db, sql } from "@ma/db";
import {
  type AltdataEventInput,
  clamp,
  DAY_MS,
  emitAltdataEvents,
  fitRead,
  formatDay,
  iso,
  isoDate,
  meanStd,
  round,
  weekCounts,
  writeAltdataSignals,
  zScore,
} from "./common.js";
import {
  type AltdataEvidence,
  type AltdataSignal,
  TRAVEL_MODEL_VERSION,
  TRAVEL_SIGNAL_KINDS,
  type TravelSignalKind,
} from "./types.js";

export const COUNTERPARTY_RADIUS_KM = 60;
export const EVENT_WINDOW_DAYS = 3;
export const EVENT_SUBJECT = /board meeting|financial results|outcome of board/i;

export const TRAVEL_KIND_BASE: Record<TravelSignalKind, number> = {
  travel_legs_7d: 1,
  travel_frequency_anomaly: 0.8,
  travel_new_destination: 0.7,
  travel_deal_hub_cluster: 0.6,
  travel_counterparty_visit: 0.6,
  travel_colocation: 0.35,
  travel_event_window: 0.5,
  travel_coverage: 1,
};

export interface DealHubRef {
  icao: string;
  city: string;
  region: string;
  theme: string;
}

export interface AirportPoint {
  lat: number;
  lon: number;
}

export interface TravelAircraft {
  id: number;
  registration: string;
  groupName: string | null;
  confidence: number;
  homeIcao: string | null;
  lastSeenMs: number | null;
}

export interface TravelLeg {
  id: number;
  aircraftId: number;
  registration: string;
  departedMs: number | null;
  arrivedMs: number | null;
  depIcao: string | null;
  depCity: string | null;
  arrIcao: string | null;
  arrCity: string | null;
  arrCountry: string | null;
  completeness: string;
}

export interface CounterpartyFacility {
  companyId: number;
  symbol: string;
  name: string;
  facilityId: number;
  facilityName: string;
  kind: string;
  lat: number;
  lon: number;
}

export interface OtherGroupArrival {
  group: string;
  symbols: string[];
  icao: string;
  city: string | null;
  arrivedMs: number;
  legId: number;
  homeIcao: string | null;
}

export interface TravelAnnouncement {
  id: number;
  subject: string;
  publishedMs: number;
  url: string | null;
}

export type CounterpartyRelation = "customer" | "supplier" | "none";

export interface TravelInput {
  companyId: number;
  label: string;
  asOf: string;
  nowMs: number;
  historyStartMs: number | null;
  aircraft: TravelAircraft[];
  legs: TravelLeg[];
  dealHubs: readonly DealHubRef[];
  airport: (icao: string) => AirportPoint | null;
  counterparties: CounterpartyFacility[];
  relations: Map<number, CounterpartyRelation>;
  otherArrivals: OtherGroupArrival[];
  announcements: TravelAnnouncement[];
}

export interface TravelResult {
  signals: AltdataSignal[];
  events: AltdataEventInput[];
}

export function legAt(leg: TravelLeg): number | null {
  return leg.arrivedMs ?? leg.departedMs;
}

export function travelConfidence(
  aircraftConfidence: number,
  coverage: number,
  kind: TravelSignalKind,
  extra = 1,
): number {
  const coverageFactor = clamp(0.4 + 0.6 * coverage, 0.4, 1);
  return round(
    clamp(aircraftConfidence * coverageFactor * TRAVEL_KIND_BASE[kind] * extra, 0, 1),
    3,
  );
}

function place(icao: string | null, city: string | null): string {
  if (city && icao) return `${city} (${icao})`;
  return city ?? icao ?? "unknown";
}

function legLabel(leg: TravelLeg): string {
  return `${leg.registration} ${leg.depIcao ?? "?"}→${leg.arrIcao ?? "?"}`;
}

function legEvidence(leg: TravelLeg): AltdataEvidence {
  return { kind: "leg", id: leg.id, label: legLabel(leg), at: iso(legAt(leg) ?? 0) };
}

function facilityLabel(kind: string, name: string): string {
  if (kind === "hq") return "HQ";
  if (kind === "plant" || kind === "refinery" || kind === "port" || kind === "terminal")
    return kind;
  return name;
}

export function computeTravelSignals(input: TravelInput): TravelResult {
  const { nowMs, asOf } = input;
  const from7 = nowMs - 7 * DAY_MS;
  const from30 = nowMs - 30 * DAY_MS;
  const window7 = { from: iso(from7), to: iso(nowMs) };
  const window30 = { from: iso(from30), to: iso(nowMs) };
  const aircraftById = new Map(input.aircraft.map((a) => [a.id, a]));
  const homes = new Set(input.aircraft.map((a) => a.homeIcao).filter((h): h is string => !!h));
  const maxConf = Math.max(0, ...input.aircraft.map((a) => a.confidence));
  const confOf = (legs: TravelLeg[]) =>
    legs.length
      ? Math.max(...legs.map((l) => aircraftById.get(l.aircraftId)?.confidence ?? maxConf))
      : maxConf;
  const timed = input.legs
    .map((l) => ({ leg: l, at: legAt(l) }))
    .filter((x): x is { leg: TravelLeg; at: number } => x.at !== null && x.at <= nowMs)
    .sort((a, b) => a.at - b.at);
  const legs7 = timed.filter((x) => x.at >= from7).map((x) => x.leg);
  const legs30 = timed.filter((x) => x.at >= from30).map((x) => x.leg);
  const historyDays =
    input.historyStartMs !== null ? Math.max(0, (nowMs - input.historyStartMs) / DAY_MS) : 0;
  const out: AltdataSignal[] = [];
  const events: AltdataEventInput[] = [];

  const seen30 = input.aircraft.filter((a) => a.lastSeenMs !== null && a.lastSeenMs >= from30);
  const full30 = legs30.filter((l) => l.completeness === "full").length;
  const seenShare = input.aircraft.length ? seen30.length / input.aircraft.length : 0;
  const legShare = legs30.length ? full30 / legs30.length : 0.5;
  const coverage = round(seenShare * legShare, 3);
  const lastSample = Math.max(0, ...input.aircraft.map((a) => a.lastSeenMs ?? 0));
  const push = (
    kind: TravelSignalKind,
    value: number,
    read: string,
    confidence: number,
    evidence: AltdataEvidence[],
    window: { from: string; to: string },
    extra: Record<string, unknown>,
  ) => {
    out.push({
      kind,
      asOf,
      value,
      inputs: {
        read: fitRead(read),
        confidence,
        evidence: evidence.slice(0, 12),
        window,
        ...extra,
      },
    });
  };

  const last = legs7.at(-1);
  push(
    "travel_legs_7d",
    legs7.length,
    legs7.length && last
      ? `${legs7.length} leg${legs7.length === 1 ? "" : "s"} in 7 d across ${input.aircraft.length} linked aircraft; latest ${place(last.depIcao, last.depCity)} → ${place(last.arrIcao, last.arrCity)} on ${formatDay(legAt(last) ?? nowMs)}. Purpose unverified.`
      : `No legs recorded in 7 d for ${input.aircraft.length} linked aircraft; gaps are unknown travel, not zero travel.`,
    travelConfidence(confOf(legs7), coverage, "travel_legs_7d"),
    legs7.slice(-12).map(legEvidence),
    window7,
    {
      legs: legs7.slice(-20).map((l) => ({
        id: l.id,
        reg: l.registration,
        from: l.depIcao,
        to: l.arrIcao,
        departedAt: l.departedMs !== null ? iso(l.departedMs) : null,
        arrivedAt: l.arrivedMs !== null ? iso(l.arrivedMs) : null,
        completeness: l.completeness,
      })),
    },
  );

  const historyWeeks = Math.min(12, Math.max(0, Math.floor(historyDays / 7) - 1));
  if (historyWeeks >= 6) {
    const weekly = weekCounts(
      timed.map((x) => x.at),
      from7,
      12,
    ).slice(12 - historyWeeks);
    const { mean, std } = meanStd(weekly);
    const z = zScore(legs7.length, mean, std);
    if (Math.abs(z) >= 1.5) {
      const ratio = mean > 0 ? legs7.length / mean : null;
      const dir = z > 0 ? "up" : "down";
      push(
        "travel_frequency_anomaly",
        round(z, 2),
        `Travel is ${dir} ${ratio !== null ? `${round(ratio, 1)}×` : "from a zero baseline"} vs its ${historyWeeks}-week norm (${legs7.length} legs vs ${round(mean, 1)}/wk). Purpose unverified; coverage gaps can cause this.`,
        travelConfidence(confOf(legs7), coverage, "travel_frequency_anomaly"),
        legs7.slice(-12).map(legEvidence),
        window7,
        {
          count: legs7.length,
          baseline: {
            from: iso(from7 - historyWeeks * 7 * DAY_MS),
            to: iso(from7),
            mean: round(mean, 2),
            std: round(std, 2),
          },
          history_weeks: historyWeeks,
        },
      );
    }
  }

  if (historyDays >= 60) {
    const destinations: Array<{
      icao: string;
      city: string | null;
      country: string | null;
      arrivedAt: string;
      legId: number;
      lastVisit: null;
    }> = [];
    const newLegs: TravelLeg[] = [];
    const seenCities = new Set<string>();
    for (const leg of legs7) {
      if (!leg.arrIcao || homes.has(leg.arrIcao)) continue;
      const key = leg.arrCity ?? leg.arrIcao;
      if (seenCities.has(key)) continue;
      const at = legAt(leg) ?? nowMs;
      const prior = timed.some(
        (x) =>
          x.at < at &&
          x.at >= at - 180 * DAY_MS &&
          x.leg.id !== leg.id &&
          (x.leg.arrCity ?? x.leg.arrIcao) === key,
      );
      if (prior) continue;
      seenCities.add(key);
      newLegs.push(leg);
      destinations.push({
        icao: leg.arrIcao,
        city: leg.arrCity,
        country: leg.arrCountry,
        arrivedAt: iso(at),
        legId: leg.id,
        lastVisit: null,
      });
    }
    const first = destinations[0];
    if (first) {
      const months =
        historyDays >= 180 ? "6 months" : `${Math.floor(historyDays / 30)} months of data`;
      push(
        "travel_new_destination",
        destinations.length,
        `First recorded visit to ${destinations.map((d) => d.city ?? d.icao).join(", ")} in ≥ ${months}. Purpose unverified.`,
        travelConfidence(
          confOf(newLegs),
          coverage,
          "travel_new_destination",
          Math.min(1, historyDays / 180),
        ),
        newLegs.map(legEvidence),
        window7,
        { destinations, history_days: Math.floor(historyDays) },
      );
      for (const d of destinations) {
        events.push({
          layer: "air",
          kind: "air.new_destination",
          companyId: input.companyId,
          occurredAt: Date.parse(d.arrivedAt),
          headline: `${input.label} aircraft: first recorded visit to ${d.city ?? d.icao} (purpose unverified)`,
          detail: { legId: d.legId, icao: d.icao, city: d.city, country: d.country },
          severity: 2,
          dedupeKey: `travel:${input.companyId}:new_dest:${d.legId}`,
        });
      }
    }
  }

  const hubByIcao = new Map(input.dealHubs.map((h) => [h.icao, h]));
  const hubArrivals = timed.filter((x) => x.leg.arrIcao && hubByIcao.has(x.leg.arrIcao));
  const hub30 = hubArrivals.filter((x) => x.at >= from30);
  if (hub30.length >= 2) {
    const baselineMonths = clamp((Math.min(historyDays, 180) - 30) / 30, 0, 5);
    const prior = hubArrivals.filter((x) => x.at < from30 && x.at >= nowMs - 180 * DAY_MS).length;
    const baselineMonthly = baselineMonths >= 1 ? round(prior / baselineMonths, 2) : null;
    if (baselineMonthly === null || hub30.length >= 2 * baselineMonthly) {
      const grouped = new Map<
        string,
        {
          icao: string;
          city: string;
          theme: string;
          visits: number;
          lastAt: number;
          region: string;
        }
      >();
      for (const x of hub30) {
        const hub = hubByIcao.get(x.leg.arrIcao as string) as DealHubRef;
        const g = grouped.get(hub.icao) ?? {
          icao: hub.icao,
          city: hub.city,
          theme: hub.theme,
          region: hub.region,
          visits: 0,
          lastAt: 0,
        };
        g.visits++;
        g.lastAt = Math.max(g.lastAt, x.at);
        grouped.set(hub.icao, g);
      }
      const hubs = [...grouped.values()].sort((a, b) => b.visits - a.visits);
      const regions = [...new Set(hubs.map((h) => h.region))].join("/");
      const hubLegs = hub30.map((x) => x.leg);
      const baselineText =
        baselineMonthly === null ? "no baseline yet" : `${baselineMonthly}/month baseline`;
      push(
        "travel_deal_hub_cluster",
        hub30.length,
        `${hub30.length} visits to ${regions} in 30 d vs ${baselineText} — consistent with financing or deal talks; purpose unverified.`,
        travelConfidence(
          confOf(hubLegs),
          coverage,
          "travel_deal_hub_cluster",
          baselineMonthly === null ? 0.5 : 1,
        ),
        hubLegs.map(legEvidence),
        window30,
        {
          hubs: hubs.map((h) => ({
            icao: h.icao,
            city: h.city,
            theme: h.theme,
            visits: h.visits,
            lastAt: iso(h.lastAt),
          })),
          baselineMonthly,
        },
      );
      events.push({
        layer: "air",
        kind: "air.deal_hub_cluster",
        companyId: input.companyId,
        occurredAt: Math.max(...hubs.map((h) => h.lastAt)),
        headline: `${input.label} aircraft: ${hub30.length} visits to ${regions} in 30 d (purpose unverified)`,
        detail: { hubs: hubs.map((h) => h.icao), visits: hub30.length, baselineMonthly },
        severity: 2,
        dedupeKey: `travel:${input.companyId}:deal_hub:${asOf}`,
      });
    }
  }

  const visits: Array<{
    counterpartyCompanyId: number;
    symbol: string;
    name: string;
    facilityId: number;
    facilityName: string;
    facilityKind: string;
    city: string | null;
    arrivedAt: string;
    legId: number;
    relationship: CounterpartyRelation;
    km: number;
  }> = [];
  const visitLegs: TravelLeg[] = [];
  for (const leg of legs30) {
    if (!leg.arrIcao) continue;
    const pos = input.airport(leg.arrIcao);
    if (!pos) continue;
    const home = aircraftById.get(leg.aircraftId)?.homeIcao ?? null;
    const best = new Map<number, (typeof visits)[number]>();
    for (const cp of input.counterparties) {
      if (cp.companyId === input.companyId) continue;
      const km = haversineKm(pos.lat, pos.lon, cp.lat, cp.lon);
      if (km > COUNTERPARTY_RADIUS_KM) continue;
      const relationship = input.relations.get(cp.companyId) ?? "none";
      if (relationship === "none" && (leg.arrIcao === home || homes.has(leg.arrIcao))) continue;
      const prev = best.get(cp.companyId);
      if (prev && prev.km <= km) continue;
      best.set(cp.companyId, {
        counterpartyCompanyId: cp.companyId,
        symbol: cp.symbol,
        name: cp.name,
        facilityId: cp.facilityId,
        facilityName: cp.facilityName,
        facilityKind: cp.kind,
        city: leg.arrCity,
        arrivedAt: iso(legAt(leg) ?? nowMs),
        legId: leg.id,
        relationship,
        km: round(km, 1),
      });
    }
    if (best.size) visitLegs.push(leg);
    visits.push(...best.values());
  }
  if (visits.length) {
    visits.sort(
      (a, b) =>
        Number(a.relationship === "none") - Number(b.relationship === "none") ||
        Date.parse(b.arrivedAt) - Date.parse(a.arrivedAt),
    );
    const top = visits[0] as (typeof visits)[number];
    const anyDisclosed = visits.some((v) => v.relationship !== "none");
    const relText =
      top.relationship === "none"
        ? "no disclosed link; coincidence is the base case"
        : `${top.name} is a disclosed ${top.relationship}`;
    push(
      "travel_counterparty_visit",
      visits.length,
      `Aircraft landed near ${top.name} ${facilityLabel(top.facilityKind, top.facilityName)} on ${formatDay(Date.parse(top.arrivedAt))}; ${relText}. Purpose unverified.`,
      travelConfidence(
        confOf(visitLegs),
        coverage,
        "travel_counterparty_visit",
        anyDisclosed ? 1 : 0.5,
      ),
      visitLegs.map(legEvidence),
      window30,
      { visits: visits.slice(0, 20) },
    );
  }

  const coEvents = new Map<
    string,
    {
      otherGroup: string;
      otherSymbols: string[];
      icao: string;
      city: string | null;
      date: string;
      legIds: number[];
    }
  >();
  const coLegs = new Map<number, TravelLeg>();
  for (const leg of legs30) {
    if (!leg.arrIcao) continue;
    const at = legAt(leg) ?? nowMs;
    const day = isoDate(at + 5.5 * 3_600_000);
    const own = aircraftById.get(leg.aircraftId)?.homeIcao ?? null;
    const pos = input.airport(leg.arrIcao);
    for (const o of input.otherArrivals) {
      if (o.arrivedMs < from30) continue;
      if (isoDate(o.arrivedMs + 5.5 * 3_600_000) !== day) continue;
      const excluded = new Set([own, o.homeIcao].filter((x): x is string => !!x));
      if (excluded.has(leg.arrIcao) || excluded.has(o.icao)) continue;
      let near = o.icao === leg.arrIcao;
      if (!near && pos) {
        const op = input.airport(o.icao);
        near = !!op && haversineKm(pos.lat, pos.lon, op.lat, op.lon) <= COUNTERPARTY_RADIUS_KM;
      }
      if (!near) continue;
      const key = `${o.group}|${leg.arrIcao}|${day}`;
      const ev = coEvents.get(key) ?? {
        otherGroup: o.group,
        otherSymbols: o.symbols,
        icao: leg.arrIcao,
        city: leg.arrCity,
        date: day,
        legIds: [],
      };
      for (const id of [leg.id, o.legId]) if (!ev.legIds.includes(id)) ev.legIds.push(id);
      coEvents.set(key, ev);
      coLegs.set(leg.id, leg);
    }
  }
  if (coEvents.size) {
    const list = [...coEvents.values()].sort((a, b) => b.date.localeCompare(a.date));
    const top = list[0] as (typeof list)[number];
    push(
      "travel_colocation",
      list.length,
      `${input.label} and ${top.otherGroup} aircraft in ${top.city ?? top.icao} on ${formatDay(Date.parse(top.date))} — M&A/JV chatter watch; coincidence is the base case.`,
      travelConfidence(confOf([...coLegs.values()]), coverage, "travel_colocation"),
      [...coLegs.values()].map(legEvidence),
      window30,
      { events: list.slice(0, 20) },
    );
  }

  const windowMs = EVENT_WINDOW_DAYS * DAY_MS;
  const evWindows: Array<{
    announcementId: number;
    subject: string;
    publishedAt: string;
    legIds: number[];
    cities: string[];
    offsetDays: number;
  }> = [];
  const evLegs = new Map<number, TravelLeg>();
  const evEvidence: AltdataEvidence[] = [];
  for (const a of input.announcements) {
    if (!EVENT_SUBJECT.test(a.subject)) continue;
    if (a.publishedMs < from30 - windowMs || a.publishedMs > nowMs) continue;
    const near = timed.filter((x) => Math.abs(x.at - a.publishedMs) <= windowMs && x.leg.arrIcao);
    const away = near.filter((x) => !homes.has(x.leg.arrIcao as string));
    const pick = away.length ? away : near;
    if (!pick.length) continue;
    const first = pick[0] as { leg: TravelLeg; at: number };
    for (const x of pick) evLegs.set(x.leg.id, x.leg);
    evEvidence.push({
      kind: "announcement",
      id: a.id,
      label: a.subject.slice(0, 80),
      at: iso(a.publishedMs),
      ...(a.url ? { url: a.url } : {}),
    });
    evWindows.push({
      announcementId: a.id,
      subject: a.subject,
      publishedAt: iso(a.publishedMs),
      legIds: pick.map((x) => x.leg.id),
      cities: [...new Set(pick.map((x) => x.leg.arrCity ?? (x.leg.arrIcao as string)))],
      offsetDays: round((a.publishedMs - first.at) / DAY_MS, 1),
    });
  }
  if (evWindows.length) {
    const top = evWindows[0] as (typeof evWindows)[number];
    const days = Math.round(Math.abs(top.offsetDays));
    const rel = top.offsetDays >= 0 ? "before" : "after";
    const city = top.cities[0] ?? "unknown";
    const label = /board meeting/i.test(top.subject)
      ? "the board meeting notice"
      : "the results filing";
    push(
      "travel_event_window",
      evWindows.length,
      `Travel to ${city} ${days === 0 ? "on the day of" : `${days} day${days === 1 ? "" : "s"} ${rel}`} ${label} on ${formatDay(Date.parse(top.publishedAt))}. Timing only; purpose unverified.`,
      travelConfidence(confOf([...evLegs.values()]), coverage, "travel_event_window"),
      [...evEvidence, ...[...evLegs.values()].map(legEvidence)],
      { from: iso(from30 - windowMs), to: iso(nowMs) },
      { events: evWindows.slice(0, 10) },
    );
  }

  push(
    "travel_coverage",
    coverage,
    `Coverage ${Math.round(coverage * 100)}% — ${seen30.length}/${input.aircraft.length} linked aircraft seen in 30 d, ${full30}/${legs30.length} legs complete; gaps are unknown travel, not zero travel.`,
    round(maxConf, 3),
    [],
    window30,
    {
      aircraftActive: input.aircraft.length,
      aircraftSeen30d: seen30.length,
      legs30d: legs30.length,
      legsFull30d: full30,
      lastSampleAt: lastSample ? iso(lastSample) : null,
    },
  );

  return { signals: out, events };
}

type AircraftRow = {
  id: number;
  registration: string;
  groupName: string | null;
  confidence: number;
  homeIcao: string | null;
  lastSeenMs: number | null;
  companyIds: number[];
};

type LegRow = {
  id: number;
  aircraftId: number;
  registration: string;
  departedMs: number | null;
  arrivedMs: number | null;
  depIcao: string | null;
  depCity: string | null;
  arrIcao: string | null;
  arrCity: string | null;
  arrCountry: string | null;
  completeness: string;
};

type CompanyRow = { id: number; symbol: string; name: string };
type FacilityRow = { [K in keyof CounterpartyFacility]: CounterpartyFacility[K] };
type RelationRow = { supplierId: number; customerId: number };
type AnnouncementRow = {
  id: number;
  companyId: number;
  subject: string;
  publishedMs: number;
  url: string | null;
};

export interface RefreshTravelOptions {
  dealHubs: readonly DealHubRef[];
  airport: (icao: string) => AirportPoint | null;
  now?: Date;
  companyIds?: number[];
  maxCompanies?: number;
  deadline?: number;
}

export interface RefreshTravelResult {
  companies: number;
  written: number;
  events: number;
  skipped: number;
}

export async function travelCompanyIds(db: Db): Promise<number[]> {
  const rows = await db.execute<{ id: number }>(sql`
    select distinct l.company_id as id from corporate_aircraft_companies l
    join corporate_aircraft a on a.id = l.aircraft_id where a.active order by 1`);
  return rows.map((r) => r.id);
}

export async function refreshTravelSignals(
  db: Db,
  opts: RefreshTravelOptions,
): Promise<RefreshTravelResult> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const asOf = isoDate(nowMs);
  const aircraft = await db.execute<AircraftRow>(sql`
    select a.id, a.registration, a.group_name as "groupName", a.confidence, a.home_icao as "homeIcao",
      (extract(epoch from a.last_seen_at) * 1000)::float8 as "lastSeenMs",
      coalesce(array_agg(l.company_id) filter (where l.company_id is not null), '{}') as "companyIds"
    from corporate_aircraft a left join corporate_aircraft_companies l on l.aircraft_id = a.id
    where a.active group by a.id`);
  const result: RefreshTravelResult = { companies: 0, written: 0, events: 0, skipped: 0 };
  const allIds = [...new Set(aircraft.flatMap((a) => a.companyIds))];
  const targetIds = (opts.companyIds ?? allIds).filter((id) => allIds.includes(id));
  const ids = targetIds.slice(0, opts.maxCompanies ?? 80);
  if (!ids.length) return result;
  const fromMs = nowMs - 190 * DAY_MS;
  const [legRows, companyRows, facilityRows, relationRows, announcementRows, history] =
    await Promise.all([
      db.execute<LegRow>(sql`
        select f.id, f.aircraft_id as "aircraftId", a.registration,
          (extract(epoch from f.departed_at) * 1000)::float8 as "departedMs",
          (extract(epoch from f.arrived_at) * 1000)::float8 as "arrivedMs",
          f.dep_icao as "depIcao", f.dep_city as "depCity", f.arr_icao as "arrIcao",
          f.arr_city as "arrCity", f.arr_country as "arrCountry", f.completeness::text as completeness
        from aircraft_flights f join corporate_aircraft a on a.id = f.aircraft_id
        where a.active and coalesce(f.arrived_at, f.departed_at) >= ${iso(fromMs)}`),
      db.execute<CompanyRow>(sql`
        select c.id, c.nse_symbol as symbol, c.name from companies c
        where c.id in (select company_id from corporate_aircraft_companies)`),
      db.execute<FacilityRow>(sql`
        select fc.company_id as "companyId", c.nse_symbol as symbol, c.name, f.id as "facilityId",
          f.name as "facilityName", f.kind::text as kind, f.lat, f.lon
        from facility_companies fc join facilities f on f.id = fc.facility_id
        join companies c on c.id = fc.company_id where f.active`),
      db.execute<RelationRow>(sql`
        select supplier_company_id as "supplierId", customer_company_id as "customerId"
        from relationships
        where supplier_company_id is not null and customer_company_id is not null
          and valid_from <= ${asOf} and valid_to >= ${asOf}
          and (supplier_company_id in ${ids} or customer_company_id in ${ids})`),
      db.execute<AnnouncementRow>(sql`
        select id, company_id as "companyId", subject, attachment_url as url,
          (extract(epoch from published_at) * 1000)::float8 as "publishedMs"
        from announcements
        where company_id in ${ids} and published_at >= ${iso(nowMs - 34 * DAY_MS)}
          and subject ~* ${EVENT_SUBJECT.source}`),
      db.execute<{ startMs: number | null }>(sql`
        select (extract(epoch from min(day)::timestamp) * 1000)::float8 as "startMs"
        from altdata_coverage where layer = 'air'`),
    ]);
  const historyStartMs = history[0]?.startMs ?? null;
  const companyById = new Map(companyRows.map((c) => [c.id, c]));
  const aircraftById = new Map(aircraft.map((a) => [a.id, a]));
  const groupOf = (a: AircraftRow) =>
    a.groupName ??
    a.companyIds.map((id) => companyById.get(id)?.symbol).find((s) => !!s) ??
    a.registration;
  const legsByAircraft = new Map<number, TravelLeg[]>();
  for (const l of legRows) {
    const list = legsByAircraft.get(l.aircraftId) ?? [];
    list.push(l);
    legsByAircraft.set(l.aircraftId, list);
  }
  const events: AltdataEventInput[] = [];
  for (const companyId of ids) {
    if (opts.deadline && Date.now() > opts.deadline - 5_000) {
      result.skipped += ids.length - result.companies;
      break;
    }
    const company = companyById.get(companyId);
    if (!company) continue;
    const own = aircraft.filter((a) => a.companyIds.includes(companyId));
    const ownIds = new Set(own.map((a) => a.id));
    const ownGroups = new Set(own.map(groupOf));
    const relations = new Map<number, CounterpartyRelation>();
    for (const r of relationRows) {
      if (r.supplierId === companyId) relations.set(r.customerId, "customer");
      else if (r.customerId === companyId) relations.set(r.supplierId, "supplier");
    }
    const otherArrivals: OtherGroupArrival[] = [];
    for (const l of legRows) {
      if (ownIds.has(l.aircraftId) || !l.arrIcao || l.arrivedMs === null) continue;
      if (l.arrivedMs < nowMs - 31 * DAY_MS) continue;
      const a = aircraftById.get(l.aircraftId);
      if (!a) continue;
      const group = groupOf(a);
      if (ownGroups.has(group)) continue;
      otherArrivals.push({
        group,
        symbols: a.companyIds
          .map((id) => companyById.get(id)?.symbol)
          .filter((s): s is string => !!s),
        icao: l.arrIcao,
        city: l.arrCity,
        arrivedMs: l.arrivedMs,
        legId: l.id,
        homeIcao: a.homeIcao,
      });
    }
    const computed = computeTravelSignals({
      companyId,
      label: own.find((a) => a.groupName)?.groupName ?? company.symbol,
      asOf,
      nowMs,
      historyStartMs,
      aircraft: own.map((a) => ({
        id: a.id,
        registration: a.registration,
        groupName: a.groupName,
        confidence: a.confidence,
        homeIcao: a.homeIcao,
        lastSeenMs: a.lastSeenMs,
      })),
      legs: own.flatMap((a) => legsByAircraft.get(a.id) ?? []),
      dealHubs: opts.dealHubs,
      airport: opts.airport,
      counterparties: facilityRows.filter((f) => f.companyId !== companyId),
      relations,
      otherArrivals,
      announcements: announcementRows.filter((a) => a.companyId === companyId),
    });
    result.written += await writeAltdataSignals(
      db,
      companyId,
      asOf,
      TRAVEL_SIGNAL_KINDS,
      computed.signals,
      TRAVEL_MODEL_VERSION,
    );
    events.push(...computed.events);
    result.companies++;
  }
  result.events = await emitAltdataEvents(db, events);
  return result;
}
