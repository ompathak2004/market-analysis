import { Fragment, type ReactNode } from "react";

export interface KVItem {
  label: ReactNode;
  value: ReactNode;
  title?: string;
}

export interface KVGroup {
  title?: ReactNode;
  items: readonly KVItem[];
}

export function KeyValue({ groups, label }: { groups: readonly KVGroup[]; label?: string }) {
  return (
    <dl className="kv" aria-label={label}>
      {groups.map((g, gi) => (
        <Fragment key={String(gi)}>
          {g.title ? <div className="kv-group">{g.title}</div> : null}
          {g.items.map((it, i) => (
            <Fragment key={String(i)}>
              <dt title={it.title}>{it.label}</dt>
              <dd>{it.value}</dd>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </dl>
  );
}
