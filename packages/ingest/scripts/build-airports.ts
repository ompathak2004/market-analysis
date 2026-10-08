import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const input = process.argv[2];
if (!input) {
  console.error("usage: build-airports <ourairports airports.csv>");
  process.exit(1);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

const [header, ...rows] = parseCsv(readFileSync(input, "utf8"));
if (!header) throw new Error("empty csv");
const col = (name: string) => header.indexOf(name);
const SIZE: Record<string, string> = {
  large_airport: "L",
  medium_airport: "M",
  small_airport: "S",
};

const out = rows
  .filter((r) => {
    if (!/^[A-Z0-9]{3,4}$/.test(r[col("ident")] ?? "")) return false;
    const type = r[col("type")] ?? "";
    if (type === "large_airport" || type === "medium_airport") return true;
    return r[col("iso_country")] === "IN" && type === "small_airport";
  })
  .map((r) => [
    r[col("ident")] ?? "",
    r[col("iata_code")] || null,
    Math.round(Number(r[col("latitude_deg")]) * 1e4),
    Math.round(Number(r[col("longitude_deg")]) * 1e4),
    (r[col("municipality")] || r[col("name")] || "").slice(0, 48),
    r[col("iso_country")] ?? "",
    SIZE[r[col("type")] ?? ""] ?? "S",
  ])
  .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

const lines = out.map((r) => `  [${r.map((v) => JSON.stringify(v)).join(", ")}],`);
const body = [
  'import type { AirportRow } from "./types.js";',
  "",
  "export const AIRPORT_ROWS: readonly AirportRow[] = [",
  ...lines,
  "];",
  "",
].join("\n");
const target = path.join(import.meta.dirname, "../src/data/airports.ts");
writeFileSync(target, body);
console.log(`wrote ${out.length} airports to ${target}`);
