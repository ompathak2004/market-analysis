"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { isTab, resolveCommand, TAB_TITLE, TABS } from "@/lib/commands";

interface Hit {
  nseSymbol: string;
  name: string;
  sector: string | null;
}

export function CommandBar() {
  const router = useRouter();
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);

  const currentSymbol = /^\/c\/([^/]+)/.exec(pathname)?.[1] ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA)$/.test(target.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (!typing && e.key === "/") {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (!typing && currentSymbol && /^[1-6]$/.test(e.key)) {
        const tab = TABS[Number(e.key) - 1];
        if (tab) router.push(`/c/${currentSymbol}/${tab}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentSymbol, router]);

  useEffect(() => {
    const q = value.trim().split(/\s+/);
    const term = q.length > 1 && isTab(q[0]?.toLowerCase() ?? "") ? q[1] : q[0];
    if (!term || term.length < 1) {
      setHits([]);
      return;
    }
    const ctrl = new AbortController();
    const id = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal })
        .then((r) => r.json() as Promise<{ results: Hit[] }>)
        .then((d) => {
          setHits(d.results.slice(0, 8));
          setActive(0);
        })
        .catch(() => {});
    }, 120);
    return () => {
      clearTimeout(id);
      ctrl.abort();
    };
  }, [value]);

  const go = useCallback(
    (cmd: string) => {
      const href = resolveCommand(cmd, currentSymbol);
      if (!href) return;
      setOpen(false);
      setValue("");
      inputRef.current?.blur();
      router.push(href);
    },
    [currentSymbol, router],
  );

  const pick = (hit: Hit) => {
    const tab = value.trim().toLowerCase().split(/\s+/).find(isTab);
    go(tab ? `${tab} ${hit.nseSymbol}` : hit.nseSymbol);
  };

  return (
    <div className="cmd">
      <span className="cmd-prompt">&gt;</span>
      <input
        ref={inputRef}
        className="cmd-input"
        role="combobox"
        aria-label="Command"
        aria-expanded={open && hits.length > 0}
        aria-controls="cmd-menu"
        aria-activedescendant={hits[active] ? `cmd-hit-${hits[active].nseSymbol}` : undefined}
        value={value}
        placeholder="DES RELIANCE · ANR INFY · SPLC SONACOMS · MOV"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            inputRef.current?.blur();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, hits.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const hit = hits[active];
            const typed = value.trim().toUpperCase();
            if (hit && !hits.some((h) => typed.endsWith(h.nseSymbol))) pick(hit);
            else go(value);
          }
        }}
      />
      {open && (value.trim() || hits.length > 0) && (
        <div className="cmd-menu" id="cmd-menu" role="listbox">
          {hits.map((h, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              id={`cmd-hit-${h.nseSymbol}`}
              key={h.nseSymbol}
              className={`cmd-item${i === active ? " active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(h);
              }}
            >
              <span className="sym">{h.nseSymbol}</span>
              <span>{h.name}</span>
              <span className="meta">{h.sector ?? ""}</span>
            </button>
          ))}
          <div className="cmd-help">
            {TABS.map((t) => (
              <span key={t} style={{ marginRight: 12 }}>
                <b>{t.toUpperCase()}</b> {TAB_TITLE[t]}
              </span>
            ))}
            <span>
              <b>HOME</b> · <b>MOV</b> · <b>SIG</b> [kind]
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
