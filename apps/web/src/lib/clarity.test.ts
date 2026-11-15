import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeClarity, stopClarityOnPrivateNavigation } from "./clarity";

const appendChild = vi.fn();

function visit(url: string) {
  vi.stubGlobal("window", { location: new URL(url) });
}

describe("Clarity recording", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
    visit("https://market-analysis.ompathak.dev/");
    vi.stubGlobal("document", { head: { appendChild }, createElement: () => ({}) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it.each([
    "market-analysis.ompathak.dev",
    "market-analysis-shinchan21.vercel.app",
    "market-analysis-chi.vercel.app",
  ])("loads one asynchronous tracker on %s and tags its hostname", (hostname) => {
    visit(`https://${hostname}/c/BEL/des`);
    initializeClarity("ze4ktm1elg");
    initializeClarity("ze4ktm1elg");

    expect(appendChild).toHaveBeenCalledOnce();
    expect(appendChild).toHaveBeenCalledWith(
      expect.objectContaining({ async: true, src: "https://www.clarity.ms/tag/ze4ktm1elg" }),
    );
    expect(window.clarity?.q).toContainEqual(["set", "site_host", hostname]);
  });

  it.each([
    "http://localhost:3000/",
    "https://market-analysis-preview-shinchan21.vercel.app/",
    "https://market-analysis.ompathak.dev.example.com/",
    "https://market-analysis.ompathak.dev/admin",
    "https://market-analysis.ompathak.dev/admin/login",
    "https://market-analysis.ompathak.dev/admin/review?sample=private",
    "https://market-analysis.ompathak.dev/api/v1/search",
    "https://market-analysis.ompathak.dev/bot",
    "https://market-analysis.ompathak.dev/bot/private",
  ])("does not load the tracker at %s", (url) => {
    visit(url);
    initializeClarity("ze4ktm1elg");
    expect(appendChild).not.toHaveBeenCalled();
    expect(window.clarity).toBeUndefined();
  });

  it("does not record development or preview builds even on an allowed hostname", () => {
    vi.stubEnv("NODE_ENV", "development");
    initializeClarity("ze4ktm1elg");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "preview");
    initializeClarity("ze4ktm1elg");
    expect(appendChild).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "invalid/id"])('ignores missing or invalid project ID "%s"', (id) => {
    initializeClarity(id);
    expect(appendChild).not.toHaveBeenCalled();
  });

  it("keeps public navigation recording and stops before private navigation", () => {
    const tracker = vi.fn();
    window.clarity = tracker;
    stopClarityOnPrivateNavigation("/c/BEL/splc");
    stopClarityOnPrivateNavigation("/signals");
    expect(tracker).not.toHaveBeenCalled();
    for (const url of ["/admin/login", "/bot", "/api/v1/search"]) {
      stopClarityOnPrivateNavigation(url);
      expect(tracker).toHaveBeenLastCalledWith("stop");
    }
    expect(tracker).toHaveBeenCalledTimes(3);
  });

  // Value: protects=private navigation remains usable before recording initializes;
  // fails_when=the router helper calls an absent recorder; why_new=existing navigation coverage supplies a recorder;
  // seam=none; no_claim=Next.js dispatch or vendor behavior (fake browser).
  it("allows private navigation before a recorder exists", () => {
    expect(window.clarity).toBeUndefined();
    for (const url of ["/admin/login", "/bot", "/api/v1/search"]) {
      expect(() => stopClarityOnPrivateNavigation(url)).not.toThrow();
    }
  });

  // Value: protects=loader completion stops private pages while preserving public recording;
  // fails_when=the load callback stops every page; why_new=the existing delayed-load case exercised private completion only;
  // seam=none; no_claim=vendor loading and recording (fake DOM and recorder).
  it("stops a delayed tracker only if navigation reached a private page while loading", () => {
    initializeClarity("ze4ktm1elg");
    const tracker = vi.fn();
    window.clarity = tracker;
    appendChild.mock.calls[0]?.[0].onload();
    expect(tracker).not.toHaveBeenCalled();
    visit("https://market-analysis.ompathak.dev/bot");
    window.clarity = tracker;
    appendChild.mock.calls[0]?.[0].onload();
    expect(tracker).toHaveBeenCalledWith("stop");
  });
});
