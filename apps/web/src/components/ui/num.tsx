import { num, type Tone, tone } from "@/lib/format";

export function Num({
  v,
  digits = 2,
  prefix,
  suffix,
  className,
}: {
  v: number | string | null | undefined;
  digits?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}) {
  const n = v == null || v === "" ? null : Number(v);
  const ok = n != null && Number.isFinite(n);
  return (
    <span className={`num${className ? ` ${className}` : ""}`} data-v={ok ? n : undefined}>
      {ok ? `${prefix ?? ""}${num(n, digits)}${suffix ?? ""}` : "—"}
    </span>
  );
}

export function Chg({
  v,
  digits = 2,
  pct = true,
  arrow = false,
  className,
}: {
  v: number | null | undefined;
  digits?: number;
  pct?: boolean;
  arrow?: boolean;
  className?: string;
}) {
  if (v == null || !Number.isFinite(v))
    return <span className={`num neu${className ? ` ${className}` : ""}`}>—</span>;
  const t: Tone = tone(v);
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  const mark = arrow ? (v > 0 ? "▲ " : v < 0 ? "▼ " : "") : "";
  return (
    <span className={`num ${t}${className ? ` ${className}` : ""}`} data-v={v}>
      {mark}
      {sign}
      {num(Math.abs(v), digits)}
      {pct ? "%" : ""}
    </span>
  );
}
