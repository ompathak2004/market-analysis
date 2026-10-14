import { describe, expect, it } from "vitest";
import type { AppContext } from "../context";
import {
  ADMIN_COOKIE,
  ADMIN_REVIEWER,
  ADMIN_TTL_MS,
  readCookie,
  requireAdmin,
  signAdminCookie,
  verifyAdminCookie,
} from "./auth";

const KEY = "admin-key-for-tests";
const NOW = Date.UTC(2026, 9, 14, 9, 0, 0);

function ctx(key: string | undefined) {
  return { config: { ADMIN_API_KEY: key } } as unknown as Pick<AppContext, "config">;
}

function req(headers: Record<string, string>, method = "GET") {
  return new Request("https://ma.example/api/v1/admin/relationships/reviews", {
    method,
    headers,
  });
}

describe("admin cookie", () => {
  const value = signAdminCookie(KEY, NOW + ADMIN_TTL_MS);

  it("round-trips a signed expiry", () => {
    expect(value).toMatch(/^\d{13}\.[A-Za-z0-9_-]{43}$/);
    expect(verifyAdminCookie(KEY, value, NOW)).toBe(true);
    expect(verifyAdminCookie(KEY, value, NOW + ADMIN_TTL_MS - 1)).toBe(true);
  });

  it("rejects expired, tampered, foreign-key and malformed values", () => {
    expect(verifyAdminCookie(KEY, value, NOW + ADMIN_TTL_MS)).toBe(false);
    expect(verifyAdminCookie("other-key", value, NOW)).toBe(false);
    const [exp, sig] = value.split(".") as [string, string];
    expect(verifyAdminCookie(KEY, `${Number(exp) + 1000}.${sig}`, NOW)).toBe(false);
    const flipped = `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
    expect(verifyAdminCookie(KEY, `${exp}.${flipped}`, NOW)).toBe(false);
    for (const bad of [null, undefined, "", "abc", `${exp}.`, `.${sig}`, `${exp}.${sig}.x`]) {
      expect(verifyAdminCookie(KEY, bad, NOW)).toBe(false);
    }
  });

  it("refuses expiries beyond the session lifetime", () => {
    const far = signAdminCookie(KEY, NOW + ADMIN_TTL_MS * 2);
    expect(verifyAdminCookie(KEY, far, NOW)).toBe(false);
  });

  it("reads one cookie from a header", () => {
    expect(readCookie(`a=1; ${ADMIN_COOKIE}=${value}; b=2`, ADMIN_COOKIE)).toBe(value);
    expect(readCookie("a=1; b=2", ADMIN_COOKIE)).toBeNull();
    expect(readCookie(null, ADMIN_COOKIE)).toBeNull();
    expect(readCookie(`x${ADMIN_COOKIE}=1`, ADMIN_COOKIE)).toBeNull();
  });
});

describe("requireAdmin", () => {
  const cookie = `${ADMIN_COOKIE}=${signAdminCookie(KEY, NOW + ADMIN_TTL_MS)}`;

  it("answers 404 when ADMIN_API_KEY is unset", () => {
    expect(() => requireAdmin(ctx(undefined), req({ "x-admin-key": KEY }), NOW)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  it("accepts the x-admin-key header", () => {
    expect(requireAdmin(ctx(KEY), req({ "x-admin-key": KEY }, "POST"), NOW)).toBe(ADMIN_REVIEWER);
  });

  it("accepts a valid session cookie", () => {
    expect(requireAdmin(ctx(KEY), req({ cookie }), NOW)).toBe(ADMIN_REVIEWER);
    expect(
      requireAdmin(
        ctx(KEY),
        req({ cookie, origin: "https://ma.example", host: "ma.example" }, "POST"),
        NOW,
      ),
    ).toBe(ADMIN_REVIEWER);
  });

  it("rejects wrong keys, expired cookies and cross-site cookie posts with 401", () => {
    const unauthorized = expect.objectContaining({ status: 401 });
    expect(() => requireAdmin(ctx(KEY), req({ "x-admin-key": "nope" }), NOW)).toThrow(unauthorized);
    expect(() => requireAdmin(ctx(KEY), req({}), NOW)).toThrow(unauthorized);
    expect(() => requireAdmin(ctx(KEY), req({ cookie }), NOW + ADMIN_TTL_MS)).toThrow(unauthorized);
    expect(() =>
      requireAdmin(
        ctx(KEY),
        req({ cookie, origin: "https://evil.example", host: "ma.example" }, "POST"),
        NOW,
      ),
    ).toThrow(unauthorized);
  });
});
