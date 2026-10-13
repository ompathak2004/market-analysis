import type { PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { describe, expect, it } from "vitest";
import { BufferedMetrics, DEAD_METRIC, HEARTBEAT_METRIC, METRIC_NAMESPACE } from "./metrics.js";

const silent = { info: () => undefined, warn: () => undefined };

describe("BufferedMetrics", () => {
  it("publishes heartbeat and dead count without dimensions, then resets", async () => {
    const sent: PutMetricDataCommand[] = [];
    const client = { send: async (cmd: PutMetricDataCommand) => void sent.push(cmd) };
    const metrics = new BufferedMetrics(silent, client as never);
    metrics.count(DEAD_METRIC);
    metrics.count(DEAD_METRIC, 2);
    await metrics.flush();
    await metrics.flush();
    expect(sent).toHaveLength(2);
    const values = (i: number) =>
      Object.fromEntries((sent[i]?.input.MetricData ?? []).map((d) => [d.MetricName, d.Value]));
    expect(sent[0]?.input.Namespace).toBe(METRIC_NAMESPACE);
    expect(values(0)).toEqual({ [DEAD_METRIC]: 3, [HEARTBEAT_METRIC]: 1 });
    expect(values(1)).toEqual({ [DEAD_METRIC]: 0, [HEARTBEAT_METRIC]: 1 });
    for (const d of sent[0]?.input.MetricData ?? []) expect(d.Dimensions).toBeUndefined();
  });

  it("keeps counts for the next flush when publishing fails", async () => {
    const client = {
      send: async () => {
        throw new Error("throttled");
      },
    };
    const metrics = new BufferedMetrics(silent, client as never);
    metrics.count(DEAD_METRIC, 2);
    await metrics.flush();
    expect(metrics.snapshot()).toEqual({ [DEAD_METRIC]: 2 });
  });

  it("only logs when CloudWatch is disabled", async () => {
    const metrics = new BufferedMetrics(silent, null);
    metrics.count("jobs.succeeded");
    await expect(metrics.flush()).resolves.toBeUndefined();
    expect(metrics.snapshot()).toEqual({});
  });
});
