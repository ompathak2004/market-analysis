import type { ReactNode } from "react";

export type CalloutTone = "pos" | "neg" | "neu" | "warn" | "info";

export function Callout({
  tone = "neu",
  title,
  children,
  so,
  meta,
  href,
  row = true,
}: {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  so?: ReactNode;
  meta?: ReactNode;
  href?: string;
  row?: boolean;
}) {
  return (
    <li className="callout" data-tone={tone} data-row={row ? "" : undefined} data-href={href}>
      {title ? <span className="callout-title">{title}</span> : null}
      {children ? <span className="callout-body">{children}</span> : null}
      {so ? <span className="callout-so">{so}</span> : null}
      {meta ? <span className="callout-meta">{meta}</span> : null}
    </li>
  );
}

export function CalloutGroup({
  title,
  count,
  children,
}: {
  title?: ReactNode;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="callout-group">
      {title ? (
        <h3>
          {title}
          {count != null ? <span>· {count}</span> : null}
        </h3>
      ) : null}
      <ul className="callouts" data-rows>
        {children}
      </ul>
    </section>
  );
}
