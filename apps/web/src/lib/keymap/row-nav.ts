export function rows(pane: HTMLElement): HTMLElement[] {
  return [...pane.querySelectorAll<HTMLElement>("[data-row]")].filter(
    (r) => r.offsetParent !== null,
  );
}

export function selectedRow(pane: HTMLElement): HTMLElement | null {
  return pane.querySelector<HTMLElement>('[data-row][data-selected="true"]');
}

export function selectRow(pane: HTMLElement, row: HTMLElement | null) {
  for (const r of pane.querySelectorAll<HTMLElement>('[data-row][data-selected="true"]'))
    if (r !== row) r.removeAttribute("data-selected");
  if (!row) return;
  row.setAttribute("data-selected", "true");
  row.scrollIntoView({ block: "nearest" });
  const out = pane.querySelector<HTMLOutputElement>("output[data-digest-out]");
  if (out) out.textContent = row.getAttribute("data-digest") ?? "";
}

export function moveRow(pane: HTMLElement, delta: number | "first" | "last") {
  const list = rows(pane);
  if (!list.length) return;
  const cur = selectedRow(pane);
  const idx = cur ? list.indexOf(cur) : -1;
  let next: number;
  if (delta === "first") next = 0;
  else if (delta === "last") next = list.length - 1;
  else next = idx < 0 ? 0 : Math.max(0, Math.min(list.length - 1, idx + delta));
  selectRow(pane, list[next] ?? null);
}

export function rowHref(row: HTMLElement): string | null {
  return (
    row.getAttribute("data-href") ??
    row.querySelector<HTMLAnchorElement>("a[href]:not(.ext)")?.getAttribute("href") ??
    null
  );
}

export function rowExternal(row: HTMLElement): string | null {
  return (
    row.getAttribute("data-ext") ??
    row.querySelector<HTMLAnchorElement>("a.ext[href]")?.getAttribute("href") ??
    null
  );
}
