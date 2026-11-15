export const ORDER_FLOW_VERSION = 1;

export type BuyerGroup =
  | "Defence"
  | "Railways & metro"
  | "Power"
  | "Coal, mining & metals"
  | "Oil & gas"
  | "Roads, ports & urban"
  | "Other government"
  | "Private (India)"
  | "Overseas"
  | "Unclear";

export const BUYER_GROUPS: readonly BuyerGroup[] = [
  "Defence",
  "Railways & metro",
  "Power",
  "Coal, mining & metals",
  "Oil & gas",
  "Roads, ports & urban",
  "Other government",
  "Private (India)",
  "Overseas",
  "Unclear",
];

export const PUBLIC_GROUPS: ReadonlySet<BuyerGroup> = new Set([
  "Defence",
  "Railways & metro",
  "Power",
  "Coal, mining & metals",
  "Oil & gas",
  "Roads, ports & urban",
  "Other government",
]);

export interface RawOrder {
  observationId: number;
  announcementId: number | null;
  family: string;
  publishedAt: string;
  supplierSymbol: string;
  supplierName: string;
  buyerName: string;
  buyerKind: string;
  buyerSymbol: string | null;
  valueCr: number | null;
  currency: string | null;
  orderStatus: "awarded" | "pending" | "cancelled" | null;
  confidence: number;
  claim: string;
  subject: string | null;
  url: string;
}

export interface OrderValue {
  low: number;
  high: number | null;
  basis: "disclosed" | "band";
  band: string | null;
}

export interface CleanOrder {
  id: string;
  date: string;
  supplier: string;
  supplierName: string;
  buyerKey: string;
  buyer: string;
  buyerGroup: BuyerGroup;
  buyerRaw: string;
  status: "awarded" | "l1" | "cancelled";
  value: OrderValue | null;
  foreignCurrency: string | null;
  subject: string | null;
  claim: string;
  url: string;
  flags: string[];
}

export type ExclusionReason =
  | "tax or regulatory order, not a purchase order"
  | "year-to-date or order-book total, not a new order"
  | "same filing read twice"
  | "repeat filing of an order already counted";

export interface ExcludedOrder {
  id: string;
  date: string;
  supplier: string;
  buyerRaw: string;
  valueCr: number | null;
  reason: ExclusionReason;
  url: string;
}

type Rule = readonly [RegExp, string, BuyerGroup];

