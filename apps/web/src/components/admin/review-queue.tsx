"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Badge, Ext, Sym } from "@/components/ui/chip";
import { Empty } from "@/components/ui/empty";
import { Pane } from "@/components/ui/pane";
import { clampText, compactInr, istDateTime, pct, shortDate } from "@/lib/format";
import { focusedPane } from "@/lib/keymap/pane-focus";
import { rows, selectedRow, selectRow } from "@/lib/keymap/row-nav";
import { isTyping } from "@/lib/keymap/use-keymap";
import {
  basisLabel,
  COST_BUCKET_LABEL,
  confidenceLabel,
  familyLabel,
  periodLabel,
  sourceLabel,
  VALUE_BASIS_TONE,
} from "@/lib/splc";
import type { Counterparty, ReviewDecision, ReviewQueueItem } from "@/server/queries";

const ENDPOINT = "/api/v1/admin/relationships/reviews";
const PANE = "review";
const BLOCK_ARM_MS = 4000;

const KEYS: Record<string, ReviewDecision> = { c: "confirm", r: "reject", b: "block" };

const DONE_LABEL: Record<ReviewDecision, string> = {
  confirm: "CONFIRMED",
  reject: "REJECTED",
  block: "BLOCKED",
};

interface Status {
  tone: "pos" | "neg" | "warn" | "info";
  text: string;
}

