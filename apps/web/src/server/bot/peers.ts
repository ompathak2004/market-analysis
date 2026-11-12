import type { VizFormat } from "@ma/agent";
import { median, type PeerMetrics } from "../queries/bot";
import type { ChartBase } from "./charts";
import { r2 } from "./charts";

export interface PeerComparison {
  line: string;
  rows: Array<Record<string, string | number | null>>;
  table: {
    base: ChartBase;
    columns: Array<{ key: string; label: string; format: VizFormat; tone?: boolean }>;
    rows: Array<Record<string, string | number | null>>;
  };
}

const fmt = (v: number | null, unit = "") => (v == null ? "n/a" : `${r2(v)}${unit}`);

export function peerComparison(
  symbol: string,
  sector: string | null,
  peers: readonly PeerMetrics[],
): PeerComparison | null {
  const self = peers.find((p) => p.self);
  const others = peers.filter((p) => !p.self);
  if (!self || !others.length) return null;
  const financial = sector === "Financial Services";
  const med = {
    pe: median(others.map((p) => p.peLatestFy)),
    roe: median(others.map((p) => p.roePct)),
    opm: financial ? null : median(others.map((p) => p.opmPct)),
    growth: median(others.map((p) => p.revenueGrowthPct)),
  };
  const rows = [self, ...others].map((p) => ({
    symbol: p.self ? `${p.symbol} ◆` : p.symbol,
    mcap: r2(p.marketCapCr),
    pe: r2(p.peLatestFy),
    roe: r2(p.roePct),
    opm: financial ? null : r2(p.opmPct),
    growth: r2(p.revenueGrowthPct),
  }));
  rows.push({
    symbol: "Peer median",
    mcap: r2(median(others.map((p) => p.marketCapCr))),
    pe: r2(med.pe),
    roe: r2(med.roe),
    opm: r2(med.opm),
    growth: r2(med.growth),
  });
  const industry = self.industry ?? sector ?? "industry";
  const line = `Peers (${others.length} listed ${industry} companies closest in size, latest FY statements): ${symbol} P/E ${fmt(self.peLatestFy)} vs peer median ${fmt(med.pe)}, ROE ${fmt(self.roePct, "%")} vs ${fmt(med.roe, "%")}${financial ? "" : `, operating margin ${fmt(self.opmPct, "%")} vs ${fmt(med.opm, "%")}`}, revenue growth ${fmt(self.revenueGrowthPct, "%")} vs ${fmt(med.growth, "%")}; peers: ${others.map((p) => p.symbol).join(", ")}`;
  return {
    line,
    rows,
    table: {
      base: {
        title: `${symbol} vs ${industry} peers`,
        asOf: self.latestFy,
        source: "Latest annual statements and market cap",
        notes: [
          "P/E on latest full-year profit; peers are the closest in market cap within the industry",
          ...(financial ? ["Operating margin is not meaningful for lenders and is omitted"] : []),
        ],
      },
      columns: [
        { key: "symbol", label: "Company", format: "text" },
        { key: "mcap", label: "Mkt cap Cr", format: "num" },
        { key: "pe", label: "P/E", format: "num" },
        { key: "roe", label: "ROE %", format: "num" },
        ...(financial ? [] : [{ key: "opm", label: "OPM %", format: "num" as const }]),
        { key: "growth", label: "Rev growth %", format: "pct", tone: true },
      ],
      rows,
    },
  };
}
