import type { ReactNode } from "react";

export type ColWidth = "sym" | "date" | "num" | "pct" | "text" | "xs" | "sm" | "md" | "lg";

export interface Column<T> {
  key: string;
  header: ReactNode;
  width?: ColWidth;
  align?: "left" | "right" | "center";
  priority?: 1 | 2 | 3;
  sortable?: boolean;
  className?: string;
  cell: (row: T, index: number) => ReactNode;
  sortValue?: (row: T) => number | string | null;
  title?: (row: T) => string | null | undefined;
}

export interface RowGroup<T> {
  label: ReactNode;
  rows: readonly T[];
}

export interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows?: readonly T[];
  groups?: readonly RowGroup<T>[];
  rowKey: (row: T, index: number) => string | number;
  rowLink?: (row: T) => string | null | undefined;
  rowExternal?: (row: T) => string | null | undefined;
  rowDigest?: (row: T) => string | null | undefined;
  rowSub?: (row: T) => ReactNode;
  rowSelected?: (row: T) => boolean;
  rowClass?: (row: T) => string | undefined;
  empty?: ReactNode;
  caption?: ReactNode;
  label?: string;
}

function colClass<T>(c: Column<T>): string {
  const parts: string[] = [];
  if (c.width) parts.push(`w-${c.width}`);
  if (c.align === "right") parts.push("r");
  if (c.align === "center") parts.push("c");
  if (c.priority && c.priority > 1) parts.push(`p${c.priority}`);
  if (c.className) parts.push(c.className);
  return parts.join(" ");
}

export function DataTable<T>({
  columns,
  rows,
  groups,
  rowKey,
  rowLink,
  rowExternal,
  rowDigest,
  rowSub,
  rowSelected,
  rowClass,
  empty,
  caption,
  label,
}: DataTableProps<T>) {
  const allGroups: readonly RowGroup<T>[] = groups ?? [{ label: null, rows: rows ?? [] }];
  const total = allGroups.reduce((s, g) => s + g.rows.length, 0);
  if (!total && empty) return <>{empty}</>;
  let index = 0;
  return (
    <table className="dt" aria-label={label}>
      {caption ? <caption>{caption}</caption> : null}
      <colgroup>
        {columns.map((c) => (
          <col key={c.key} className={colClass(c)} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c.key}
              scope="col"
              className={colClass(c)}
              data-sortable={c.sortable ? "true" : undefined}
            >
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      {allGroups.map((g, gi) => (
        <tbody key={String(gi)}>
          {g.label != null ? (
            <tr className="dt-group">
              <td colSpan={columns.length}>{g.label}</td>
            </tr>
          ) : null}
          {g.rows.map((row) => {
            const i = index++;
            const href = rowLink?.(row) ?? null;
            const ext = rowExternal?.(row) ?? null;
            const digest = rowDigest?.(row) ?? null;
            const sub = rowSub?.(row);
            const key = rowKey(row, i);
            return [
              <tr
                key={`r-${key}`}
                data-row=""
                data-href={href ?? undefined}
                data-ext={ext ?? undefined}
                data-digest={digest ?? undefined}
                data-selected={rowSelected?.(row) ? "true" : undefined}
                className={rowClass?.(row)}
              >
                {columns.map((c) => {
                  const v = c.sortValue?.(row);
                  const title = c.title?.(row);
                  return (
                    <td
                      key={c.key}
                      className={colClass(c) || undefined}
                      data-v={v ?? undefined}
                      title={title ?? undefined}
                    >
                      {c.cell(row, i)}
                    </td>
                  );
                })}
              </tr>,
              sub != null && sub !== false ? (
                <tr key={`s-${key}`} className="dt-sub">
                  <td colSpan={columns.length}>{sub}</td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      ))}
    </table>
  );
}