function Party({ party }: { party: Counterparty }) {
  return (
    <span className="review-party">
      {party.symbol ? <Sym symbol={party.symbol} tab="splc" /> : null}
      <span className="bright truncate" title={party.name}>
        {party.name}
      </span>
      {party.symbol ? null : <span className="muted sm upper">{party.kind}</span>}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ReviewItem({
  item,
  busy,
  onDecide,
}: {
  item: ReviewQueueItem;
  busy: boolean;
  onDecide: (id: number, decision: ReviewDecision) => void;
}) {
  const ev = item.evidence;
  const amount =
    item.valueCr == null
      ? "—"
      : item.currency && item.currency !== "INR"
        ? `${item.currency} ${item.valueCr}`
        : compactInr(item.valueCr);
  return (
    <article
      className="review-item"
      data-row
      data-observation={item.observationId}
      data-ext={ev?.url}
      aria-busy={busy || undefined}
    >
      <header className="review-head">
        <span className="muted num">#{item.observationId}</span>
        <Party party={item.supplier} />
        <span className="muted">SUPPLIES</span>
        <Party party={item.customer} />
        <span className="grow" />
        <Badge tone={VALUE_BASIS_TONE[item.valueBasis] ?? "neu"}>
          {basisLabel(item.valueBasis)}
        </Badge>
        {item.newCounterparty ? (
          <Badge tone="warn" title="Counterparty created by this extraction">
            NEW PARTY
          </Badge>
        ) : null}
        <span
          className={`review-conf num ${item.confidence < 0.6 ? "neg" : "warn"}`}
          title="Extractor confidence"
        >
          {confidenceLabel(item.confidence)}
        </span>
      </header>
      <p className="review-claim">{item.claim}</p>
      <dl className="review-facts">
        <Fact label="PCT">{item.pct == null ? "—" : pct(item.pct, 1, false)}</Fact>
        <Fact label="VALUE">{amount}</Fact>
        <Fact label="BUCKET">{COST_BUCKET_LABEL[item.costBucket] ?? item.costBucket}</Fact>
        <Fact label="PERIOD">{periodLabel(item.period)}</Fact>
        <Fact label="DISCLOSED BY">{item.disclosedBy.toUpperCase()}</Fact>
        <Fact label="KIND">{item.disclosureKind.replaceAll("_", " ").toUpperCase()}</Fact>
        {item.orderStatus ? <Fact label="ORDER">{item.orderStatus.toUpperCase()}</Fact> : null}
        <Fact label="SOURCE">{familyLabel(item.extractorFamily)}</Fact>
        <Fact label="FOCAL">
          <Sym symbol={item.focal.symbol} tab="splc" />
        </Fact>
        <Fact label="QUEUED">{istDateTime(item.createdAt)}</Fact>
      </dl>
      {ev ? (
        <blockquote className="review-quote">
          <span className="review-quote-text">“{clampText(ev.quote, 600)}”</span>
          <span className="review-quote-ref muted sm">
            {sourceLabel(ev.source)}
            {ev.page != null ? ` · p.${ev.page}` : ""}
            {ev.publishedAt ? ` · ${shortDate(ev.publishedAt)}` : ""} ·{" "}
            <Ext href={ev.url}>DOC #{ev.documentId}</Ext>
          </span>
        </blockquote>
      ) : (
        <p className="review-quote neg sm">NO EVIDENCE SPAN</p>
      )}
      <div className="review-buttons">
        <button
          type="button"
          className="admin-button"
          data-tone="pos"
          disabled={busy}
          onClick={() => onDecide(item.observationId, "confirm")}
        >
          CONFIRM <kbd>c</kbd>
        </button>
        <button
          type="button"
          className="admin-button"
          data-tone="neg"
          disabled={busy}
          onClick={() => onDecide(item.observationId, "reject")}
        >
          REJECT <kbd>r</kbd>
        </button>
        <button
          type="button"
          className="admin-button"
          data-tone="warn"
          disabled={busy}
          onClick={() => onDecide(item.observationId, "block")}
        >
          BLOCK PAIR <kbd>b</kbd>
        </button>
      </div>
    </article>
  );
}

function errorMessage(body: unknown, status: number): string {
  const msg = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof msg === "string" ? msg : `HTTP ${status}`;
}

export function ReviewQueue({
  items,
  nextCursor,
  paged,
  logout,
}: {
  items: ReviewQueueItem[];
  nextCursor: string | null;
  paged: boolean;
  logout: ReactNode;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [done, setDone] = useState<ReadonlyMap<number, ReviewDecision>>(new Map());
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const armed = useRef<{ id: number; at: number } | null>(null);
  const focusNext = useRef<number | null>(null);
  const visible = items.filter((i) => !done.has(i.observationId));

  useEffect(() => {
    const pane = document.querySelector<HTMLElement>(`[data-pane="${PANE}"]`);
    if (!pane) return;
    const want = focusNext.current;
    focusNext.current = null;
    const target =
      (want != null
        ? pane.querySelector<HTMLElement>(`[data-row][data-observation="${want}"]`)
        : null) ??
      selectedRow(pane) ??
      rows(pane)[0] ??
      null;
    if (target && target !== selectedRow(pane)) selectRow(pane, target);
  });

  const decide = useCallback(
    async (id: number, decision: ReviewDecision) => {
      if (busy != null) return;
      if (decision === "block") {
        const a = armed.current;
        if (!a || a.id !== id || Date.now() - a.at > BLOCK_ARM_MS) {
          armed.current = { id, at: Date.now() };
          setStatus({ tone: "warn", text: `Press b again to block pair #${id}` });
          return;
        }
      }
      armed.current = null;
      const pane = document.querySelector<HTMLElement>(`[data-pane="${PANE}"]`);
      const list = pane ? rows(pane) : [];
      const idx = list.findIndex((r) => r.dataset.observation === String(id));
      const neighbour = list[idx + 1] ?? list[idx - 1] ?? null;
      setBusy(id);
      setStatus({ tone: "info", text: `#${id} ${decision}…` });
      const trimmed = note.trim();
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            observationId: id,
            decision,
            ...(trimmed ? { note: trimmed } : {}),
          }),
        });
        const body: unknown = await res.json().catch(() => null);
        if (res.status === 401) {
          router.push("/admin/login");
          return;
        }
        if (!res.ok) {
          setStatus({
            tone: "neg",
            text: `#${id} ${decision} failed: ${errorMessage(body, res.status)}`,
          });
          if (res.status === 404) startTransition(() => router.refresh());
          return;
        }
        focusNext.current = neighbour ? Number(neighbour.dataset.observation) : null;
        setDone((prev) => new Map(prev).set(id, decision));
        setNote("");
        setStatus({
          tone: decision === "confirm" ? "pos" : "warn",
          text: `#${id} ${DONE_LABEL[decision]}`,
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
    [busy, note, router],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const decision = KEYS[e.key];
      if (!decision || isTyping(e.target)) return;
      if (document.querySelector(".help-overlay:not([hidden])")) return;
      const pane = document.querySelector<HTMLElement>(`[data-pane="${PANE}"]`);
      const focused = focusedPane();
      if (focused && focused !== pane) return;
      const row = pane ? selectedRow(pane) : null;
      const id = Number(row?.dataset.observation);
      if (!Number.isSafeInteger(id) || id <= 0) return;
      e.preventDefault();
      void decide(id, decision);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide]);

  const reviewed = done.size;
  const meta = `${visible.length} pending${nextCursor ? "+" : ""}${reviewed ? ` · ${reviewed} reviewed` : ""}`;
  return (
    <Pane
      id={PANE}
      title="REVIEW · SPLC OBSERVATIONS"
      meta={meta}
      hints="j/k rows · c confirm · r reject · b b block pair · ⇧↵ source · z zoom"
      actions={
        <div className="review-toolbar">
          <input
            className="admin-input"
            aria-label="Review note"
            placeholder="note for next decision"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") e.currentTarget.blur();
            }}
          />
          {logout}
        </div>
      }
      foot={
        <div className="review-foot">
          <output className={status ? status.tone : "muted"} aria-live="polite">
            {status?.text ?? "confidence < 80% or new counterparty · oldest first"}
          </output>
          <span className="grow" />
          {paged ? <Link href="/admin/review">⇤ first page</Link> : null}
          {nextCursor ? (
            <Link href={`/admin/review?cursor=${encodeURIComponent(nextCursor)}`}>next page →</Link>
          ) : null}
        </div>
      }
    >
      {visible.length ? (
        <div className="review-list">
          {visible.map((item) => (
            <ReviewItem
              key={item.observationId}
              item={item}
              busy={busy === item.observationId}
              onDecide={(id, d) => void decide(id, d)}
            />
          ))}
        </div>
      ) : (
        <Empty
          title="QUEUE EMPTY"
          hint={
            nextCursor
              ? "more items on the next page"
              : "new observations land after each extraction run"
          }
        >
          No pending observations below 80% confidence or with a new counterparty.
        </Empty>
      )}
    </Pane>
  );
}
