import type { VizFormat } from "@ma/agent";

type Tone = "pos" | "neg" | "neu" | "warn" | "accent" | null;

export interface ChartBase {
  title: string;
  asOf: string | null;
  source: string;
  notes?: string[];
}

export class ChartBuilder {
  private n = 0;

  constructor(private readonly callId: string) {}

  private base(kind: string, b: ChartBase) {
    this.n++;
    return {
      id: `${this.callId}-${kind}-${this.n}`.slice(0, 64),
      toolCallId: this.callId.slice(0, 64),
      title: b.title,
      asOf: b.asOf,
      source: b.source,
      notes: (b.notes ?? []).slice(0, 6),
    };
  }

  donut(b: ChartBase, unit: "inr" | "pct", slices: Array<{ label: string; value: number }>) {
    return {
      ...this.base("donut", b),
      kind: "donut",
      unit,
      slices: slices.filter((s) => s.value > 0).slice(0, 16),
    };
  }

  bar(
    b: ChartBase,
    unit: VizFormat,
    bars: Array<{ label: string; value: number; compare?: number | null; tone?: Tone }>,
    compareLabel: string | null = null,
  ) {
    return {
      ...this.base("bar", b),
      kind: "bar",
      unit,
      compareLabel,
      bars: bars.slice(0, 30).map((x) => ({
        label: x.label.slice(0, 80),
        value: x.value,
        compare: x.compare ?? null,
        tone: x.tone === undefined ? (x.value >= 0 ? "pos" : "neg") : x.tone,
      })),
    };
  }

  line(
    b: ChartBase,
    unit: VizFormat,
    series: Array<{ name: string; points: Array<{ x: string; y: number }> }>,
  ) {
    return {
      ...this.base("line", b),
      kind: "line",
      unit,
      series: series.filter((s) => s.points.length >= 2),
    };
  }

  table(
    b: ChartBase,
    columns: Array<{ key: string; label: string; format: VizFormat; tone?: boolean }>,
    rows: Array<Record<string, string | number | null>>,
  ) {
    return {
      ...this.base("table", b),
      kind: "table",
      columns: columns.map((c) => ({ ...c, tone: c.tone ?? false })),
      rows: rows.slice(0, 60),
    };
  }

  kpis(
    b: ChartBase,
    items: Array<{ label: string; value: number | null; format: VizFormat; tone?: Tone }>,
  ) {
    return {
      ...this.base("kpis", b),
      kind: "kpis",
      items: items.slice(0, 8).map((i) => ({ ...i, tone: i.tone ?? null })),
    };
  }

  timeline(
    b: ChartBase,
    events: Array<{
      date: string;
      label: string;
      tag: string | null;
      tone: Tone;
      sourceId: string | null;
    }>,
  ) {
    return { ...this.base("timeline", b), kind: "timeline", events: events.slice(0, 40) };
  }

  network(
    b: ChartBase,
    center: string,
    nodes: Array<{
      id: string;
      label: string;
      role: "center" | "customer" | "supplier" | "holding" | "event";
    }>,
    edges: Array<{ from: string; to: string; label: string | null; weight: number | null }>,
  ) {
    return {
      ...this.base("network", b),
      kind: "network",
      center,
      nodes: nodes.slice(0, 40),
      edges: edges.slice(0, 80),
    };
  }
}

export const r2 = (v: number | null | undefined): number | null =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;

export const toneOf = (v: number | null | undefined): Tone =>
  v == null ? null : v > 0 ? "pos" : v < 0 ? "neg" : "neu";
