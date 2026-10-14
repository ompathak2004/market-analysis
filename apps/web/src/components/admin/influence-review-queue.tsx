"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Ext, Sym } from "@/components/ui/chip";
import { Empty } from "@/components/ui/empty";
import { Pane } from "@/components/ui/pane";
import { clampText, istDateTime, shortDate } from "@/lib/format";
import { focusedPane } from "@/lib/keymap/pane-focus";
import { rows, selectedRow, selectRow } from "@/lib/keymap/row-nav";
import { isTyping } from "@/lib/keymap/use-keymap";
import { confidenceLabel, sourceLabel } from "@/lib/splc";
import type { InfluenceDecision, InfluenceReviewItem, InfluenceReviewNode } from "@/server/queries";

const ENDPOINT = "/api/v1/admin/influence/reviews";
export const INFLUENCE_REVIEW_PANE = "review-infl";

const KEYS: Record<string, InfluenceDecision> = { c: "confirm", r: "reject" };

const DONE_LABEL: Record<InfluenceDecision, string> = {
  confirm: "CONFIRMED",
  reject: "REJECTED",
};

const KIND_LABEL: Record<string, string> = {
  holds_office: "HOLDS OFFICE",
  declared_interest: "DECLARED INTEREST IN",
  declared_family: "DECLARED FAMILY",
  director_of: "DIRECTOR OF",
  promoter_of: "PROMOTER OF",
  owns: "OWNS",
  related_party: "RELATED PARTY OF",
  donated_to: "DONATED TO",
  policy_applies_to: "APPLIES TO",
  operates_in_sector: "OPERATES IN",
  member_of_party: "MEMBER OF",
};

interface Status {
  tone: "pos" | "neg" | "warn" | "info";
  text: string;
}

function Node({ node }: { node: InfluenceReviewNode }) {
  return (
    <span className="review-party">
      {node.symbol ? <Sym symbol={node.symbol} tab="infl" /> : null}
      <span className="bright truncate" title={node.label}>
        {node.label}
      </span>
      {node.symbol ? null : (
        <span className="muted sm upper">{node.kind.replaceAll("_", " ")}</span>
      )}
    </span>
  );
}

function EdgeItem({
  item,
  busy,
  onDecide,
}: {
  item: InfluenceReviewItem;
  busy: boolean;
  onDecide: (id: number, version: number, decision: InfluenceDecision) => void;
}) {
  const ev = item.evidence[0];
  const span =
    item.validFrom || item.validTo
      ? `${item.validFrom ? shortDate(item.validFrom) : "—"} → ${item.validTo ? shortDate(item.validTo) : "now"}`
      : "—";
  return (
    <article
      className="review-item"
      data-row
      data-edge={item.edgeId}
      data-version={item.version}
      data-ext={ev?.url}
      aria-busy={busy || undefined}
    >
      <header className="review-head">
        <span className="muted num">#{item.edgeId}</span>
        <Node node={item.from} />
        <span className="muted">{KIND_LABEL[item.kind] ?? item.kind.toUpperCase()}</span>
        <Node node={item.to} />
        <span className="grow" />
        <span
          className={`review-conf num ${item.confidence <= 0.6 ? "neg" : "warn"}`}
          title="Resolver confidence"
        >
          {confidenceLabel(item.confidence)}
        </span>
      </header>
      {item.detail ? <p className="review-claim">{item.detail}</p> : null}
      <dl className="review-facts">
        <div>
          <dt>VALID</dt>
          <dd>{span}</dd>
        </div>
        <div>
          <dt>VERSION</dt>
          <dd>{item.version}</dd>
        </div>
        <div>
          <dt>QUEUED</dt>
          <dd>{istDateTime(item.createdAt)}</dd>
        </div>
      </dl>
      {item.evidence.length ? (
        item.evidence.map((e) => (
          <blockquote
            key={`${e.documentId}:${e.page ?? ""}:${e.quote.slice(0, 40)}`}
            className="review-quote"
          >
            <span className="review-quote-text">“{clampText(e.quote, 600)}”</span>
            <span className="review-quote-ref muted sm">
              {sourceLabel(e.source)}
              {e.page != null ? ` · p.${e.page}` : ""}
              {e.publishedAt ? ` · ${shortDate(e.publishedAt)}` : ""} ·{" "}
              <Ext href={e.url}>DOC #{e.documentId}</Ext>
            </span>
          </blockquote>
        ))
      ) : (
        <p className="review-quote neg sm">NO EVIDENCE SPAN · cannot become public</p>
      )}
      <div className="review-buttons">
        <button
          type="button"
          className="admin-button"
          data-tone="pos"
          disabled={busy}
          onClick={() => onDecide(item.edgeId, item.version, "confirm")}
        >
          CONFIRM <kbd>c</kbd>
        </button>
        <button
          type="button"
          className="admin-button"
          data-tone="neg"
          disabled={busy}
          onClick={() => onDecide(item.edgeId, item.version, "reject")}
        >
          REJECT <kbd>r</kbd>
        </button>
      </div>
    </article>
  );
}

