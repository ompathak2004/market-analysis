import Link from "next/link";
import type { ReactNode } from "react";

export type ChipTone = "pos" | "neg" | "neu" | "warn" | "info" | "accent";

export function Chip({
  href,
  active,
  children,
  title,
}: {
  href?: string;
  active?: boolean;
  children: ReactNode;
  title?: string;
}) {
  if (href)
    return (
      <Link className="chip" href={href} aria-current={active ? "true" : undefined} title={title}>
        {children}
      </Link>
    );
  return (
    <span className="chip" data-active={active ? "true" : undefined} title={title}>
      {children}
    </span>
  );
}

export function Badge({
  tone = "neu",
  children,
  title,
}: {
  tone?: ChipTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className="badge" data-tone={tone} title={title}>
      {children}
    </span>
  );
}

export function Ext({ href, children }: { href: string | null | undefined; children: ReactNode }) {
  if (!href) return <span className="muted">{children}</span>;
  return (
    <a className="ext" href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

export function Sym({ symbol, tab = "des" }: { symbol: string | null | undefined; tab?: string }) {
  if (!symbol) return <span className="muted">—</span>;
  return (
    <Link className="sym" href={`/c/${encodeURIComponent(symbol)}/${tab}`}>
      {symbol}
    </Link>
  );
}
