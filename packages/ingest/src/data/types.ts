export type AirportSize = "L" | "M" | "S";

export type AirportRow = readonly [
  icao: string,
  iata: string | null,
  latE4: number,
  lonE4: number,
  city: string,
  country: string,
  size: AirportSize,
];

export interface Airport {
  icao: string;
  iata: string | null;
  lat: number;
  lon: number;
  city: string;
  country: string;
  size: AirportSize;
}

export type DealHubTheme = "sovereign_capital" | "financial_center" | "regulatory_capital";

export interface DealHub {
  icao: string;
  city: string;
  region: string;
  theme: DealHubTheme;
}

export type Box = readonly [readonly [latMin: number, lonMin: number], readonly [number, number]];

export interface Chokepoint {
  slug: string;
  name: string;
  box: Box;
  theme: string;
}

export type FacilityKindSeed =
  | "hq"
  | "refinery"
  | "spm"
  | "port"
  | "terminal"
  | "lng_terminal"
  | "plant"
  | "mine"
  | "sez"
  | "power_plant"
  | "jetty";

export interface FacilitySeed {
  slug: string;
  name: string;
  kind: FacilityKindSeed;
  lat: number;
  lon: number;
  radiusKm: number;
  locode: string | null;
  stateCode?: string;
  jurisdictionSourceUrl?: string;
  aliases: string[];
  exclusive: boolean;
  active: boolean;
  companies: Array<{
    symbol: string;
    role: "owner" | "operator" | "user";
    commodityIn: string[];
    commodityOut: string[];
    note?: string;
  }>;
}

export type AircraftLinkBasisSeed = "owner" | "subsidiary" | "promoter_group" | "charter";

export type SymbolLink = readonly [symbol: string, basis: AircraftLinkBasisSeed];

export interface OwnerGroup {
  pattern: RegExp;
  groupName: string;
  links: readonly SymbolLink[];
}

export interface AircraftOverride {
  registration: string;
  action: "link" | "unlink" | "deactivate";
  groupName?: string;
  links?: readonly SymbolLink[];
  ownerName?: string;
  linkedPerson?: string;
  linkedRole?: string;
  sourceUrl: string;
  note: string;
}
