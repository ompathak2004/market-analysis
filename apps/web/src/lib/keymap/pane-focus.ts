import { PANE_EVENT } from "./events";

export function panes(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".screen [data-pane]")];
}

export function focusedPane(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-pane][data-focused="true"]');
}

export function setFocusedPane(pane: HTMLElement | null, moveFocus = true) {
  for (const p of panes()) if (p !== pane) p.removeAttribute("data-focused");
  if (!pane) return;
  pane.setAttribute("data-focused", "true");
  if (moveFocus && !pane.contains(document.activeElement)) pane.focus({ preventScroll: false });
  const hints = pane.getAttribute("data-hints");
  document.dispatchEvent(new CustomEvent(PANE_EVENT, { detail: { hints } }));
}

export function cyclePane(delta: number) {
  const list = panes();
  if (!list.length) return;
  const current = focusedPane();
  const idx = current ? list.indexOf(current) : -1;
  const next = list[(idx + delta + list.length) % list.length] ?? list[0] ?? null;
  setFocusedPane(next);
}

export function toggleZoom(pane: HTMLElement | null) {
  if (!pane) return;
  if (pane.getAttribute("data-zoomed") === "true") pane.removeAttribute("data-zoomed");
  else {
    for (const p of panes()) p.removeAttribute("data-zoomed");
    pane.setAttribute("data-zoomed", "true");
  }
}

export function unzoomAll(): boolean {
  let changed = false;
  for (const p of panes())
    if (p.getAttribute("data-zoomed") === "true") {
      p.removeAttribute("data-zoomed");
      changed = true;
    }
  return changed;
}

export function scrollPane(pane: HTMLElement | null, dir: 1 | -1) {
  const body = pane?.querySelector<HTMLElement>("[data-scroll]");
  if (body) body.scrollBy({ top: (dir * body.clientHeight) / 2 });
}
