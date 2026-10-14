import type { AircraftOverride, OwnerGroup, SymbolLink } from "./types.js";

export const BIZJET_TYPES: ReadonlySet<string> = new Set([
  "GLEX",
  "GL5T",
  "GL7T",
  "GLF4",
  "GLF5",
  "GLF6",
  "GA5C",
  "GA6C",
  "G150",
  "G280",
  "GALX",
  "F2TH",
  "FA6X",
  "FA7X",
  "FA8X",
  "F900",
  "CL30",
  "CL35",
  "CL60",
  "E35L",
  "E50P",
  "E55P",
  "H25B",
  "LJ40",
  "LJ45",
  "LJ60",
  "LJ75",
  "C25A",
  "C25B",
  "C25C",
  "C510",
  "C525",
  "C550",
  "C560",
  "C56X",
  "C680",
  "C68A",
  "C700",
  "C750",
  "PRM1",
  "PC24",
  "HDJT",
  "PC12",
  "BE20",
  "B350",
  "BE9L",
  "P180",
]);

export const CHARTER_OWNER =
  /club one|viking|air charter|zest aviation|fly-?by-?wire|mytri|indo pacific|^corporate|charter|airways|airlines|air india|indigo|interglobe|spicejet|akasa|alliance air|pawan hans|academy|flying club|flying school|flight training|government|state of|ministry|air force|border security|police|airports authority/i;

const TATA: readonly SymbolLink[] = [
  "TCS",
  "TATASTEEL",
  "TMPV",
  "TITAN",
  "TATAPOWER",
  "INDHOTEL",
  "TATACONSUM",
  "TRENT",
  "TATACOMM",
  "TATACHEM",
  "VOLTAS",
  "TATAELXSI",
  "TATAINVEST",
  "TATATECH",
].map((s) => [s, "promoter_group"] as const);

const ADANI: readonly SymbolLink[] = [
  "ADANIENT",
  "ADANIPORTS",
  "ADANIGREEN",
  "ADANIPOWER",
  "ADANIENSOL",
  "ATGL",
  "AWL",
  "AMBUJACEM",
  "ACC",
].map((s) => [s, "promoter_group"] as const);

const RELIANCE: readonly SymbolLink[] = [
  ["RELIANCE", "subsidiary"],
  ["JIOFIN", "promoter_group"],
];

const JSW: readonly SymbolLink[] = [
  ["JSWSTEEL", "promoter_group"],
  ["JSWENERGY", "promoter_group"],
  ["JSWINFRA", "promoter_group"],
];