function errorMessage(body: unknown, status: number): string {
  const msg = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof msg === "string" ? msg : `HTTP ${status}`;
}

export function InfluenceReviewQueue({
  items,
  nextCursor,
  paged,
}: {
  items: InfluenceReviewItem[];
  nextCursor: string | null;
  paged: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [done, setDone] = useState<ReadonlyMap<number, InfluenceDecision>>(new Map());
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const focusNext = useRef<number | null>(null);
  const visible = items.filter((i) => !done.has(i.edgeId));

  useEffect(() => {
    const pane = document.querySelector<HTMLElement>(`[data-pane="${INFLUENCE_REVIEW_PANE}"]`);
    if (!pane) return;
    const want = focusNext.current;
    focusNext.current = null;
    const target =
      (want != null ? pane.querySelector<HTMLElement>(`[data-row][data-edge="${want}"]`) : null) ??
      selectedRow(pane) ??
      rows(pane)[0] ??
      null;
    if (target && target !== selectedRow(pane)) selectRow(pane, target);
  });

  const decide = useCallback(
    async (id: number, version: number, decision: InfluenceDecision) => {
      if (busy != null) return;
      const pane = document.querySelector<HTMLElement>(`[data-pane="${INFLUENCE_REVIEW_PANE}"]`);
      const list = pane ? rows(pane) : [];
      const idx = list.findIndex((r) => r.dataset.edge === String(id));
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
            edgeId: id,
            decision,
            expectedVersion: version,
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
          if (res.status === 404 || res.status === 409) startTransition(() => router.refresh());
          return;
        }
        focusNext.current = neighbour ? Number(neighbour.dataset.edge) : null;
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
      const pane = document.querySelector<HTMLElement>(`[data-pane="${INFLUENCE_REVIEW_PANE}"]`);
      if (!pane || focusedPane() !== pane) return;
      const row = selectedRow(pane);
      const id = Number(row?.dataset.edge);
      const version = Number(row?.dataset.version);
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(version)) return;
      e.preventDefault();
      void decide(id, version, decision);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide]);

  const reviewed = done.size;
  const meta = `${visible.length} pending${nextCursor ? "+" : ""}${reviewed ? ` · ${reviewed} reviewed` : ""}`;
  return (
    <Pane
      id={INFLUENCE_REVIEW_PANE}
      title="REVIEW · INFLUENCE EDGES"
      meta={meta}
      hints="tab focus · j/k rows · c confirm · r reject · ⇧↵ source · z zoom"
      actions={
        <div className="review-toolbar">
          <input
            className="admin-input"
            aria-label="Influence review note"
            placeholder="note for next decision"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") e.currentTarget.blur();
            }}
          />
        </div>
      }
      foot={
        <div className="review-foot">
          <output className={status ? status.tone : "muted"} aria-live="polite">
            {status?.text ?? "single-document name matches and news · oldest first"}
          </output>
          <span className="grow" />
          {paged ? <Link href="/admin/review">⇤ first page</Link> : null}
          {nextCursor ? (
            <Link href={`/admin/review?infl=${encodeURIComponent(nextCursor)}`}>next page →</Link>
          ) : null}
        </div>
      }
    >
      {visible.length ? (
        <div className="review-list">
          {visible.map((item) => (
            <EdgeItem
              key={item.edgeId}
              item={item}
              busy={busy === item.edgeId}
              onDecide={(id, v, d) => void decide(id, v, d)}
            />
          ))}
        </div>
      ) : (
        <Empty
          title="QUEUE EMPTY"
          hint={nextCursor ? "more items on the next page" : "pending edges land after each sync"}
        >
          No pending influence edges. Confirmed edges appear in the INFL tab.
        </Empty>
      )}
    </Pane>
  );
}
