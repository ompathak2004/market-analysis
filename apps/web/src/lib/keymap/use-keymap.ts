import { useEffect, useRef } from "react";
import { type Binding, KEYMAP } from "./bindings";

export function eventCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Control");
  if (e.metaKey) parts.push("Meta");
  if (e.altKey) parts.push("Alt");
  let key = e.key;
  if (key.length === 1 && /[a-z]/i.test(key)) {
    if (e.shiftKey) parts.push("Shift");
    key = key.toLowerCase();
  } else if (key.length > 1 && e.shiftKey) {
    parts.push("Shift");
  }
  parts.push(key);
  return parts.join("+");
}

export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function isSurface(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  return (
    target === document.body ||
    target === document.documentElement ||
    target.hasAttribute("data-pane")
  );
}

const BY_COMBO = new Map<string, Binding>();
for (const b of KEYMAP) for (const k of b.keys) BY_COMBO.set(k, b);

export function matchBinding(e: KeyboardEvent): Binding | null {
  const b = BY_COMBO.get(eventCombo(e));
  if (!b) return null;
  if (b.when === "idle" && isTyping(e.target)) return null;
  if (b.when === "surface" && !isSurface(e.target)) return null;
  if (b.id === "cmd.open" && e.key === "`" && isTyping(e.target)) return null;
  return b;
}

export function useKeymap(handler: (binding: Binding, e: KeyboardEvent) => boolean | undefined) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const b = matchBinding(e);
      if (b && ref.current(b, e) !== false) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