const RULES: readonly Rule[] = [
  [
    /ministry of defen[cs]e|\bmod\b|indian (navy|army|air force|coast guard)|\bdrdo\b|defence r ?& ?d|armament research|\barde\b|munitions india|gun factory|ordnance|controller general of defence/i,
    "Ministry of Defence & forces",
    "Defence",
  ],
  [/hindustan aeronautics/i, "Hindustan Aeronautics", "Defence"],
  [/bharat electronic/i, "Bharat Electronics", "Defence"],
  [/brahmos/i, "BrahMos Aerospace", "Defence"],
  [/garden reach/i, "Garden Reach Shipbuilders", "Defence"],
  [/mazagon dock/i, "Mazagon Dock", "Defence"],
  [/cochin shipyard/i, "Cochin Shipyard", "Defence"],
  [/\bmmrda\b|mumbai metropolitan region development/i, "MMRDA", "Roads, ports & urban"],
  [/dangote/i, "Dangote Group", "Overseas"],
  [/sri lanka railways/i, "Sri Lanka Railways", "Overseas"],
  [/vadhvan port/i, "Vadhvan Port Project", "Roads, ports & urban"],
  [/inland waterways/i, "Inland Waterways Authority", "Roads, ports & urban"],
  [/central public works|\bcpwd\b/i, "CPWD", "Roads, ports & urban"],
  [
    /brihanmumbai municipal|municipal corporation of greater mumbai|\bmcgm\b|\bbmc\b/i,
    "BMC (Mumbai)",
    "Roads, ports & urban",
  ],
  [/megha engineering/i, "Megha Engineering", "Private (India)"],
  [/rail vikas nigam|\brvnl\b/i, "Rail Vikas Nigam", "Railways & metro"],
  [/national high speed rail/i, "National High Speed Rail Corp", "Railways & metro"],
  [/konkan railway/i, "Konkan Railway", "Railways & metro"],
  [/railtel/i, "RailTel", "Railways & metro"],
  [/ircon/i, "IRCON", "Railways & metro"],
  [/irctc|indian railway catering/i, "IRCTC", "Railways & metro"],
  [/dedicated freight corridor|\bdfccil\b/i, "Dedicated Freight Corridor Corp", "Railways & metro"],
  [/metro rail|metro railway|mass transit|\bmetro\b/i, "", "Railways & metro"],
  [
    /indian railways?|railway board|banaras locomotive|patiala loco|integral coach|modern coach|rail coach factory|chittaranjan|research designs and standards|\brdso\b|railway recruitment|\bsr\.? ?dste\b|\bdy\.? ?cste\b|\bcore\b.*railway|(central|western|eastern|northern|southern|south[- ]?\w+|north[- ]?\w+) railway|rail infrastructure development/i,
    "Indian Railways",
    "Railways & metro",
  ],
  [/\bntpc\b/i, "NTPC", "Power"],
  [/power ?grid|\bpgcil\b/i, "Power Grid", "Power"],
  [/\bsjvn\b/i, "SJVN", "Power"],
  [/\bnhpc\b/i, "NHPC", "Power"],
  [/damodar valley|\bdvc\b/i, "DVC", "Power"],
  [/solar energy corporation|\bseci\b/i, "SECI", "Power"],
  [/maharashtra state electricity distribution|\bmsedcl\b|mahavitaran/i, "MSEDCL", "Power"],
  [/maharashtra state power generation|\bmahagenco\b/i, "Mahagenco", "Power"],
  [/maharashtra state electricity transmission|\bmsetcl\b/i, "MSETCL", "Power"],
  [/gujarat energy transmission|\bgetco\b/i, "GETCO", "Power"],
  [/gujarat state electricity|\bgsecl\b/i, "GSECL", "Power"],
  [/telangana (power generation|state power)|\btsgenco\b|\btgenco\b/i, "Telangana Genco", "Power"],
  [/madhya pradesh power generating|m\.?p\.? power generating/i, "MP Power Generating Co", "Power"],
  [/chhattisgarh state power generation/i, "Chhattisgarh Genco", "Power"],
  [/rewa ultra mega|\brumsl\b/i, "Rewa Ultra Mega Solar", "Power"],
  [/adani power/i, "Adani Power", "Power"],
  [/tata power/i, "Tata Power", "Power"],
  [/torrent/i, "Torrent group", "Power"],
  [/\brec\b|rec power/i, "REC", "Power"],
  [
    /power distribution|distribution co(mpany|rporation)|electricity (distribution|corporation|board)|transmission corporation|\btsecl\b|\bupcl\b|uttarakhand power|state electricity|discom|\bgenco\b|power corporation|energy transmission|electricity supply|urja/i,
    "",
    "Power",
  ],
  [
    /coal india|\bcil\b|coalfields|\bcmpdi\b|central mine planning|bharat coking coal/i,
    "Coal India group",
    "Coal, mining & metals",
  ],
  [/bharat coal gasification|\bbcgcl\b/i, "Bharat Coal Gasification", "Coal, mining & metals"],
  [/\bnmdc\b|national mineral development/i, "NMDC", "Coal, mining & metals"],
  [/steel authority|\bsail\b/i, "SAIL", "Coal, mining & metals"],
  [/national aluminium|\bnalco\b/i, "NALCO", "Coal, mining & metals"],
  [/hindalco/i, "Hindalco", "Coal, mining & metals"],
  [/\bjsw (steel|utkal)/i, "JSW Steel", "Coal, mining & metals"],
  [/\bnlc\b|neyveli/i, "NLC India", "Power"],
  [/oil (and|&) natural gas|\bongc\b/i, "ONGC", "Oil & gas"],
  [/bharat petroleum|\bbpcl\b/i, "BPCL", "Oil & gas"],
  [/hindustan petroleum|\bhpcl\b/i, "HPCL", "Oil & gas"],
  [/indian oil|\biocl?\b/i, "Indian Oil", "Oil & gas"],
  [/\bgail\b/i, "GAIL", "Oil & gas"],
  [/petronet/i, "Petronet LNG", "Oil & gas"],
  [/oil india/i, "Oil India", "Oil & gas"],
  [/\badnoc\b/i, "ADNOC", "Overseas"],
  [/kuwait oil/i, "Kuwait Oil Company", "Overseas"],
  [
    /national highways authority|\bnhai\b|nhidcl|ministry of road transport/i,
    "NHAI & MoRTH",
    "Roads, ports & urban",
  ],
  [/\bport authority|\bport trust|\bport project/i, "", "Roads, ports & urban"],
  [/\bupeida\b|expressways industrial development/i, "UPEIDA", "Roads, ports & urban"],
  [
    /municipal corporation|growth corridor|development authority|public works|urban development|smart city|outer ring road|water supply|sewerage|jal (board|nigam)|airport|\bdial\b/i,
    "",
    "Roads, ports & urban",
  ],
  [
    /sri lanka|dhaka|bangladesh|riyadh|saudi|dubai|roads and transport authority|nigeria|africa|mozambique|\bicvl\b|guyana|caribbean|qatar|ooredoo|kenya|nepal|tennet|ellevio|linjemontage|safran|blue origin|together ai|saipem|\busa\b|singapore|\bpte\b|\bgmbh\b|\bplc\b|\binc\b|\bllc\b|\bspa\b|\bs\.a\.|berhad|berhard|ndalama/i,
    "",
    "Overseas",
  ],
  [
    /state bank of india|bharat heavy electricals|balmer lawrie|new india assurance|hindustan steelworks|bharat sanchar|\bbsnl\b|\bmtnl\b|engineers india|life insurance corporation|prasar bhar/i,
    "",
    "Other government",
  ],
  [
    /ministry|department|directorate|government|govt|commission|board|council|authority|corporation of india|\bpsu\b|samiti|police|bureau|\bnic(si)?\b|national informatics|posts?\b|provident fund|\bepfo\b|university|institute of technology|\biit\b|vssc|\bisro\b|newspace|atomic energy|central board of direct taxes|state project director|director\b|education|health|welfare|nigam|undertaking|public financial management|registration/i,
    "",
    "Other government",
  ],
];

const normKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(the|limited|ltd|private|pvt|company|co|corp|corporation|of|india)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const TAX_BUYER =
  /commissioner|superintendent of taxes|\bgst\b|goods and services tax|tax authority|state tax|commercial taxes|income[- ]tax|indirect taxes|securities and exchange board|reserve bank|tribunal|inspector general of registration|industrial safety|large enterprise|enforcement directorate/i;
const TAX_TEXT =
  /order[- ]in[- ]original|demand (notice|order)|tax demand|penalt(y|ies)|show[- ]cause|assessment order|adjudicat|income[- ]tax act|(gst|tax) (order|demand)|appellate|arbitral award|action\(?s\)? taken or orders? passed|orders? passed (by|on)|office of the (principal |chief |joint |deputy |assistant |additional )*(commissioner|director of industrial safety)|order passed under section/i;
const AGGREGATE =
  /\bytd\b|year[- ]to[- ]date|order intake|order[- ]book|cumulative order|orders? (received|secured) so far|till date/i;
const AWARD =
  /notification of award|\bnoa\b|letter of (award|acceptance|intent)|\bloa\b|\bloi\b|purchase order|work order|contract (has been )?(signed|executed)|signed (a |the )?contract|agreement (signed|executed)|awarded/i;
const L1 = /\bl-?1\b|lowest bidder|l one bidder/i;
const JUNK_BUYER =
  /^(the )?(t ?& ?d|centre|center|office|authority|business|others?|middle east|india scheme|energy sector|renewable energy|re projects|shri|scheduled commencement.*|cy\d\d|fy\d\d|\w+ ii|[a-z]+’s|[a-z]+'s)\.?$/i;
const PLACE =
  /^(mumbai|delhi|new delhi|chennai|kolkata|bengaluru|bangalore|hyderabad|pune|uttar pradesh|gujarat|karnataka|maharashtra|rajasthan|odisha|bihar|kerala|tamil nadu|andhra pradesh|telangana|west bengal|devangonthi|barmer.*)\.?$/i;

const LT_BAND_RE = /\b(ultra[- ]?mega|mega|major|large|significant)\s*\*/i;
const LT_BAND: Record<string, readonly [string, number, number | null]> = {
  ultramega: ["Ultra-mega", 15_000, null],
  mega: ["Mega", 10_000, 15_000],
  major: ["Major", 5_000, 10_000],
  large: ["Large", 2_500, 5_000],
  significant: ["Significant", 1_000, 2_500],
};

const tidy = (s: string) =>
  s
    .replace(/\s+/g, " ")
    .replace(/\b(dear sir.*|sir\/? ?madam.*|pursuant.*|we\b.*)$/i, "")
    .replace(/[.,;:\s]+$/, "")
    .trim();

function ruleFor(text: string, notSupplier?: string): { name: string; group: BuyerGroup } | null {
  for (const [re, name, group] of RULES)
    if (re.test(text) && !(notSupplier && re.test(notSupplier))) return { name, group };
  return null;
}

const leadWords = (s: string, n: number) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, n)
    .join(" ");

const UNCLEAR = { key: "unclear", name: "Buyer not identified", group: "Unclear" as const };
const COMMON_LEAD = new Set([
  "bharat",
  "indian",
  "india",
  "national",
  "hindustan",
  "state",
  "central",
  "the",
  "new",
  "power",
  "steel",
]);
const OWN_FACILITY =
  /executed (from|through|by)|(our|its) (facility|plant|subsidiary)|wholly[- ]owned|step[- ]down subsidiary|from \w+ (usa|uk|facility)/i;

