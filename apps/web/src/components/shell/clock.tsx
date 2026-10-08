"use client";

import { useEffect, useState } from "react";

const time = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const day = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  weekday: "short",
  day: "2-digit",
  month: "short",
});

export function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <time className="clock" dateTime={now?.toISOString()} suppressHydrationWarning>
      {now ? day.format(now).toUpperCase() : "—"} <b>{now ? time.format(now) : "--:--:--"}</b> IST
    </time>
  );
}
