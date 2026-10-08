import type { Chokepoint, DealHub } from "./types.js";

export const DEAL_HUBS: readonly DealHub[] = [
  { icao: "OERK", city: "Riyadh", region: "Gulf", theme: "sovereign_capital" },
  { icao: "OEJN", city: "Jeddah", region: "Gulf", theme: "sovereign_capital" },
  { icao: "OMAA", city: "Abu Dhabi", region: "Gulf", theme: "sovereign_capital" },
  { icao: "OMAD", city: "Abu Dhabi", region: "Gulf", theme: "sovereign_capital" },
  { icao: "OMDB", city: "Dubai", region: "Gulf", theme: "sovereign_capital" },
  { icao: "OMDW", city: "Dubai", region: "Gulf", theme: "sovereign_capital" },
  { icao: "OTHH", city: "Doha", region: "Gulf", theme: "sovereign_capital" },
  { icao: "OTBD", city: "Doha", region: "Gulf", theme: "sovereign_capital" },
  { icao: "EGLL", city: "London", region: "London", theme: "financial_center" },
  { icao: "EGLF", city: "London", region: "London", theme: "financial_center" },
  { icao: "EGGW", city: "London", region: "London", theme: "financial_center" },
  { icao: "EGLC", city: "London", region: "London", theme: "financial_center" },
  { icao: "EGKB", city: "London", region: "London", theme: "financial_center" },
  { icao: "KJFK", city: "New York", region: "New York", theme: "financial_center" },
  { icao: "KTEB", city: "New York", region: "New York", theme: "financial_center" },
  { icao: "KHPN", city: "New York", region: "New York", theme: "financial_center" },
  { icao: "LSZH", city: "Zurich", region: "Switzerland", theme: "financial_center" },
  { icao: "LSGG", city: "Geneva", region: "Switzerland", theme: "financial_center" },
  { icao: "WSSS", city: "Singapore", region: "Singapore", theme: "financial_center" },
  { icao: "WSSL", city: "Singapore", region: "Singapore", theme: "financial_center" },
  { icao: "VHHH", city: "Hong Kong", region: "Hong Kong", theme: "financial_center" },
  { icao: "RJTT", city: "Tokyo", region: "Tokyo", theme: "financial_center" },
  { icao: "LFPB", city: "Paris", region: "Paris", theme: "financial_center" },
  { icao: "VIDP", city: "New Delhi", region: "Delhi", theme: "regulatory_capital" },
];

export const CHOKEPOINTS: readonly Chokepoint[] = [
  {
    slug: "hormuz",
    name: "Strait of Hormuz",
    box: [
      [25.6, 55.8],
      [27.0, 57.3],
    ],
    theme: "crude",
  },
  {
    slug: "fujairah_anchorage",
    name: "Fujairah anchorage",
    box: [
      [24.9, 56.3],
      [25.6, 56.8],
    ],
    theme: "crude",
  },
  {
    slug: "bab_el_mandeb",
    name: "Bab-el-Mandeb",
    box: [
      [11.5, 42.5],
      [13.8, 44.2],
    ],
    theme: "red_sea",
  },
  {
    slug: "gulf_of_aden",
    name: "Gulf of Aden",
    box: [
      [11.0, 44.0],
      [14.0, 51.0],
    ],
    theme: "red_sea",
  },
  {
    slug: "suez",
    name: "Suez Canal",
    box: [
      [29.6, 32.2],
      [31.6, 32.9],
    ],
    theme: "red_sea",
  },
  {
    slug: "malacca_north",
    name: "Strait of Malacca (north)",
    box: [
      [2.5, 99.5],
      [5.8, 102.5],
    ],
    theme: "east_asia",
  },
  {
    slug: "singapore_strait",
    name: "Singapore Strait",
    box: [
      [1.0, 102.5],
      [3.0, 104.5],
    ],
    theme: "east_asia",
  },
  {
    slug: "lombok",
    name: "Lombok Strait",
    box: [
      [-9.0, 115.5],
      [-8.2, 116.1],
    ],
    theme: "east_asia",
  },
  {
    slug: "cape",
    name: "Cape of Good Hope",
    box: [
      [-36.0, 16.5],
      [-33.5, 21.0],
    ],
    theme: "atlantic",
  },
  {
    slug: "gulf_of_kutch",
    name: "Gulf of Kutch approach",
    box: [
      [22.2, 68.4],
      [23.0, 69.6],
    ],
    theme: "india_west",
  },
];
