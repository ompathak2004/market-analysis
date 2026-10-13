import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import type { Logger } from "@ma/core";

export const METRIC_NAMESPACE = "MarketAnalysis";
export const HEARTBEAT_METRIC = "worker.heartbeat";
export const DEAD_METRIC = "jobs.dead";

export interface MetricsSink {
  count(name: string, value?: number): void;
  flush(): Promise<void>;
}

export class BufferedMetrics implements MetricsSink {
  private counts = new Map<string, number>();

  constructor(
    private readonly logger: Pick<Logger, "info" | "warn">,
    private readonly client: Pick<CloudWatchClient, "send"> | null,
  ) {}

  count(name: string, value = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + value);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  async flush(): Promise<void> {
    const counts = this.snapshot();
    this.counts.clear();
    counts[HEARTBEAT_METRIC] = 1;
    counts[DEAD_METRIC] ??= 0;
    this.logger.info({ metrics: counts }, "worker metrics");
    if (!this.client) return;
    const now = new Date();
    const data = Object.entries(counts).map(([MetricName, Value]) => ({
      MetricName,
      Value,
      Unit: "Count" as const,
      Timestamp: now,
    }));
    await this.client
      .send(new PutMetricDataCommand({ Namespace: METRIC_NAMESPACE, MetricData: data }))
      .catch((err: unknown) => {
        this.logger.warn({ err }, "cloudwatch put failed");
        for (const [k, v] of Object.entries(counts)) {
          if (k !== HEARTBEAT_METRIC) this.count(k, v);
        }
      });
  }
}

export function createMetrics(
  logger: Pick<Logger, "info" | "warn">,
  opts: { enabled: boolean; region: string },
): BufferedMetrics {
  return new BufferedMetrics(
    logger,
    opts.enabled ? new CloudWatchClient({ region: opts.region }) : null,
  );
}
