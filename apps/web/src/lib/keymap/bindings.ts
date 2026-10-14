export type KeyScope = "global" | "idle" | "surface";

export interface Binding {
  id: string;
  keys: readonly string[];
  when: KeyScope;
  label: string;
  group: "Command" | "Panes" | "Rows" | "Views" | "Display";
}

const TAB_KEYS = ["DES", "GP", "FA", "ANR", "SPLC", "NEWS", "JET", "SHIP", "INTL", "INFL"] as const;

export const KEYMAP: readonly Binding[] = [
  {
    id: "cmd.open",
    keys: ["Control+k", "Meta+k", "`"],
    when: "global",
    label: "Open command bar",
    group: "Command",
  },
  {
    id: "cmd.close",
    keys: ["Escape"],
    when: "global",
    label: "Close / back out",
    group: "Command",
  },
  { id: "help.toggle", keys: ["?"], when: "idle", label: "Toggle key help", group: "Command" },
  { id: "pane.next", keys: ["Tab"], when: "surface", label: "Next pane", group: "Panes" },
  { id: "pane.prev", keys: ["Shift+Tab"], when: "surface", label: "Previous pane", group: "Panes" },
  { id: "pane.zoom", keys: ["z"], when: "idle", label: "Zoom focused pane", group: "Panes" },
  { id: "page.down", keys: ["Control+d"], when: "idle", label: "Scroll pane down", group: "Panes" },
  { id: "page.up", keys: ["Control+u"], when: "idle", label: "Scroll pane up", group: "Panes" },
  { id: "row.down", keys: ["j", "ArrowDown"], when: "idle", label: "Next row", group: "Rows" },
  { id: "row.up", keys: ["k", "ArrowUp"], when: "idle", label: "Previous row", group: "Rows" },
  { id: "row.first", keys: ["g"], when: "idle", label: "First row", group: "Rows" },
  { id: "row.last", keys: ["Shift+g"], when: "idle", label: "Last row", group: "Rows" },
  {
    id: "row.open",
    keys: ["Enter"],
    when: "surface",
    label: "Open selected row / enter pane",
    group: "Rows",
  },
  {
    id: "row.external",
    keys: ["Shift+Enter"],
    when: "surface",
    label: "Open source link",
    group: "Rows",
  },
  { id: "sort.cycle", keys: ["s"], when: "idle", label: "Cycle table sort", group: "Rows" },
  ...TAB_KEYS.map((code, i) => ({
    id: `tab.${i + 1}`,
    keys: [String((i + 1) % 10)],
    when: "idle" as const,
    label: `${code} view`,
    group: "Views" as const,
  })),
  { id: "range.prev", keys: ["["], when: "idle", label: "Shorter chart range", group: "Views" },
  { id: "range.next", keys: ["]"], when: "idle", label: "Longer chart range", group: "Views" },
  { id: "nav.home", keys: ["Shift+h"], when: "idle", label: "Go to HOME", group: "Views" },
  { id: "nav.signals", keys: ["Shift+s"], when: "idle", label: "Go to SIG", group: "Views" },
  { id: "density.toggle", keys: [","], when: "idle", label: "Toggle density", group: "Display" },
];

export function displayKey(key: string): string {
  return key
    .replace("Control+", "^")
    .replace("Meta+", "⌘")
    .replace("Shift+Tab", "⇧Tab")
    .replace("Shift+", "⇧")
    .replace("ArrowDown", "↓")
    .replace("ArrowUp", "↑")
    .replace("Enter", "↵")
    .replace("Escape", "Esc")
    .replace(/(\^|⌘|⇧)([a-z])$/, (_m, p: string, k: string) => `${p}${k.toUpperCase()}`);
}
