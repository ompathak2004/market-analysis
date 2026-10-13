import type { JobPayload, JobType } from "@ma/jobs";
import type { Metrics } from "./batch.js";
import type { WorkerContext } from "./context.js";

export interface UnitRun<T extends JobType = JobType> {
  ctx: WorkerContext;
  type: T;
  payload: JobPayload<T>;
  attempt: number;
  campaignId: number | null;
  deadline: number;
  signal: AbortSignal;
  expired(reserveMs?: number): boolean;
}

export interface ChildJob {
  type: JobType;
  payload: Record<string, unknown>;
  priority?: number;
}

export interface HandlerResult {
  metrics: Metrics;
  children?: ChildJob[];
}

export type Handler<T extends JobType = JobType> = (run: UnitRun<T>) => Promise<HandlerResult>;

export type HandlerMap = { [T in JobType]: Handler<T> };

export function done(metrics: Metrics = {}): HandlerResult {
  return { metrics };
}

export function fanout(type: JobType, payloads: Record<string, unknown>[]): HandlerResult {
  return {
    metrics: { children: payloads.length },
    children: payloads.map((payload) => ({ type, payload })),
  };
}

export function companies(type: JobType, ids: number[]): HandlerResult {
  return fanout(
    type,
    ids.map((companyId) => ({ companyId })),
  );
}
