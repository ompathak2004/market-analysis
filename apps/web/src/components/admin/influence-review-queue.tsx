"use client";

import { istDateTime, shortDate } from "@/lib/format";
import { confidenceLabel } from "@/lib/splc";
import type { InfluenceDecision, InfluenceReviewItem } from "@/server/queries";
import { DecideButton, Fact, Party, Quote, ReviewPane, useReviewQueue } from "./review-shared";

const PANE = "review-infl";

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

const QUEUE = {
  pane: PANE,
  endpoint: "/api/v1/admin/influence/reviews",
  rowAttr: "edge",
  keys: { c: "confirm", r: "reject" } as Record<string, InfluenceDecision>,
  doneLabel: { confirm: "CONFIRMED", reject: "REJECTED" },
  refreshOn: [404, 409],
  fromRow: (row: HTMLElement) => {
    const id = Number(row.dataset.edge);
    const version = Number(row.dataset.version);
    return Number.isSafeInteger(id) && id > 0 && Number.isSafeInteger(version)
      ? { id, body: { edgeId: id, expectedVersion: version } }
      : null;
  },
};

function EdgeItem({
  item,
  busy,
  onDecide,
}: {
  item: InfluenceReviewItem;
  busy: boolean;
  onDecide: (decision: InfluenceDecision) => void;
}) {
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
      data-ext={item.evidence[0]?.url}
      aria-busy={busy || undefined}
    >
      <header className="review-head">
        <span className="muted num">#{item.edgeId}</span>
        <Party symbol={item.from.symbol} name={item.from.label} kind={item.from.kind} tab="infl" />
        <span className="muted">{KIND_LABEL[item.kind] ?? item.kind.toUpperCase()}</span>
        <Party symbol={item.to.symbol} name={item.to.label} kind={item.to.kind} tab="infl" />
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
        <Fact label="VALID">{span}</Fact>
        <Fact label="VERSION">{item.version}</Fact>
        <Fact label="QUEUED">{istDateTime(item.createdAt)}</Fact>
      </dl>
      {item.evidence.length ? (
        item.evidence.map((e) => (
          <Quote key={`${e.documentId}:${e.page ?? ""}:${e.quote.slice(0, 40)}`} ev={e} />
        ))
      ) : (
        <p className="review-quote neg sm">NO EVIDENCE SPAN · cannot become public</p>
      )}
      <div className="review-buttons">
        <DecideButton tone="pos" disabled={busy} onClick={() => onDecide("confirm")}>
          CONFIRM <kbd>c</kbd>
        </DecideButton>
        <DecideButton tone="neg" disabled={busy} onClick={() => onDecide("reject")}>
          REJECT <kbd>r</kbd>
        </DecideButton>
      </div>
    </article>
  );
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
  const queue = useReviewQueue(QUEUE);
  const visible = items.filter((i) => !queue.done.has(i.edgeId));
  return (
    <ReviewPane
      id={PANE}
      title="REVIEW · INFLUENCE EDGES"
      hints="tab focus · j/k rows · c confirm · r reject · ⇧↵ source · z zoom"
      noteLabel="Influence review note"
      idle="single-document name matches and news · oldest first"
      cursorParam="infl"
      queue={queue}
      nextCursor={nextCursor}
      paged={paged}
      pending={visible.length}
      empty={{
        hint: "pending edges land after each sync",
        text: "No pending influence edges. Confirmed edges appear in the INFL tab.",
      }}
    >
      {visible.map((item) => (
        <EdgeItem
          key={item.edgeId}
          item={item}
          busy={queue.busy === item.edgeId}
          onDecide={(d) =>
            void queue.decide(item.edgeId, d, {
              edgeId: item.edgeId,
              expectedVersion: item.version,
            })
          }
        />
      ))}
    </ReviewPane>
  );
}
