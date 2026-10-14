"use client";

import type { ReactNode } from "react";
import { Badge, Sym } from "@/components/ui/chip";
import { compactInr, istDateTime, pct } from "@/lib/format";
import {
  basisLabel,
  COST_BUCKET_LABEL,
  confidenceLabel,
  familyLabel,
  periodLabel,
  VALUE_BASIS_TONE,
} from "@/lib/splc";
import type { ReviewDecision, ReviewQueueItem } from "@/server/queries";
import { DecideButton, Fact, Party, Quote, ReviewPane, useReviewQueue } from "./review-shared";

const PANE = "review";

const QUEUE = {
  pane: PANE,
  endpoint: "/api/v1/admin/relationships/reviews",
  rowAttr: "observation",
  keys: { c: "confirm", r: "reject", b: "block" } as Record<string, ReviewDecision>,
  doneLabel: { confirm: "CONFIRMED", reject: "REJECTED", block: "BLOCKED" },
  refreshOn: [404],
  fromRow: (row: HTMLElement) => {
    const id = Number(row.dataset.observation);
    return Number.isSafeInteger(id) && id > 0 ? { id, body: { observationId: id } } : null;
  },
  arm: {
    decision: "block" as const,
    ms: 4000,
    prompt: (id: number) => `Press b again to block pair #${id}`,
  },
};

function ReviewItem({
  item,
  busy,
  onDecide,
}: {
  item: ReviewQueueItem;
  busy: boolean;
  onDecide: (decision: ReviewDecision) => void;
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
        <Party {...item.supplier} tab="splc" />
        <span className="muted">SUPPLIES</span>
        <Party {...item.customer} tab="splc" />
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
      {ev ? <Quote ev={ev} /> : <p className="review-quote neg sm">NO EVIDENCE SPAN</p>}
      <div className="review-buttons">
        <DecideButton tone="pos" disabled={busy} onClick={() => onDecide("confirm")}>
          CONFIRM <kbd>c</kbd>
        </DecideButton>
        <DecideButton tone="neg" disabled={busy} onClick={() => onDecide("reject")}>
          REJECT <kbd>r</kbd>
        </DecideButton>
        <DecideButton tone="warn" disabled={busy} onClick={() => onDecide("block")}>
          BLOCK PAIR <kbd>b</kbd>
        </DecideButton>
      </div>
    </article>
  );
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
  const queue = useReviewQueue(QUEUE);
  const visible = items.filter((i) => !queue.done.has(i.observationId));
  return (
    <ReviewPane
      id={PANE}
      title="REVIEW · SPLC OBSERVATIONS"
      hints="j/k rows · c confirm · r reject · b b block pair · ⇧↵ source · z zoom"
      noteLabel="Review note"
      idle="confidence < 80% or new counterparty · oldest first"
      cursorParam="cursor"
      queue={queue}
      nextCursor={nextCursor}
      paged={paged}
      pending={visible.length}
      actions={logout}
      empty={{
        hint: "new observations land after each extraction run",
        text: "No pending observations below 80% confidence or with a new counterparty.",
      }}
    >
      {visible.map((item) => (
        <ReviewItem
          key={item.observationId}
          item={item}
          busy={queue.busy === item.observationId}
          onDecide={(d) =>
            void queue.decide(item.observationId, d, { observationId: item.observationId })
          }
        />
      ))}
    </ReviewPane>
  );
}
