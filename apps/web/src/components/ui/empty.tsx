import type { ReactNode } from "react";

export function Empty({
  title,
  children,
  hint,
}: {
  title: string;
  children?: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="empty" role="status">
      <span className="empty-title">{title}</span>
      {children ? <p>{children}</p> : null}
      {hint ? <span className="empty-hint">{hint}</span> : null}
    </div>
  );
}

export function Unavailable({ code, children }: { code: string; children?: ReactNode }) {
  return (
    <div className="unavailable" role="alert">
      <b>DATA UNAVAILABLE · {code}</b>
      {children ? <div className="dim">{children}</div> : null}
    </div>
  );
}

export function errorCode(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; name?: unknown; status?: unknown };
    if (typeof e.code === "string") return e.code.toUpperCase();
    if (typeof e.status === "number") return `HTTP ${e.status}`;
    if (typeof e.name === "string" && e.name !== "Error") return e.name.toUpperCase();
  }
  return "LOAD_FAILED";
}
