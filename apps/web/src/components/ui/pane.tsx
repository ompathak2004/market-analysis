import type { CSSProperties, ReactNode } from "react";

export interface PaneProps {
  id: string;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  foot?: ReactNode;
  area?: string;
  hints?: string;
  pad?: boolean;
  children: ReactNode;
}

export function Pane({
  id,
  title,
  meta,
  actions,
  tabs,
  foot,
  area,
  hints,
  pad,
  children,
}: PaneProps) {
  const titleId = `pane-${id}-title`;
  const style = area ? ({ "--area": area } as CSSProperties) : undefined;
  return (
    <section
      className="pane"
      data-pane={id}
      data-hints={hints ?? "j/k rows · ↵ open · z zoom"}
      tabIndex={-1}
      style={style}
      aria-labelledby={titleId}
      suppressHydrationWarning
    >
      <header className="pane-head">
        <h2 className="pane-title" id={titleId}>
          {title}
        </h2>
        {meta != null ? <span className="pane-meta">{meta}</span> : <span className="pane-meta" />}
        {actions != null ? <div className="pane-actions">{actions}</div> : null}
      </header>
      {tabs != null ? <nav className="pane-tabs">{tabs}</nav> : null}
      <div className={`pane-body scroll${pad ? " pad" : ""}`} data-scroll>
        {children}
      </div>
      {foot != null ? <footer className="pane-foot">{foot}</footer> : null}
    </section>
  );
}

export function PaneSkeleton({
  id,
  title,
  area,
  lines = 8,
}: {
  id: string;
  title: ReactNode;
  area?: string;
  lines?: number;
}) {
  return (
    <Pane id={id} title={title} meta="loading…" {...(area ? { area } : {})}>
      <div className="skeleton" aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <i key={String(i)} />
        ))}
      </div>
    </Pane>
  );
}
