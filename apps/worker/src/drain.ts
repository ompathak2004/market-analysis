import { LEASE_RENEW_MS } from "@ma/jobs";
import { ABORT_SETTLE_MS } from "./execute.js";

export const ABORT_BEFORE_DRAIN_END_MS = ABORT_SETTLE_MS + 5_000;

export interface DrainSteps {
  stopClaims(): Promise<void>;
  waitForInFlight(timeoutMs: number): Promise<void>;
  renewLease(): Promise<void>;
  abortInFlight(): void;
  releaseLease(): Promise<void>;
}

export async function drainInOrder(
  steps: DrainSteps,
  drainMs: number,
  renewMs = LEASE_RENEW_MS,
): Promise<void> {
  const renewal = setInterval(() => {
    steps.renewLease().catch(() => undefined);
  }, renewMs);
  const abort = setTimeout(
    () => steps.abortInFlight(),
    Math.max(0, drainMs - ABORT_BEFORE_DRAIN_END_MS),
  );
  try {
    await steps.stopClaims();
    await steps.waitForInFlight(drainMs);
  } finally {
    clearTimeout(abort);
    clearInterval(renewal);
    await steps.releaseLease();
  }
}