const BUYER_PHRASE =
  /(?:awarded by|(?:order|contract|loa|letter of award|notification of award)s? (?:has been |have been )?(?:received |placed |issued )?from|issued by)\s+(?:the\s+)?((?:[A-Z][\w&.'’()-]*|of|and|for|&)(?:\s+(?:[A-Z][\w&.'’()-]*|of|and|for|&)){0,9})/;

function subsequence(short: string, long: string): boolean {
  let i = 0;
  for (const ch of long) if (ch === short[i]) i++;
  return i === short.length;
}

function phraseBuyer(claim: string): string | null {
  const hit = BUYER_PHRASE.exec(claim)?.[1];
  if (!hit) return null;
  const name = tidy(hit.replace(/\s+(of|and|for|&)$/i, ""));
  return name.split(/\s+/).length >= 2 && !JUNK_BUYER.test(name) ? name : null;
}

export function classifyBuyer(raw: RawOrder): {
  key: string;
  name: string;
  group: BuyerGroup;
  recovered: boolean;
} {
  const name = tidy(raw.buyerName);
  const supplierLead = leadWords(raw.supplierName, 2);
  const supplierFirst = leadWords(raw.supplierName, 1);
  const sameGroup =
    supplierFirst.length >= 4 &&
    !COMMON_LEAD.has(supplierFirst) &&
    leadWords(name, 1) === supplierFirst;
  const selfNamed =
    (supplierLead.includes(" ") && leadWords(name, 2) === supplierLead) ||
    (/^[A-Z]{3,6}$/.test(name) && subsequence(name, raw.supplierSymbol)) ||
    (sameGroup && OWN_FACILITY.test(raw.claim));
  const junk = !name || selfNamed || JUNK_BUYER.test(name) || PLACE.test(name);
  const direct = junk ? null : ruleFor(name);
  if (direct?.name) return { key: direct.name, ...direct, recovered: false };
  if (junk) {
    const phrase = phraseBuyer(raw.claim);
    if (phrase && leadWords(phrase, 2) !== supplierLead) {
      const rule = ruleFor(phrase, raw.supplierName);
      if (rule?.name) return { key: rule.name, ...rule, recovered: true };
      return {
        key: normKey(phrase) || phrase,
        name: phrase,
        group: rule?.group ?? "Private (India)",
        recovered: true,
      };
    }
    const fromText = ruleFor(raw.claim, raw.supplierName);
    if (fromText?.name) return { key: fromText.name, ...fromText, recovered: true };
    return { ...UNCLEAR, recovered: false };
  }
  const group: BuyerGroup =
    direct?.group ??
    (raw.buyerKind === "foreign"
      ? "Overseas"
      : raw.buyerKind === "government"
        ? "Other government"
        : "Private (India)");
  return { key: normKey(name) || name, name, group, recovered: false };
}

export function orderValue(raw: RawOrder): { value: OrderValue | null; foreign: string | null } {
  if (raw.supplierSymbol === "LT") {
    const hit = LT_BAND_RE.exec(`${raw.subject ?? ""} ${raw.claim}`);
    const band = hit?.[1] ? LT_BAND[hit[1].toLowerCase().replace(/[- ]/g, "")] : undefined;
    if (!band) return { value: null, foreign: null };
    const [label, low, high] = band;
    return { value: { low, high, basis: "band", band: label }, foreign: null };
  }
  const currency = (raw.currency ?? "INR").toUpperCase();
  if (raw.valueCr == null || !(raw.valueCr > 0)) return { value: null, foreign: null };
  if (currency !== "INR") return { value: null, foreign: currency };
  return {
    value: { low: raw.valueCr, high: raw.valueCr, basis: "disclosed", band: null },
    foreign: null,
  };
}

function statusOf(raw: RawOrder): CleanOrder["status"] {
  if (raw.orderStatus === "cancelled") return "cancelled";
  const text = `${raw.subject ?? ""} ${raw.claim}`;
  if (L1.test(text) && !/letter of award|\bloa\b|notification of award/i.test(text)) return "l1";
  if (raw.orderStatus === "pending" && !AWARD.test(text)) return "l1";
  return "awarded";
}

const FAMILY_RANK: Record<string, number> = { order_filing: 0, announcement_metadata: 1 };

