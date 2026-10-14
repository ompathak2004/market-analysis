import { type CounterpartyKind, normalizeCompanyName } from "../extract/relationships.js";

export const GROUP_ALIASES: Readonly<Record<string, readonly string[]>> = {
  RELIANCE: [
    "reliance jio",
    "jio platforms",
    "jio infocomm",
    "reliance retail",
    "reliance industries limited",
  ],
  BHARTIARTL: ["airtel", "bharti airtel"],
  TATAMOTORS: ["tata motors", "jaguar land rover"],
  MARUTI: ["maruti suzuki", "maruti"],
  ADANIENT: ["adani enterprises"],
  HINDALCO: ["novelis"],
  TATASTEEL: ["tata steel"],
  LT: ["larsen & toubro", "larsen and toubro", "l&t"],
  "M&M": ["mahindra & mahindra", "mahindra and mahindra"],
  BAJAJ_AUTO: ["bajaj auto"],
  HEROMOTOCO: ["hero motocorp"],
  EICHERMOT: ["royal enfield"],
  ONGC: ["oil and natural gas corporation", "oil & natural gas corporation"],
  IOC: ["indian oil corporation", "indianoil"],
  BPCL: ["bharat petroleum"],
  HINDPETRO: ["hindustan petroleum"],
  POWERGRID: ["power grid corporation of india", "powergrid"],
  BEL: ["bharat electronics"],
  HAL: ["hindustan aeronautics"],
  BHEL: ["bharat heavy electricals"],
  SAIL: ["steel authority of india"],
  GAIL: ["gail (india)", "gail india"],
};

export const COMPANY_GROUPS: Readonly<Record<string, readonly string[]>> = {
  reliance: ["RELIANCE", "JIOFIN", "NETWORK18", "TV18BRDCST", "RIIL"],
  tata: [
    "TCS",
    "TATAMOTORS",
    "TMPV",
    "TMCV",
    "TATASTEEL",
    "TATAPOWER",
    "TATACONSUM",
    "TATACOMM",
    "TATAELXSI",
    "TATACHEM",
    "TATATECH",
    "TATAINVEST",
    "TITAN",
    "TRENT",
    "VOLTAS",
    "INDHOTEL",
    "RALLIS",
    "NELCO",
    "TTML",
  ],
  adani: [
    "ADANIENT",
    "ADANIPORTS",
    "ADANIGREEN",
    "ADANIPOWER",
    "ADANIENSOL",
    "ATGL",
    "AWL",
    "AMBUJACEM",
    "ACC",
    "NDTV",
  ],
  bharti: ["BHARTIARTL", "BHARTIHEXA", "INDUSTOWER"],
  "aditya-birla": ["HINDALCO", "GRASIM", "ULTRACEMCO", "ABCAPITAL", "ABFRL", "IDEA", "ABSLAMC"],
  "larsen-toubro": ["LT", "LTIM", "LTTS", "LTF"],
  bajaj: ["BAJAJ-AUTO", "BAJFINANCE", "BAJAJFINSV", "BAJAJHLDNG", "BAJAJHFL"],
  mahindra: ["M&M", "TECHM", "MAHLIFE", "MHRIL", "M&MFIN"],
  jsw: ["JSWSTEEL", "JSWENERGY", "JSWINFRA"],
  hdfc: ["HDFCBANK", "HDFCLIFE", "HDFCAMC"],
  icici: ["ICICIBANK", "ICICIPRULI", "ICICIGI"],
  sbi: ["SBIN", "SBILIFE", "SBICARD"],
  vedanta: ["VEDL", "HINDZINC"],
  motherson: ["MOTHERSON", "MSUMI"],
  tvs: ["TVSMOTOR", "TVSSCS", "SUNDRMFAST"],
  godrej: ["GODREJCP", "GODREJPROP", "GODREJIND", "GODREJAGRO"],
  murugappa: ["CHOLAFIN", "CHOLAHLDNG", "TIINDIA", "COROMANDEL", "CARBORUNIV"],
  ntpc: ["NTPC", "NTPCGREEN"],
  ongc: ["ONGC", "HINDPETRO", "MRPL"],
  indianoil: ["IOC", "CHENNPETRO"],
  hinduja: ["ASHOKLEY", "HINDUJAGL", "INDUSINDBK", "GOCLCORP"],
  wadia: ["BRITANNIA", "BOMDYEING", "BBTC"],
  kalyani: ["BHARATFORG", "KALYANIFRG", "BFUTILITIE"],
  piramal: ["PEL", "PPLPHARMA"],
  rpsg: ["CESC", "PCBL", "FSL", "SPENCERS"],
  jk: ["JKTYRE", "JKCEMENT", "JKLAKSHMI", "JKPAPER"],
  siemens: ["SIEMENS", "ENRIN"],
  torrent: ["TORNTPHARM", "TORNTPOWER"],
  max: ["MAXHEALTH", "MFSL", "MAXESTATES"],
  zydus: ["ZYDUSLIFE", "ZYDUSWELL"],
  kirloskar: ["KIRLOSENG", "KIRLOSBROS", "KIRLPNU", "KIRLOSIND"],
};

