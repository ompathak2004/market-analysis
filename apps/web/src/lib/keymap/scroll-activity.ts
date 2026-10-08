const timers = new WeakMap<HTMLElement, number>();

export function attachScrollActivity(root: Document | HTMLElement = document, idleMs = 900) {
  const onScroll = (e: Event) => {
    const el = e.target;
    if (!(el instanceof HTMLElement) || !el.classList.contains("scroll")) return;
    el.setAttribute("data-scroll-active", "true");
    const prev = timers.get(el);
    if (prev) window.clearTimeout(prev);
    timers.set(
      el,
      window.setTimeout(() => {
        el.removeAttribute("data-scroll-active");
        timers.delete(el);
      }, idleMs),
    );
  };
  root.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => root.removeEventListener("scroll", onScroll, { capture: true });
}
