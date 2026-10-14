export const POLICY_SECTOR_MAP_VERSION = 1;

export interface PolicySectorDef {
  key: string;
  label: string;
  ministryKeys: readonly string[];
  industryTerms: readonly string[];
}

export const POLICY_SECTORS: readonly PolicySectorDef[] = [
  {
    key: "banking_finance",
    label: "Banking & financial services",
    ministryKeys: ["finance", "financial services", "economic affairs"],
    industryTerms: ["financial services", "bank", "finance", "insurance", "capital markets"],
  },
  {
    key: "it_telecom",
    label: "IT, electronics & telecom",
    ministryKeys: [
      "electronics and information technology",
      "communications",
      "telecommunications",
    ],
    industryTerms: ["information technology", "it - software", "computers", "telecom"],
  },
  {
    key: "oil_gas",
    label: "Oil & gas",
    ministryKeys: ["petroleum and natural gas"],
    industryTerms: ["oil gas", "oil, gas", "refineries", "petroleum", "gas transmission", "lpg"],
  },
  {
    key: "power",
    label: "Power & renewables",
    ministryKeys: ["power", "new and renewable energy"],
    industryTerms: ["power", "utilities", "electric utilities", "renewable"],
  },
  {
    key: "coal_mining",
    label: "Coal & mining",
    ministryKeys: ["coal", "mines"],
    industryTerms: ["coal", "mining", "minerals", "metals & mining", "aluminium", "zinc"],
  },
  {
    key: "steel_metals",
    label: "Steel & metals",
    ministryKeys: ["steel"],
    industryTerms: ["iron & steel", "steel", "ferrous", "non - ferrous", "metals"],
  },
  {
    key: "automobiles",
    label: "Automobiles & components",
    ministryKeys: ["heavy industries", "road transport and highways"],
    industryTerms: ["automobile", "auto components", "passenger cars", "2/3 wheelers", "tyres"],
  },
  {
    key: "infrastructure",
    label: "Infrastructure & construction",
    ministryKeys: ["road transport and highways", "housing and urban affairs", "railways"],
    industryTerms: ["construction", "civil construction", "infrastructure", "cement", "realty"],
  },
  {
    key: "transport_logistics",
    label: "Transport & logistics",
    ministryKeys: ["civil aviation", "ports shipping and waterways", "railways"],
    industryTerms: ["airline", "port", "shipping", "logistics", "railway"],
  },
  {
    key: "pharma_health",
    label: "Pharmaceuticals & healthcare",
    ministryKeys: ["health and family welfare", "pharmaceuticals", "ayush"],
    industryTerms: ["healthcare", "pharmaceutical", "hospital", "diagnostic"],
  },
  {
    key: "chemicals_fertilisers",
    label: "Chemicals & fertilisers",
    ministryKeys: ["chemicals and fertilizers", "fertilizers", "chemicals and petrochemicals"],
    industryTerms: ["chemicals", "fertilizer", "fertiliser", "agrochemical", "petrochemical"],
  },
  {
    key: "fmcg_agri",
    label: "FMCG, food & agriculture",
    ministryKeys: [
      "agriculture and farmers welfare",
      "food processing industries",
      "consumer affairs food and public distribution",
      "food and public distribution",
      "consumer affairs",
    ],
    industryTerms: [
      "fast moving consumer goods",
      "fmcg",
      "food",
      "agricultural",
      "tobacco",
      "sugar",
    ],
  },
  {
    key: "textiles",
    label: "Textiles",
    ministryKeys: ["textiles"],
    industryTerms: ["textile", "apparel"],
  },
  {
    key: "defence",
    label: "Defence & aerospace",
    ministryKeys: ["defence", "defence production"],
    industryTerms: ["defence", "aerospace"],
  },
  {
    key: "media",
    label: "Media & entertainment",
    ministryKeys: ["information and broadcasting"],
    industryTerms: ["media", "entertainment", "broadcasting", "publication"],
  },
  {
    key: "consumer_retail",
    label: "Consumer & retail",
    ministryKeys: ["commerce and industry", "promotion of industry and internal trade"],
    industryTerms: ["consumer durables", "consumer services", "retail", "diversified retail"],
  },
];

const POLICY_SECTOR_KEYS = new Set(POLICY_SECTORS.map((s) => s.key));

export function isPolicySectorKey(key: string): boolean {
  return POLICY_SECTOR_KEYS.has(key);
}

export function ministryKey(raw: string | null | undefined): string | null {
  const key = (raw ?? "")
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/&/g, " and ")
    .replace(/\b(?:union\s+)?(?:ministry|department)\s+of\s+/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return key || null;
}

export function sectorsForMinistry(raw: string | null | undefined): string[] {
  const key = ministryKey(raw);
  if (!key) return [];
  return POLICY_SECTORS.filter((s) => s.ministryKeys.includes(key)).map((s) => s.key);
}

export function sectorsForIndustry(...labels: readonly (string | null | undefined)[]): string[] {
  const text = labels
    .filter((l): l is string => Boolean(l))
    .map((l) => l.toLowerCase())
    .join(" | ");
  if (!text) return [];
  const out: string[] = [];
  for (const s of POLICY_SECTORS) {
    if (s.industryTerms.some((t) => new RegExp(`(?:^|[^a-z])${escapeTerm(t)}`).test(text))) {
      out.push(s.key);
    }
  }
  return out;
}

const escapeTerm = (t: string) => t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
