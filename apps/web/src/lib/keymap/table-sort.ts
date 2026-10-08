function cellValue(row: HTMLTableRowElement, col: number): string | number {
  const cell = row.cells[col];
  if (!cell) return "";
  const v = cell.getAttribute("data-v");
  if (v != null && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  return (cell.textContent ?? "").trim();
}

export function sortTable(table: HTMLTableElement, col: number, dir: "ascending" | "descending") {
  const sign = dir === "ascending" ? 1 : -1;
  for (const body of table.tBodies) {
    const groups: HTMLTableRowElement[][] = [];
    const fixed: HTMLTableRowElement[] = [];
    for (const r of [...body.rows]) {
      if (r.classList.contains("dt-sub") && groups.length) groups.at(-1)?.push(r);
      else if (r.hasAttribute("data-row")) groups.push([r]);
      else fixed.push(r);
    }
    groups.sort((a, b) => {
      const va = cellValue(a[0] as HTMLTableRowElement, col);
      const vb = cellValue(b[0] as HTMLTableRowElement, col);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * sign;
      return String(va).localeCompare(String(vb)) * sign;
    });
    for (const r of fixed) body.appendChild(r);
    for (const g of groups) for (const r of g) body.appendChild(r);
  }
  for (const th of table.tHead?.rows[0]?.cells ?? []) th.removeAttribute("aria-sort");
  table.tHead?.rows[0]?.cells[col]?.setAttribute("aria-sort", dir);
}

export function toggleSort(th: HTMLTableCellElement) {
  const table = th.closest("table");
  if (!table) return;
  const next = th.getAttribute("aria-sort") === "descending" ? "ascending" : "descending";
  sortTable(table, th.cellIndex, next);
}

export function cycleSort(pane: HTMLElement) {
  const table = pane.querySelector<HTMLTableElement>("table.dt");
  const heads = [...(table?.tHead?.rows[0]?.cells ?? [])].filter(
    (c) => c.getAttribute("data-sortable") === "true",
  );
  if (!table || !heads.length) return;
  const active = heads.findIndex((h) => h.hasAttribute("aria-sort"));
  const cur = heads[active];
  if (cur && cur.getAttribute("aria-sort") === "descending") {
    sortTable(table, cur.cellIndex, "ascending");
    return;
  }
  const next = heads[(active + 1) % heads.length] as HTMLTableCellElement;
  sortTable(table, next.cellIndex, "descending");
}
