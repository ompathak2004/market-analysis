"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Ext, Sym } from "@/components/ui/chip";
import { Empty } from "@/components/ui/empty";
import { Pane } from "@/components/ui/pane";
import { clampText, shortDate } from "@/lib/format";
import { focusedPane } from "@/lib/keymap/pane-focus";
import { rows, selectedRow, selectRow } from "@/lib/keymap/row-nav";
import { isTyping } from "@/lib/keymap/use-keymap";
import { sourceLabel } from "@/lib/splc";
import type { ReviewEvidence } from "@/server/queries";

interface Status {
  tone: "pos" | "neg" | "warn" | "info";
  text: string;
}

export function Party({
  symbol,
  name,
  kind,
  tab,
}: {
  symbol: string | null;
  name: string;
  kind: string;
  tab: "splc" | "infl";
}) {
  return (
    <span className="review-party">
      {symbol ? <Sym symbol={symbol} tab={tab} /> : null}
      <span className="bright truncate" title={name}>
        {name}
      </span>
      {symbol ? null : <span className="muted sm upper">{kind.replaceAll("_", " ")}</span>}
    </span>
  );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Quote({ ev }: { ev: ReviewEvidence }) {
  return (
    <blockquote className="review-quote">
      <span className="review-quote-text">“{clampText(ev.quote, 600)}”</span>
      <span className="review-quote-ref muted sm">
        {sourceLabel(ev.source)}
        {ev.page != null ? ` · p.${ev.page}` : ""}
        {ev.publishedAt ? ` · ${shortDate(ev.publishedAt)}` : ""} ·{" "}
        <Ext href={ev.url}>DOC #{ev.documentId}</Ext>
      </span>
    </blockquote>
  );
}

export function DecideButton({
  tone,
  disabled,
  onClick,
  children,
}: {
  tone: "pos" | "neg" | "warn";
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="admin-button"
      data-tone={tone}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const paneOf = (name: string) => document.querySelector<HTMLElement>(`[data-pane="${name}"]`);

function errorMessage(body: unknown, status: number): string {
  const msg = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof msg === "string" ? msg : `HTTP ${status}`;
}

interface QueueOptions<D extends string> {
  pane: string;
  endpoint: string;
  rowAttr: string;
  keys: Record<string, D>;
  doneLabel: Record<D, string>;
  refreshOn: readonly number[];
  fromRow: (row: HTMLElement) => { id: number; body: Record<string, unknown> } | null;
  arm?: { decision: D; ms: number; prompt: (id: number) => string };
}

export function useReviewQueue<D extends string>(opts: QueueOptions<D>) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [done, setDone] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const armed = useRef<{ id: number; at: number } | null>(null);
  const focusNext = useRef<number | null>(null);
  useEffect(() => {
    const pane = paneOf(opts.pane);
    if (!pane) return;
    const want = focusNext.current;
    focusNext.current = null;
    const target =
      (want != null
        ? pane.querySelector<HTMLElement>(`[data-row][data-${opts.rowAttr}="${want}"]`)
        : null) ??
      selectedRow(pane) ??
      rows(pane)[0] ??
      null;
    if (target && target !== selectedRow(pane)) selectRow(pane, target);
  });

  const decide = useCallback(
    async (id: number, decision: D, body: Record<string, unknown>) => {
      if (busy != null) return;
      if (opts.arm && decision === opts.arm.decision) {
        const a = armed.current;
        if (!a || a.id !== id || Date.now() - a.at > opts.arm.ms) {
          armed.current = { id, at: Date.now() };
          setStatus({ tone: "warn", text: opts.arm.prompt(id) });
          return;
        }
      }
      armed.current = null;
      const pane = paneOf(opts.pane);
      const list = pane ? rows(pane) : [];
      const idx = list.findIndex((r) => r.dataset[opts.rowAttr] === String(id));
      const neighbour = list[idx + 1] ?? list[idx - 1] ?? null;
      setBusy(id);
      setStatus({ tone: "info", text: `#${id} ${decision}…` });
      const trimmed = note.trim();
      try {
        const res = await fetch(opts.endpoint, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ ...body, decision, ...(trimmed ? { note: trimmed } : {}) }),
        });
        const resBody: unknown = await res.json().catch(() => null);
        if (res.status === 401) {
          router.push("/admin/login");
          return;
        }
        if (!res.ok) {
          setStatus({
            tone: "neg",
            text: `#${id} ${decision} failed: ${errorMessage(resBody, res.status)}`,
          });
          if (opts.refreshOn.includes(res.status)) startTransition(() => router.refresh());
          return;
        }
        focusNext.current = neighbour ? Number(neighbour.dataset[opts.rowAttr]) : null;
        setDone((prev) => new Set(prev).add(id));
        setNote("");
        setStatus({
          tone: decision === "confirm" ? "pos" : "warn",
          text: `#${id} ${opts.doneLabel[decision]}`,
        });
        startTransition(() => router.refresh());
      } catch (err) {
        setStatus({
          tone: "neg",
          text: `#${id} ${decision} failed: ${err instanceof Error ? err.message : "network error"}`,
        });
      } finally {
        setBusy(null);
      }
    },
    [busy, note, router, opts],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const decision = opts.keys[e.key];
      if (!decision || isTyping(e.target)) return;
      if (document.querySelector(".help-overlay:not([hidden])")) return;
      const pane = paneOf(opts.pane);
      if (!pane || focusedPane() !== pane) return;
      const row = selectedRow(pane);
      const target = row ? opts.fromRow(row) : null;
      if (!target) return;
      e.preventDefault();
      void decide(target.id, decision, target.body);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide, opts]);

  return { done, busy, note, setNote, status, decide };
}

export function ReviewPane({
  id,
  title,
  hints,
  noteLabel,
  idle,
  cursorParam,
  queue,
  nextCursor,
  paged,
  pending,
  actions,
  empty,
  children,
}: {
  id: string;
  title: string;
  hints: string;
  noteLabel: string;
  idle: string;
  cursorParam: string;
  queue: Pick<ReturnType<typeof useReviewQueue>, "done" | "note" | "setNote" | "status">;
  nextCursor: string | null;
  paged: boolean;
  pending: number;
  actions?: ReactNode;
  empty: { hint: string; text: string };
  children: ReactNode;
}) {
  const reviewed = queue.done.size;
  const meta = `${pending} pending${nextCursor ? "+" : ""}${reviewed ? ` · ${reviewed} reviewed` : ""}`;
  return (
    <Pane
      id={id}
      title={title}
      meta={meta}
      hints={hints}
      actions={
        <div className="review-toolbar">
          <input
            className="admin-input"
            aria-label={noteLabel}
            placeholder="note for next decision"
            maxLength={500}
            value={queue.note}
            onChange={(e) => queue.setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") e.currentTarget.blur();
            }}
          />
          {actions}
        </div>
      }
      foot={
        <div className="review-foot">
          <output className={queue.status ? queue.status.tone : "muted"} aria-live="polite">
            {queue.status?.text ?? idle}
          </output>
          <span className="grow" />
          {paged ? <Link href="/admin/review">⇤ first page</Link> : null}
          {nextCursor ? (
            <Link href={`/admin/review?${cursorParam}=${encodeURIComponent(nextCursor)}`}>
              next page →
            </Link>
          ) : null}
        </div>
      }
    >
      {pending ? (
        <div className="review-list">{children}</div>
      ) : (
        <Empty title="QUEUE EMPTY" hint={nextCursor ? "more items on the next page" : empty.hint}>
          {empty.text}
        </Empty>
      )}
    </Pane>
  );
}
