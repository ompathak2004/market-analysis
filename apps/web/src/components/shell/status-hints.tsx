"use client";

import { useEffect, useState } from "react";
import { PANE_EVENT } from "@/lib/keymap/events";

const BASE = "⌃K cmd · Tab pane · ? keys";

export function StatusHints() {
  const [hints, setHints] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => setHints((e as CustomEvent<{ hints: string | null }>).detail?.hints);
    document.addEventListener(PANE_EVENT, on);
    return () => document.removeEventListener(PANE_EVENT, on);
  }, []);
  return (
    <div className="status-hints truncate">
      <span>{BASE}</span>
      {hints ? <span className="accent"> · {hints}</span> : null}
    </div>
  );
}
