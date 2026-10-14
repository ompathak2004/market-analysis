import { cookies } from "next/headers";
import type { AppContext } from "../context";
import { ADMIN_COOKIE, ADMIN_TTL_MS, signAdminCookie, verifyAdminCookie } from "./auth";

export async function hasAdminSession(ctx: Pick<AppContext, "config">): Promise<boolean> {
  const key = ctx.config.ADMIN_API_KEY;
  if (!key) return false;
  return verifyAdminCookie(key, (await cookies()).get(ADMIN_COOKIE)?.value);
}

export async function startAdminSession(ctx: Pick<AppContext, "config">, key: string) {
  (await cookies()).set(ADMIN_COOKIE, signAdminCookie(key, Date.now() + ADMIN_TTL_MS), {
    httpOnly: true,
    secure: ctx.config.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: Math.floor(ADMIN_TTL_MS / 1000),
  });
}

export async function endAdminSession() {
  (await cookies()).delete(ADMIN_COOKIE);
}
