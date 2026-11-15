import { afterEach, expect, it, vi } from "vitest";

vi.mock("posthog-js", () => ({ default: { init: vi.fn() } }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

// Value: protects=the client entry point loads Clarity and stops it before private navigation;
// fails_when=initialization or the router hook is disconnected; why_new=helper tests cannot catch missing entry point wiring;
// seam=none; no_claim=Next.js hook dispatch or vendor recording (fake browser, mocked PostHog).
it("initializes public recording and routes private transitions to the recorder", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_CLARITY_PROJECT_ID", "ze4ktm1elg");
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "");
  vi.stubGlobal("window", {
    location: new URL("https://market-analysis.ompathak.dev/c/BEL/des"),
  });
  const appendChild = vi.fn();
  vi.stubGlobal("document", { head: { appendChild }, createElement: () => ({}) });

  const { onRouterTransitionStart } = await import("./instrumentation-client");

  expect(appendChild).toHaveBeenCalledWith(
    expect.objectContaining({ async: true, src: "https://www.clarity.ms/tag/ze4ktm1elg" }),
  );
  const recorder = vi.fn();
  window.clarity = recorder;
  onRouterTransitionStart("/c/BEL/splc");
  expect(recorder).not.toHaveBeenCalled();
  onRouterTransitionStart("/bot");
  expect(recorder).toHaveBeenCalledExactlyOnceWith("stop");
});
