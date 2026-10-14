"use server";

import { RateLimitedError } from "@ma/core";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getContext } from "@/server/context";
import { endAdminSession, startAdminSession } from "@/server/http/admin-session";
import { limitPublic, safeEqual } from "@/server/http/auth";

export interface LoginState {
  error: string | null;
}

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  const ctx = getContext();
  const key = ctx.config.ADMIN_API_KEY;
  if (!key) return { error: "Review is disabled: ADMIN_API_KEY is not set." };
  try {
    await limitPublic(ctx, { headers: await headers() }, "adminLogin");
  } catch (err) {
    if (err instanceof RateLimitedError) return { error: "Too many attempts. Try again later." };
    ctx.logger.warn({ err }, "admin login rate limiter unavailable");
  }
  const given = form.get("key");
  if (typeof given !== "string" || !safeEqual(given.trim(), key)) {
    return { error: "Invalid admin key." };
  }
  await startAdminSession(ctx, key);
  redirect("/admin/review");
}

export async function logout(): Promise<void> {
  await endAdminSession();
  redirect("/admin/login");
}
