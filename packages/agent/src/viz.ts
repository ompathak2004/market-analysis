import { z } from "zod";

export const VIZ_VERSION = 1;

const format = z.enum(["text", "inr", "pct", "num", "date", "qty"]);
const tone = z.enum(["pos", "neg", "neu", "warn", "accent"]).nullable();
const label = z.string().min(1).max(80);

const base = {
  id: z.string().min(1).max(64),
  toolCallId: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  asOf: z.string().max(32).nullable(),
  source: z.string().max(160),
  notes: z.array(z.string().max(240)).max(6),
};

export const donutSpec = z.object({
  ...base,
  kind: z.literal("donut"),
  unit: z.enum(["inr", "pct"]),
  slices: z
    .array(z.object({ label, value: z.number().finite().nonnegative() }))
    .min(1)
    .max(16),
});

export const barSpec = z.object({
  ...base,
  kind: z.literal("bar"),
  unit: format,
  bars: z
    .array(
      z.object({
        label,
        value: z.number().finite(),
        tone,
        compare: z.number().finite().nullable(),
      }),
    )
    .min(1)
    .max(30),
  compareLabel: z.string().max(40).nullable(),
  valueLabel: z.string().max(40).nullable().default(null),
});

export const lineSpec = z.object({
  ...base,
  kind: z.literal("line"),
  unit: format,
  series: z
    .array(
      z.object({
        name: label,
        points: z
          .array(z.object({ x: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), y: z.number().finite() }))
          .min(2)
          .max(800),
      }),
    )
    .min(1)
    .max(4),
});

export const tableSpec = z.object({
  ...base,
  kind: z.literal("table"),
  columns: z
    .array(
      z.object({
        key: z.string().min(1).max(32),
        label: z.string().max(40),
        format,
        tone: z.boolean(),
      }),
    )
    .min(1)
    .max(10),
  rows: z.array(z.record(z.union([z.string().max(200), z.number().finite(), z.null()]))).max(60),
});

export const networkSpec = z.object({
  ...base,
  kind: z.literal("network"),
  center: z.string().min(1).max(40),
  nodes: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        label,
        role: z.enum(["center", "customer", "supplier", "holding", "event"]),
      }),
    )
    .min(1)
    .max(40),
  edges: z
    .array(
      z.object({
        from: z.string().max(64),
        to: z.string().max(64),
        label: z.string().max(60).nullable(),
        weight: z.number().finite().nullable(),
      }),
    )
    .max(80),
});

export const timelineSpec = z.object({
  ...base,
  kind: z.literal("timeline"),
  events: z
    .array(
      z.object({
        date: z.string().max(32),
        label: z.string().min(1).max(200),
        tag: z.string().max(24).nullable(),
        tone,
        sourceId: z.string().max(16).nullable(),
      }),
    )
    .min(1)
    .max(40),
});

export const kpiSpec = z.object({
  ...base,
  kind: z.literal("kpis"),
  items: z
    .array(z.object({ label, value: z.number().finite().nullable(), format, tone }))
    .min(1)
    .max(8),
});

export const vizSpec = z.discriminatedUnion("kind", [
  donutSpec,
  barSpec,
  lineSpec,
  tableSpec,
  networkSpec,
  timelineSpec,
  kpiSpec,
]);

export type VizSpec = z.infer<typeof vizSpec>;
export type VizKind = VizSpec["kind"];
export type VizFormat = z.infer<typeof format>;

export type VizCheck = { ok: true; spec: VizSpec } | { ok: false; error: string };

export function checkViz(raw: unknown): VizCheck {
  const r = vizSpec.safeParse(raw);
  if (r.success) return { ok: true, spec: r.data };
  return {
    ok: false,
    error: r.error.issues
      .slice(0, 4)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; "),
  };
}
