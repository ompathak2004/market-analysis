"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { isTyping } from "@/lib/keymap/use-keymap";

export function RefreshOnInterval({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (isTyping(document.activeElement)) return;
      router.refresh();
    }, seconds * 1000);
    return () => window.clearInterval(t);
  }, [router, seconds]);
  return null;
}
