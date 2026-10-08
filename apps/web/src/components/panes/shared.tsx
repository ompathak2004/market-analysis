import type { VerdictLabel } from "@ma/intel";
import type { ReactNode } from "react";
import { Badge, type ChipTone } from "@/components/ui/chip";
import { errorCode, Unavailable } from "@/components/ui/empty";
import { Pane } from "@/components/ui/pane";
import { ACTION_LABEL, istTime, shortDate } from "@/lib/format";

export type Loaded<T> = { ok: true; data: T } | { ok: false; code: string };

export async function attempt<T>(p: Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await p };
  } catch (err) {
    console.error("[pane]", err);
    return { ok: false, code: errorCode(err) };
  }
}

export function PaneError({
  id,
  title,
  area,
  code,
  source,
}: {
  id: string;
  title: ReactNode;
  area?: string;
  code: string;
  source?: string;
}) {
  return (
    <Pane id={id} title={title} meta="error" {...(area ? { area } : {})} pad>
      <Unavailable code={code}>
        {source ? `${source} did not answer. ` : ""}The pane retries on the next refresh.
      </Unavailable>
    </Pane>
  );
}

const VERDICT_TONE: Record<VerdictLabel, ChipTone> = {
  bearish: "neg",
  cautious: "warn",
  neutral: "info",
  constructive: "pos",
  bullish: "pos",
};

export function verdictTone(label: VerdictLabel): ChipTone {
  return VERDICT_TONE[label] ?? "info";
}

export function VerdictBadge({ label, score }: { label: VerdictLabel; score?: number | null }) {
  return (
    <Badge tone={verdictTone(label)}>
      {label.toUpperCase()}
      {score != null ? ` ${Math.round(score)}` : ""}
    </Badge>
  );
}

const ACTION_TONE: Record<string, ChipTone> = {
  upgrade: "pos",
  raise_target: "pos",
  initiate: "info",
  downgrade: "neg",
  lower_target: "neg",
};

export function ActionBadge({ action }: { action: string }) {
  return (
    <Badge tone={ACTION_TONE[action] ?? "neu"}>
      {ACTION_LABEL[action] ?? action.toUpperCase()}
    </Badge>
  );
}

export function ratingTone(rating: string): "pos" | "neg" | "neu" {
  const r = rating.toLowerCase();
  if (/sell|reduce|underperform|underweight/.test(r)) return "neg";
  if (/buy|outperform|accumulate|add|overweight/.test(r)) return "pos";
  return "neu";
}

export function asOf(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = typeof v === "string" ? new Date(v) : v;
  const today = new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10) === today ? `${istTime(d)} IST` : shortDate(d);
}

export function modelFoot(meta: {
  model: string;
  modelVersion: number;
  generatedAt: string;
  inputHash: string;
}) {
  return `${meta.model} · v${meta.modelVersion} · ${asOf(meta.generatedAt)} · inputs ${meta.inputHash.slice(0, 6)}`;
}
