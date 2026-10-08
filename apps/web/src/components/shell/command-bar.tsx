"use client";

import { usePathname, useRouter } from "next/navigation";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { FUNCTIONS, functionFor, fuzzyScore, resolveCommand } from "@/lib/commands";
import { OPEN_CMD } from "@/lib/keymap/events";

interface SearchHit {
  nseSymbol: string;
  name: string;
  sector: string | null;
}

interface Option {
  id: string;
  kind: string;
  code: string;
  label: string;
  meta: string;
  href: string;
}

const PLACEHOLDER = "DES RELIANCE · ANR INFY · SHIP ADANIPORTS · INTL TCS · MOV";

function currentSymbol(pathname: string | null): string | null {
  const m = pathname?.match(/^\/c\/([^/]+)/);
  return m?.[1] ? decodeURIComponent(m[1]).toUpperCase() : null;
}

function parse(raw: string) {
  const parts = raw.trim().toUpperCase().split(/\s+/).filter(Boolean);
  const [a, b] = parts;
  const fnA = a ? functionFor(a) : null;
  const fnB = b ? functionFor(b) : null;
  if (fnA && fnA.scope === "company") return { fn: fnA, term: b ?? "" };
  if (fnB && fnB.scope === "company") return { fn: fnB, term: a ?? "" };
  return { fn: fnA, term: parts.length === 1 ? (a ?? "") : parts.join(" ") };
}

export function CommandBar() {
  const router = useRouter();
  const pathname = usePathname();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const sym = currentSymbol(pathname);

  useEffect(() => {
    const onOpen = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
      setOpen(true);
    };
    document.addEventListener(OPEN_CMD, onOpen);
    return () => document.removeEventListener(OPEN_CMD, onOpen);
  }, []);

  const { fn, term } = useMemo(() => parse(value), [value]);

  useEffect(() => {
    const q = term.trim();
    if (!q || (fn && fn.scope === "global")) {
      setHits([]);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const t = window.setTimeout(() => {
      fetch(`/api/v1/search?q=${encodeURIComponent(q)}&limit=8`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((j: { results?: SearchHit[] }) => setHits(j.results ?? []))
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, 120);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [term, fn]);

  const options = useMemo<Option[]>(() => {
    const out: Option[] = [];
    const first = value.trim().toUpperCase().split(/\s+/)[0] ?? "";
    if (fn?.scope === "company") {
      for (const h of hits)
        out.push({
          id: `c-${fn.code}-${h.nseSymbol}`,
          kind: "EQUITY",
          code: `${fn.code} ${h.nseSymbol}`,
          label: h.name,
          meta: fn.label,
          href: `/c/${encodeURIComponent(h.nseSymbol)}/${fn.code.toLowerCase()}`,
        });
      if (!term && sym)
        out.push({
          id: `f-${fn.code}-${sym}`,
          kind: "FUNCTION",
          code: `${fn.code} ${sym}`,
          label: fn.label,
          meta: "current",
          href: `/c/${encodeURIComponent(sym)}/${fn.code.toLowerCase()}`,
        });
      return out;
    }
    if (!fn)
      for (const h of hits)
        out.push({
          id: `c-${h.nseSymbol}`,
          kind: "EQUITY",
          code: h.nseSymbol,
          label: h.name,
          meta: h.sector ?? "",
          href: `/c/${encodeURIComponent(h.nseSymbol)}/des`,
        });
    const ranked = FUNCTIONS.map((f) => ({
      f,
      s: Math.max(fuzzyScore(first, f.code), ...f.aliases.map((a) => fuzzyScore(first, a) - 5)),
    }))
      .filter((x) => (first ? x.s > 0 : true))
      .sort((a, b) => b.s - a.s);
    for (const { f } of ranked) {
      if (f.scope === "company" && !sym) continue;
      const href =
        (fn?.code === f.code ? resolveCommand(value, sym) : resolveCommand(f.code, sym)) ?? "/";
      out.push({
        id: `f-${f.code}`,
        kind: "FUNCTION",
        code: f.scope === "company" ? `${f.code} ${sym}` : f.code,
        label: f.label,
        meta: f.aliases.join(" "),
        href,
      });
    }
    return out.slice(0, 14);
  }, [fn, hits, sym, term, value]);

  const cur = Math.min(active, Math.max(options.length - 1, 0));

  const go = (href: string) => {
    setOpen(false);
    setValue("");
    inputRef.current?.blur();
    router.push(href);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive(Math.min(options.length - 1, cur + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(0, cur - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = open ? options[cur] : undefined;
      const href = opt?.href ?? resolveCommand(value.trim(), sym);
      if (href) go(href);
    } else if (e.key === "Escape") {
      if (value) {
        e.preventDefault();
        e.stopPropagation();
        setValue("");
      } else setOpen(false);
    }
  };

  const expanded = open && (options.length > 0 || value.trim().length > 0);
  const activeId = expanded && options[cur] ? `${listId}-${options[cur].id}` : undefined;
  return (
    <div className="cmd">
      <span className="cmd-prompt" aria-hidden="true">
        &gt;
      </span>
      <input
        ref={inputRef}
        className="cmd-input"
        type="text"
        role="combobox"
        aria-label="Command"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        placeholder={PLACEHOLDER}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      <div className="cmd-list scroll" id={listId} role="listbox" hidden={!expanded}>
        {options.map((o, i) => (
          <div
            key={o.id}
            id={`${listId}-${o.id}`}
            role="option"
            tabIndex={-1}
            className="cmd-option"
            aria-selected={i === cur}
            onMouseDown={(e) => {
              e.preventDefault();
              go(o.href);
            }}
            onMouseEnter={() => setActive(i)}
          >
            <span className="cmd-kind">{o.kind}</span>
            <span className="cmd-code">{o.code}</span>
            <span className="truncate">{o.label}</span>
            <span className="cmd-meta truncate">{o.meta}</span>
          </div>
        ))}
        {!options.length ? (
          <div className="cmd-empty">
            {loading ? "searching…" : "no match · ↵ runs the command as typed"}
          </div>
        ) : null}
      </div>
      <span className="sr-only" aria-live="polite">
        {expanded ? `${options.length} results` : ""}
      </span>
    </div>
  );
}