export interface CuratedCounterparty {
  name: string;
  kind: CounterpartyKind;
  country: string | null;
  aliases: readonly string[];
  symbols: readonly string[];
}

const ZONAL_RAILWAYS = [
  "central railway",
  "western railway",
  "northern railway",
  "southern railway",
  "eastern railway",
  "south central railway",
  "south eastern railway",
  "south western railway",
  "north central railway",
  "north eastern railway",
  "north western railway",
  "east central railway",
  "east coast railway",
  "west central railway",
  "northeast frontier railway",
  "south east central railway",
];

export const CURATED_COUNTERPARTIES: readonly CuratedCounterparty[] = [
  {
    name: "National Highways Authority of India",
    kind: "government",
    country: "IN",
    aliases: ["national highways authority of india"],
    symbols: ["NHAI"],
  },
  {
    name: "Indian Railways",
    kind: "government",
    country: "IN",
    aliases: ["indian railways", "ministry of railways", "railway board", ...ZONAL_RAILWAYS],
    symbols: [],
  },
  {
    name: "Ministry of Defence",
    kind: "government",
    country: "IN",
    aliases: ["ministry of defence", "indian army", "indian navy", "indian air force"],
    symbols: [],
  },
  {
    name: "Ministry of Road Transport and Highways",
    kind: "government",
    country: "IN",
    aliases: ["ministry of road transport and highways", "ministry of road transport & highways"],
    symbols: ["MORTH"],
  },
  {
    name: "Dedicated Freight Corridor Corporation of India",
    kind: "government",
    country: "IN",
    aliases: ["dedicated freight corridor corporation of india"],
    symbols: ["DFCCIL"],
  },
  {
    name: "National Highways and Infrastructure Development Corporation",
    kind: "government",
    country: "IN",
    aliases: ["national highways and infrastructure development corporation"],
    symbols: ["NHIDCL"],
  },
  {
    name: "Delhi Metro Rail Corporation",
    kind: "government",
    country: "IN",
    aliases: ["delhi metro rail corporation"],
    symbols: ["DMRC"],
  },
  {
    name: "National Capital Region Transport Corporation",
    kind: "government",
    country: "IN",
    aliases: ["national capital region transport corporation"],
    symbols: ["NCRTC"],
  },
  {
    name: "Bharat Sanchar Nigam",
    kind: "government",
    country: "IN",
    aliases: ["bharat sanchar nigam"],
    symbols: ["BSNL"],
  },
  {
    name: "Defence Research and Development Organisation",
    kind: "government",
    country: "IN",
    aliases: ["defence research and development organisation"],
    symbols: ["DRDO"],
  },
  {
    name: "Indian Space Research Organisation",
    kind: "government",
    country: "IN",
    aliases: ["indian space research organisation"],
    symbols: ["ISRO"],
  },
  {
    name: "Nuclear Power Corporation of India",
    kind: "government",
    country: "IN",
    aliases: ["nuclear power corporation of india"],
    symbols: ["NPCIL"],
  },
  {
    name: "Airports Authority of India",
    kind: "government",
    country: "IN",
    aliases: ["airports authority of india"],
    symbols: [],
  },
  {
    name: "Central Public Works Department",
    kind: "government",
    country: "IN",
    aliases: ["central public works department"],
    symbols: ["CPWD"],
  },
];

export function aliasesFor(name: string, nseSymbol: string | null): string[] {
  const base = normalizeCompanyName(name);
  const out = new Set<string>([base, ...(nseSymbol ? (GROUP_ALIASES[nseSymbol] ?? []) : [])]);
  const noIndia = base.replace(/\s+\(?india\)?$/, "");
  if (noIndia !== base && noIndia.split(" ").length >= 2) out.add(noIndia);
  return [...out];
}

export function symbolAliasesFor(nseSymbol: string | null): string[] {
  return nseSymbol && /^[A-Z]{3,12}$/.test(nseSymbol) ? [nseSymbol] : [];
}

const GROUP_OF = new Map(
  Object.entries(COMPANY_GROUPS).flatMap(([group, symbols]) =>
    symbols.map((symbol) => [symbol, group] as const),
  ),
);

export function groupKeyFor(nseSymbol: string | null): string | null {
  return nseSymbol ? (GROUP_OF.get(nseSymbol) ?? null) : null;
}
