import { sha256 } from "@ma/core";
import type { PolicyDocument } from "@ma/ingest";
import { INFLUENCE_EVENT_RULE_VERSION } from "./rules.js";

export function eventInputHash(key: readonly (string | number | null)[]): string {
  return sha256([INFLUENCE_EVENT_RULE_VERSION, ...key].join("|"));
}

export function policyInputHash(doc: PolicyDocument, parserVersion: number): string {
  return sha256(
    JSON.stringify([
      parserVersion,
      doc.source,
      doc.externalId,
      doc.title,
      doc.ministry,
      doc.stage,
      doc.publishedAt.toISOString(),
      doc.text,
    ]),
  );
}

export interface OfficeState {
  key: string;
  personId: number;
  label: string;
  status: "current" | "past";
}

export interface OfficeChanges {
  gained: OfficeState[];
  lost: OfficeState[];
}

export function officeChanges(
  previous: readonly OfficeState[],
  current: readonly OfficeState[],
): OfficeChanges {
  const before = new Map(previous.map((p) => [p.key, p]));
  const now = new Set(current.map((c) => c.key));
  const gained = current.filter((c) => {
    const p = before.get(c.key);
    return c.status === "current" && (!p || p.status === "past");
  });
  const lost = previous.filter((p) => p.status === "current" && !now.has(p.key));
  return { gained, lost };
}
