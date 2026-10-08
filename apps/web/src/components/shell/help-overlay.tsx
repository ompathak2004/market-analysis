"use client";

import { useEffect, useRef, useState } from "react";
import { FUNCTIONS } from "@/lib/commands";
import { displayKey, KEYMAP } from "@/lib/keymap/bindings";
import { TOGGLE_HELP } from "@/lib/keymap/events";

export function KeyRows() {
  const groups = [...new Set(KEYMAP.map((b) => b.group))];
  return (
    <>
      {groups.map((g) => (
        <section key={g} className="pane-section">
          <h3 className="section-title">{g}</h3>
          <dl>
            {KEYMAP.filter((b) => b.group === g).map((b) => (
              <div key={b.id} className="help-row">
                <dt>
                  {b.keys.map((k) => (
                    <kbd key={k}>{displayKey(k)}</kbd>
                  ))}
                </dt>
                <dd>{b.label}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </>
  );
}

export function FunctionRows() {
  return (
    <dl>
      {FUNCTIONS.map((f) => (
        <div key={f.code} className="help-row">
          <dt>
            <span className="accent">{f.code}</span>
            {f.scope === "company" ? <span className="muted"> &lt;SYM&gt;</span> : null}
          </dt>
          <dd>
            {f.label}
            {f.aliases.length ? <span className="muted"> · {f.aliases.join(" ")}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function HelpOverlay() {
  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);

  useEffect(() => {
    const onToggle = (e: Event) => {
      const want = (e as CustomEvent<{ open?: boolean } | null>).detail?.open;
      setOpen((o) => {
        const next = want ?? !o;
        if (next && !o) returnTo.current = document.activeElement;
        return next;
      });
    };
    document.addEventListener(TOGGLE_HELP, onToggle);
    return () => document.removeEventListener(TOGGLE_HELP, onToggle);
  }, []);

  useEffect(() => {
    if (open) cardRef.current?.focus();
    else if (returnTo.current instanceof HTMLElement) {
      returnTo.current.focus();
      returnTo.current = null;
    }
  }, [open]);

  return (
    <div
      className="help-overlay"
      hidden={!open}
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div ref={cardRef} className="help-card" tabIndex={-1}>
        <header className="pane-head">
          <h2 className="pane-title" id="help-title">
            KEYS
          </h2>
          <span className="pane-meta">? or Esc to close</span>
        </header>
        <div className="help-body scroll">
          <KeyRows />
          <section className="pane-section">
            <h3 className="section-title">Functions</h3>
            <FunctionRows />
          </section>
        </div>
        <footer className="pane-foot">
          <output>Type a function code and a symbol in the command bar: DES RELIANCE</output>
        </footer>
      </div>
    </div>
  );
}
