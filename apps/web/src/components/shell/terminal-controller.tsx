"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import type { Binding } from "@/lib/keymap/bindings";
import { OPEN_CMD, TOGGLE_HELP } from "@/lib/keymap/events";
import {
  cyclePane,
  focusedPane,
  panes,
  scrollPane,
  setFocusedPane,
  toggleZoom,
  unzoomAll,
} from "@/lib/keymap/pane-focus";
import { moveRow, rowExternal, rowHref, selectedRow, selectRow } from "@/lib/keymap/row-nav";
import { attachScrollActivity } from "@/lib/keymap/scroll-activity";
import { cycleSort, toggleSort } from "@/lib/keymap/table-sort";
import { useKeymap } from "@/lib/keymap/use-keymap";

function stepChip(container: string, delta: number): string | null {
  const chips = [...document.querySelectorAll<HTMLAnchorElement>(`${container} a[href]`)];
  if (!chips.length) return null;
  const cur = chips.findIndex((a) => a.getAttribute("aria-current") != null);
  const next = chips[Math.max(0, Math.min(chips.length - 1, (cur < 0 ? 0 : cur) + delta))];
  return next && next !== chips[cur] ? next.getAttribute("href") : null;
}

function helpOpen(): boolean {
  return document.querySelector(".help-overlay:not([hidden])") != null;
}

export function TerminalController() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => attachScrollActivity(document), []);

  useEffect(() => {
    if (!pathname) return;
    const current = focusedPane();
    if (current && document.contains(current)) return;
    setFocusedPane(panes()[0] ?? null, false);
  }, [pathname]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const th = target.closest<HTMLTableCellElement>("table.dt th[data-sortable]");
      if (th) {
        toggleSort(th);
        return;
      }
      const pane = target.closest<HTMLElement>("[data-pane]");
      if (!pane) return;
      if (pane.getAttribute("data-focused") !== "true") setFocusedPane(pane, false);
      const row = target.closest<HTMLElement>("[data-row]");
      if (!row) return;
      selectRow(pane, row);
      if (target.closest("a, button, summary, input")) return;
      const href = row.getAttribute("data-href");
      if (href) router.push(href);
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const pane = t.closest<HTMLElement>("[data-pane]");
      if (pane && pane.getAttribute("data-focused") !== "true") setFocusedPane(pane, false);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [router]);

  useKeymap((b: Binding) => {
    const pane = focusedPane();
    if (helpOpen() && b.id !== "help.toggle" && b.id !== "cmd.close") return false;
    switch (b.id) {
      case "cmd.open":
        document.dispatchEvent(new CustomEvent(OPEN_CMD));
        return true;
      case "cmd.close": {
        if (helpOpen()) {
          document.dispatchEvent(new CustomEvent(TOGGLE_HELP, { detail: { open: false } }));
          return true;
        }
        if (unzoomAll()) return true;
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest(".cmd")) {
          active.blur();
          setFocusedPane(pane ?? panes()[0] ?? null);
          return true;
        }
        if (pane && selectedRow(pane)) {
          selectRow(pane, null);
          return true;
        }
        return false;
      }
      case "help.toggle":
        document.dispatchEvent(new CustomEvent(TOGGLE_HELP));
        return true;
      case "pane.next":
        cyclePane(1);
        return true;
      case "pane.prev":
        cyclePane(-1);
        return true;
      case "pane.zoom":
        toggleZoom(pane);
        return true;
      case "page.down":
        scrollPane(pane, 1);
        return true;
      case "page.up":
        scrollPane(pane, -1);
        return true;
      case "row.down":
      case "row.up":
      case "row.first":
      case "row.last": {
        const p = pane ?? panes()[0] ?? null;
        if (!p) return false;
        if (!pane) setFocusedPane(p);
        const delta =
          b.id === "row.down"
            ? 1
            : b.id === "row.up"
              ? -1
              : b.id === "row.first"
                ? "first"
                : "last";
        moveRow(p, delta);
        return true;
      }
      case "row.open": {
        const row = pane ? selectedRow(pane) : null;
        if (!row) return false;
        const href = rowHref(row);
        if (href) router.push(href);
        else {
          const ext = rowExternal(row);
          if (ext) window.open(ext, "_blank", "noopener,noreferrer");
        }
        return true;
      }
      case "row.external": {
        const row = pane ? selectedRow(pane) : null;
        const ext = row ? rowExternal(row) : null;
        if (!ext) return false;
        window.open(ext, "_blank", "noopener,noreferrer");
        return true;
      }
      case "sort.cycle":
        if (!pane) return false;
        cycleSort(pane);
        return true;
      case "range.prev":
      case "range.next": {
        const href = stepChip("[data-range-chips]", b.id === "range.next" ? 1 : -1);
        if (href) router.push(href, { scroll: false });
        return href != null;
      }
      case "nav.home":
        router.push("/");
        return true;
      case "nav.signals":
        router.push("/signals");
        return true;
      case "density.toggle": {
        const html = document.documentElement;
        const next = html.dataset.density === "compact" ? "comfortable" : "compact";
        html.dataset.density = next;
        try {
          localStorage.setItem("ma:density", next);
        } catch {}
        return true;
      }
      default: {
        if (b.id.startsWith("tab.")) {
          const a = document.querySelector<HTMLAnchorElement>(
            `nav[data-company-tabs] a[data-tab-index="${b.id.slice(4)}"]`,
          );
          const href = a?.getAttribute("href");
          if (!href) return false;
          router.push(href);
          return true;
        }
        return false;
      }
    }
  });

  return null;
}
