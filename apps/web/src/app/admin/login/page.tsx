import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { LoginForm } from "@/components/admin/login-form";
import { Pane } from "@/components/ui/pane";
import { getContext } from "@/server/context";
import { hasAdminSession } from "@/server/http/admin-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admin · MA Terminal",
  robots: { index: false, follow: false },
};

export default async function AdminLoginPage() {
  const ctx = getContext();
  if (!ctx.config.ADMIN_API_KEY) notFound();
  if (await hasAdminSession(ctx)) redirect("/admin/review");
  return (
    <div className="grid grid-solo admin-screen">
      <Pane id="login" title="ADMIN" meta="operator sign-in" hints="type key · ↵ sign in" pad>
        <LoginForm />
      </Pane>
    </div>
  );
}
