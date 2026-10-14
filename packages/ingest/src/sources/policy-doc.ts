import { type LineSnapshot, lineSnapshot } from "./html.js";

export type PolicySource = "pib" | "egazette" | "prs";

export const POLICY_TEXT_CHARS = 20_000;

export interface PolicyDocument {
  source: PolicySource;
  externalId: string;
  title: string;
  ministry: string | null;
  stage: string | null;
  publishedAt: Date;
  url: string;
  text: string;
}

export const POLICY_LINES = ["title", "ministry", "stage", "text"] as const;
export type PolicyLine = (typeof POLICY_LINES)[number];

export function policySnapshot(d: PolicyDocument, parserVersion: number): LineSnapshot {
  const values: Record<PolicyLine, string | null> = {
    title: d.title,
    ministry: d.ministry,
    stage: d.stage,
    text: d.text.slice(0, POLICY_TEXT_CHARS),
  };
  return lineSnapshot(
    {
      source: d.source,
      parserVersion,
      externalId: d.externalId,
      url: d.url,
      publishedAt: d.publishedAt.toISOString(),
    },
    POLICY_LINES.filter((k) => values[k]),
    (k) => k,
    (k) => ({ value: values[k] }),
  );
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

export function monthNumber(name: string): number | null {
  return MONTHS[name.slice(0, 3).toLowerCase()] ?? null;
}

export function istTimestamp(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date | null {
  if (!year || !month || !day || month > 12 || day > 31) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
}