export function cleanOrders(rows: readonly RawOrder[]): {
  orders: CleanOrder[];
  excluded: ExcludedOrder[];
} {
  const excluded: ExcludedOrder[] = [];
  const drop = (r: RawOrder, reason: ExclusionReason) =>
    excluded.push({
      id: `o${r.observationId}`,
      date: r.publishedAt.slice(0, 10),
      supplier: r.supplierSymbol,
      buyerRaw: r.buyerName,
      valueCr: r.valueCr,
      reason,
      url: r.url,
    });
  type Row = { raw: RawOrder; order: CleanOrder };
  const byFiling = new Map<string, Row[]>();
  for (const r of rows) {
    const text = `${r.subject ?? ""} ${r.claim}`;
    if (TAX_TEXT.test(text) || (TAX_BUYER.test(r.buyerName) && !AWARD.test(text))) {
      drop(r, "tax or regulatory order, not a purchase order");
      continue;
    }
    if (AGGREGATE.test(r.claim)) {
      drop(r, "year-to-date or order-book total, not a new order");
      continue;
    }
    const buyer = classifyBuyer(r);
    const { value, foreign } = orderValue(r);
    const flags: string[] = [];
    if (buyer.recovered) flags.push("buyer read from the filing text");
    if (value?.basis === "band") flags.push(`L&T size band: ${value.band}`);
    if (foreign) flags.push(`value stated in ${foreign}, not converted`);
    const order: CleanOrder = {
      id: `o${r.observationId}`,
      date: r.publishedAt.slice(0, 10),
      supplier: r.supplierSymbol,
      supplierName: r.supplierName,
      buyerKey: buyer.key,
      buyer: buyer.name,
      buyerGroup: buyer.group,
      buyerRaw: r.buyerName,
      status: statusOf(r),
      value,
      foreignCurrency: foreign,
      subject: r.subject,
      claim: r.claim.replace(/\s+/g, " ").trim().slice(0, 400),
      url: r.url,
      flags,
    };
    const path = /^https?:\/\//.test(r.url) ? r.url.replace(/^https?:\/\/[^/]+/, "") : null;
    const key = path ? `p${path}` : r.announcementId != null ? `a${r.announcementId}` : `u${r.url}`;
    byFiling.set(key, [...(byFiling.get(key) ?? []), { raw: r, order }]);
  }
  const orders: CleanOrder[] = [];
  for (const group of byFiling.values()) {
    const sorted = [...group].sort(
      (a, b) =>
        (FAMILY_RANK[a.raw.family] ?? 9) - (FAMILY_RANK[b.raw.family] ?? 9) ||
        Number(b.order.value != null) - Number(a.order.value != null) ||
        b.raw.confidence - a.raw.confidence ||
        a.raw.observationId - b.raw.observationId,
    );
    const primary = sorted[0]?.raw.family;
    const known = sorted.some((x) => x.order.buyerGroup !== "Unclear");
    const seen = new Set<string>();
    for (const { raw, order } of sorted) {
      const unclearExtra = order.buyerGroup === "Unclear" && known;
      if (seen.has(order.buyerKey) || raw.family !== primary || unclearExtra) {
        drop(raw, "same filing read twice");
        continue;
      }
      seen.add(order.buyerKey);
      orders.push(order);
    }
  }
  orders.sort(
    (a, b) => a.date.localeCompare(b.date) || Number(b.value != null) - Number(a.value != null),
  );
  const DAY = 86_400_000;
  const kept: CleanOrder[] = [];
  const recent = new Map<string, CleanOrder[]>();
  for (const o of orders) {
    const key = `${o.supplier}|${o.buyerKey}`;
    const prior = o.buyerGroup === "Unclear" ? [] : (recent.get(key) ?? []);
    const gap = (p: CleanOrder) => Date.parse(o.date) - Date.parse(p.date);
    const repeat = prior.some((p) => {
      if (o.value?.basis === "disclosed" && p.value?.basis === "disclosed")
        return (
          Math.abs(p.value.low - o.value.low) <= Math.max(0.5, p.value.low * 0.01) &&
          gap(p) <= 120 * DAY
        );
      if (o.value?.basis === "band" && p.value?.basis === "band")
        return p.value.band === o.value.band && gap(p) <= 7 * DAY;
      return o.value == null && gap(p) <= 3 * DAY;
    });
    if (repeat) {
      excluded.push({
        id: o.id,
        date: o.date,
        supplier: o.supplier,
        buyerRaw: o.buyerRaw,
        valueCr: o.value?.low ?? null,
        reason: "repeat filing of an order already counted",
        url: o.url,
      });
      continue;
    }
    recent.set(key, [...prior, o]);
    kept.push(o);
  }
  return { orders: kept, excluded };
}
