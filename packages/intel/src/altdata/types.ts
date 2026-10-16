export const TRAVEL_MODEL_VERSION = 2;
export const LOGISTICS_MODEL_VERSION = 2;

export const TRAVEL_SIGNAL_KINDS = [
  "travel_legs_7d",
  "travel_frequency_anomaly",
  "travel_new_destination",
  "travel_deal_hub_cluster",
  "travel_counterparty_visit",
  "travel_colocation",
  "travel_event_window",
  "travel_coverage",
  "travel_operating_site_arrivals_30d",
] as const;
export type TravelSignalKind = (typeof TRAVEL_SIGNAL_KINDS)[number];

export const LOGISTICS_SIGNAL_KINDS = [
  "logistics_arrivals_7d",
  "logistics_throughput_proxy",
  "logistics_chokepoint_exposure",
  "logistics_port_congestion",
  "logistics_export_departures_7d",
  "logistics_fleet_activity",
  "logistics_coverage",
  "logistics_dwell_change",
] as const;
export type LogisticsSignalKind = (typeof LOGISTICS_SIGNAL_KINDS)[number];

export type AltdataEvidenceKind =
  | "leg"
  | "position"
  | "vessel"
  | "call"
  | "transit"
  | "announcement";

export interface AltdataEvidence {
  kind: AltdataEvidenceKind;
  id: number | string;
  label: string;
  at: string;
  url?: string;
}

export interface AltdataSignalInputs {
  read: string;
  confidence: number;
  evidence: AltdataEvidence[];
  window: { from: string; to: string };
  baseline?: { from: string; to: string; mean: number; std: number };
  [extra: string]: unknown;
}

export interface AltdataSignal {
  kind: TravelSignalKind | LogisticsSignalKind;
  asOf: string;
  value: number | null;
  inputs: AltdataSignalInputs;
}
