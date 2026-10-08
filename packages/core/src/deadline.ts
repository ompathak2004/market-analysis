import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "./errors.js";

export class DeadlineExceededError extends AppError {
  constructor(needMs: number, remainingMs: number) {
    super("deadline exceeded", "deadline_exceeded", 504, { needMs, remainingMs });
  }
}

interface DeadlineScope {
  deadline: number;
  signal: AbortSignal;
}

const scope = new AsyncLocalStorage<DeadlineScope>();

export function withDeadline<T>(
  deadline: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const outer = scope.getStore();
  const effective = outer ? Math.min(outer.deadline, deadline) : deadline;
  const own = AbortSignal.timeout(Math.max(0, effective - Date.now()));
  const signal = outer ? AbortSignal.any([outer.signal, own]) : own;
  return scope.run({ deadline: effective, signal }, () => fn(signal));
}

export function currentDeadline(): number | null {
  return scope.getStore()?.deadline ?? null;
}

export function remainingMs(): number {
  const deadline = currentDeadline();
  return deadline === null ? Number.POSITIVE_INFINITY : deadline - Date.now();
}

export function assertTimeLeft(needMs: number): void {
  const left = remainingMs();
  if (left < needMs) throw new DeadlineExceededError(needMs, Math.max(0, left));
}

export function deadlineSignal(timeoutMs: number, extra?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(0, Math.min(timeoutMs, remainingMs())));
  return extra ? AbortSignal.any([timeout, extra]) : timeout;
}