export const OWNER_GROUPS: readonly OwnerGroup[] = [
  { pattern: /reliance (commercial dealers|transport)/i, groupName: "Reliance", links: RELIANCE },
  { pattern: /karnavati aviation|\badani\b/i, groupName: "Adani", links: ADANI },
  { pattern: /taj air|\btata\b/i, groupName: "Tata", links: TATA },
  {
    pattern: /grasim|aditya birla|hindalco|ultratech/i,
    groupName: "Aditya Birla",
    links: [
      ["GRASIM", "owner"],
      ["HINDALCO", "promoter_group"],
      ["ULTRACEMCO", "promoter_group"],
      ["ABCAPITAL", "promoter_group"],
    ],
  },
  {
    pattern: /bajaj (aviation|auto|finserv|holdings)/i,
    groupName: "Bajaj",
    links: [
      ["BAJAJ-AUTO", "promoter_group"],
      ["BAJFINANCE", "promoter_group"],
      ["BAJAJFINSV", "promoter_group"],
      ["BAJAJHLDNG", "promoter_group"],
    ],
  },
  {
    pattern: /bharat forge|kalyani/i,
    groupName: "Kalyani",
    links: [["BHARATFORG", "owner"]],
  },
  {
    pattern: /poonawalla/i,
    groupName: "Poonawalla",
    links: [["POONAWALLA", "promoter_group"]],
  },
  {
    pattern: /sanjiv goenka|\brpsg\b|\bcesc\b/i,
    groupName: "RPSG",
    links: [
      ["CESC", "promoter_group"],
      ["PCBL", "promoter_group"],
    ],
  },
  { pattern: /\bmrf\b/i, groupName: "MRF", links: [["MRF", "owner"]] },
  {
    pattern: /larsen|l ?& ?t aviation/i,
    groupName: "L&T",
    links: [
      ["LT", "subsidiary"],
      ["LTTS", "promoter_group"],
      ["LTF", "promoter_group"],
    ],
  },
  {
    pattern: /jindal steel/i,
    groupName: "Jindal (JSPL)",
    links: [["JINDALSTEL", "owner"]],
  },
  { pattern: /\bjsw\b|sapphire airlines|jindal south west/i, groupName: "JSW", links: JSW },
  { pattern: /sun tv/i, groupName: "Sun Group", links: [["SUNTV", "owner"]] },
  {
    pattern: /ashley aviation|hinduja/i,
    groupName: "Hinduja",
    links: [
      ["ASHOKLEY", "promoter_group"],
      ["INDUSINDBK", "promoter_group"],
    ],
  },
  { pattern: /\bgmr\b/i, groupName: "GMR", links: [["GMRAIRPORT", "subsidiary"]] },
  {
    pattern: /vedanta|sterlite|hindustan zinc/i,
    groupName: "Vedanta",
    links: [
      ["VEDL", "owner"],
      ["HINDZINC", "promoter_group"],
    ],
  },
  { pattern: /mahindra/i, groupName: "Mahindra", links: [["M&M", "owner"]] },
  { pattern: /bharti/i, groupName: "Bharti", links: [["BHARTIARTL", "promoter_group"]] },
  { pattern: /hero motocorp|hero fincorp/i, groupName: "Hero", links: [["HEROMOTOCO", "owner"]] },
  {
    pattern: /godrej/i,
    groupName: "Godrej",
    links: [
      ["GODREJIND", "promoter_group"],
      ["GODREJCP", "promoter_group"],
      ["GODREJPROP", "promoter_group"],
    ],
  },
  { pattern: /\blupin\b/i, groupName: "Lupin", links: [["LUPIN", "owner"]] },
  { pattern: /sun pharma/i, groupName: "Sun Pharma", links: [["SUNPHARMA", "owner"]] },
  { pattern: /zydus|cadila/i, groupName: "Zydus", links: [["ZYDUSLIFE", "owner"]] },
  {
    pattern: /piramal/i,
    groupName: "Piramal",
    links: [
      ["PIRAMALFIN", "promoter_group"],
      ["PPLPHARMA", "promoter_group"],
    ],
  },
  {
    pattern: /torrent/i,
    groupName: "Torrent",
    links: [
      ["TORNTPHARM", "promoter_group"],
      ["TORNTPOWER", "promoter_group"],
    ],
  },
  { pattern: /\bwipro\b/i, groupName: "Wipro", links: [["WIPRO", "owner"]] },
  { pattern: /\bdabur\b|burman/i, groupName: "Burman", links: [["DABUR", "promoter_group"]] },
  { pattern: /\bitc\b/i, groupName: "ITC", links: [["ITC", "owner"]] },
  {
    pattern: /\bdlf\b/i,
    groupName: "DLF",
    links: [["DLF", "owner"]],
  },
];

export const AIRCRAFT_OVERRIDES: readonly AircraftOverride[] = [
  {
    registration: "VT-AKV",
    action: "link",
    groupName: "Reliance",
    links: RELIANCE,
    ownerName: "Reliance Commercial Dealers Ltd",
    sourceUrl:
      "https://aviationa2z.com/index.php/2024/09/15/mukesh-ambani-boeing-737-max-registered-vt-akv/",
    note: "Boeing 737 MAX 9 BBJ registered in India in Sep 2024, ex T7-LOTUS",
  },
  {
    registration: "VT-ASR",
    action: "link",
    groupName: "Reliance",
    links: RELIANCE,
    ownerName: "Reliance Commercial Dealers Ltd",
    sourceUrl: "https://www.celebplanes.com/celebrity/mukesh-ambani",
    note: "Global 7500 not resolved by adsbdb; press attributes it to Reliance Commercial Dealers",
  },
  {
    registration: "VT-IAH",
    action: "link",
    groupName: "Reliance",
    links: RELIANCE,
    ownerName: "Reliance Commercial Dealers Ltd",
    sourceUrl: "https://api.adsbdb.com/v0/aircraft/VT-IAH",
    note: "Airbus A319 corporate jet; airliner type so it is outside the business-jet candidate filter",
  },
  {
    registration: "VT-JSJ",
    action: "link",
    groupName: "JSW",
    links: JSW,
    ownerName: "Sapphire Airlines Pvt Ltd",
    sourceUrl: "https://www.jsw.in/sapphire-airlines-pvt-ltd/",
    note: "JSW group aviation arm lists VT-JSJ in its fleet",
  },
];
