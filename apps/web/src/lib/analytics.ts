import type { CaptureResult } from "posthog-js";

export function publicPageEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event || (event.event !== "$pageview" && event.event !== "$pageleave")) return null;

  const url = event.properties.$current_url;
  if (typeof url !== "string") return null;

  try {
    const { pathname } = new URL(url);
    return /^\/(admin|api)(\/|$)/.test(pathname) ? null : event;
  } catch {
    return null;
  }
}
