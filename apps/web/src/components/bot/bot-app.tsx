"use client";

import type { Citation, VizSpec } from "@ma/agent";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "./markdown";
import { Viz } from "./viz";

export interface PortfolioCard {
  id: string;
  name: string;
  thesis: string;
  risk: "low" | "medium" | "high";
  benchmark: string;
  holdings: number;
}

export interface SuggestionGroup {
  label: string;
  items: string[];
}

interface ToolStep {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "ok" | "error";
  ms: number | null;
  summary: string | null;
}

type TurnStatus = "streaming" | "ok" | "partial" | "failed" | "cancelled";

interface UITurn {
  key: string;
  user: string;
  portfolioId: string | null;
  text: string;
  status: TurnStatus;
  stage: string | null;
  tools: ToolStep[];
  charts: VizSpec[];
  citations: Citation[];
  message: string | null;
  traceId: string | null;
  model: string | null;
  ttftMs: number | null;
}

interface SavedChat {
  id: string;
  title: string;
  portfolioId: string | null;
  updatedAt: string;
}

const HISTORY_KEY = "ma:bot:history";
const PORTFOLIO_KEY = "ma:bot:portfolio";

const TOOL_LABEL: Record<string, string> = {
  portfolio_overview: "Valuing holdings",
  portfolio_performance: "Computing returns",
  portfolio_scenario: "Running scenario",
  portfolio_tax: "Estimating capital gains",
  portfolio_signals: "Reading proprietary signals",
  portfolio_news_impact: "Mapping news to holdings",
  supply_chain: "Walking the supply chain",
  event_impact: "Fitting event-impact model",
  company_lookup: "Resolving company",
  company_snapshot: "Loading company snapshot",
  company_financials: "Loading financials",
  company_prices: "Loading price history",
  broker_research: "Reading broker research",
  market_news: "Scanning filings & policy",
  tax_rules: "Loading tax rules",
  conversation_recall: "Recalling earlier turn",
};

const STAGE_LABEL: Record<string, string> = {
  thinking: "Planning",
  tools: "Running tools",
  answering: "Writing answer",
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function uuid(): string {
  return crypto.randomUUID();
}

function blankTurn(user: string, portfolioId: string | null): UITurn {
  return {
    key: uuid(),
    user,
    portfolioId,
    text: "",
    status: "streaming",
    stage: "thinking",
    tools: [],
    charts: [],
    citations: [],
    message: null,
    traceId: null,
    model: null,
    ttftMs: null,
  };
}

function argsLine(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ")
    .slice(0, 120);
}

export function BotApp({
  portfolios,
  suggestions,
}: {
  portfolios: PortfolioCard[];
  suggestions: SuggestionGroup[];
}) {
  const [portfolioId, setPortfolioId] = useState<string | null>(portfolios[0]?.id ?? null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<UITurn[]>([]);
  const [history, setHistory] = useState<SavedChat[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    setHistory(readJson<SavedChat[]>(HISTORY_KEY, []));
    const saved = readJson<string | null>(PORTFOLIO_KEY, null);
    if (saved && portfolios.some((p) => p.id === saved)) setPortfolioId(saved);
  }, [portfolios]);

  useEffect(() => {
    const el = logRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  });

  const patch = useCallback((key: string, fn: (t: UITurn) => UITurn) => {
    setTurns((all) => all.map((t) => (t.key === key ? fn(t) : t)));
  }, []);

  const remember = useCallback((id: string, title: string, pid: string | null) => {
    setHistory((h) => {
      const next = [
        { id, title: title.slice(0, 80), portfolioId: pid, updatedAt: new Date().toISOString() },
        ...h.filter((x) => x.id !== id),
      ].slice(0, 20);
      writeJson(HISTORY_KEY, next);
      return next;
    });
  }, []);

  const send = useCallback(
    async (raw: string) => {
      const message = raw.trim();
      if (!message || busy) return;
      setNotice(null);
      setDraft("");
      const turn = blankTurn(message, portfolioId);
      setTurns((t) => [...t, turn]);
      setBusy(true);
      stickRef.current = true;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      let convId = conversationId;
      try {
        const res = await fetch("/api/v1/bot/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationId, requestId: uuid(), portfolioId, message }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => null)) as {
            error?: { code?: string; message?: string };
          } | null;
          const retry = res.headers.get("retry-after");
          const msg =
            res.status === 429
              ? `Rate limit reached${retry ? `; retry in ${retry}s` : ""}. The assistant allows a few questions per 10 minutes.`
              : res.status === 409
                ? "This conversation is still answering another question."
                : (body?.error?.message ?? `Request failed (${res.status})`);
          patch(turn.key, (t) => ({ ...t, status: "failed", stage: null, message: msg }));
          return;
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let nl = buf.indexOf("\n");
          while (nl >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            nl = buf.indexOf("\n");
            if (!line.trim()) continue;
            const e = JSON.parse(line) as { type: string } & Record<string, unknown>;
            switch (e.type) {
              case "meta":
                convId = e.conversationId as string;
                setConversationId(convId);
                patch(turn.key, (t) => ({ ...t, traceId: e.traceId as string }));
                break;
              case "status":
                patch(turn.key, (t) => ({ ...t, stage: e.stage as string }));
                break;
              case "text":
                patch(turn.key, (t) => ({
                  ...t,
                  text: t.text + (e.delta as string),
                  stage: "answering",
                }));
                break;
              case "tool_start":
                patch(turn.key, (t) => ({
                  ...t,
                  tools: [
                    ...t.tools,
                    {
                      callId: e.callId as string,
                      name: e.name as string,
                      args: (e.args as Record<string, unknown>) ?? {},
                      status: "running",
                      ms: null,
                      summary: null,
                    },
                  ],
                }));
                break;
              case "tool_end":
                patch(turn.key, (t) => ({
                  ...t,
                  tools: t.tools.some((x) => x.callId === e.callId)
                    ? t.tools.map((x) =>
                        x.callId === e.callId
                          ? {
                              ...x,
                              status: e.ok ? "ok" : "error",
                              ms: e.ms as number,
                              summary: e.summary as string,
                            }
                          : x,
                      )
                    : [
                        ...t.tools,
                        {
                          callId: e.callId as string,
                          name: e.name as string,
                          args: {},
                          status: e.ok ? "ok" : "error",
                          ms: e.ms as number,
                          summary: e.summary as string,
                        },
                      ],
                }));
                break;
              case "chart":
                patch(turn.key, (t) => ({ ...t, charts: [...t.charts, e.spec as VizSpec] }));
                break;
              case "citations":
                patch(turn.key, (t) => ({ ...t, citations: e.citations as Citation[] }));
                break;
              case "done":
                patch(turn.key, (t) => ({
                  ...t,
                  status: e.status as TurnStatus,
                  stage: null,
                  message: (e.message as string | null) ?? null,
                  model: (e.model as string | null) ?? null,
                  ttftMs: (e.ttftMs as number | null) ?? null,
                }));
                break;
            }
          }
        }
        if (convId) remember(convId, turns[0]?.user ?? message, portfolioId);
      } catch (err) {
        const aborted = ctrl.signal.aborted;
        patch(turn.key, (t) => ({
          ...t,
          status: aborted ? "cancelled" : t.text ? "partial" : "failed",
          stage: null,
          message: aborted ? "Stopped." : "Connection lost while answering. Retry to continue.",
        }));
        if (!aborted) console.warn("bot stream failed", err);
      } finally {
        setTurns((all) =>
          all.map((t) =>
            t.key === turn.key && t.status === "streaming"
              ? {
                  ...t,
                  status: t.text ? "partial" : "failed",
                  stage: null,
                  message: t.message ?? "The answer ended unexpectedly.",
                }
              : t,
          ),
        );
        abortRef.current = null;
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy, conversationId, patch, portfolioId, remember, turns],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    setConversationId(null);
    setTurns([]);
    setNotice(null);
    inputRef.current?.focus();
  }, []);

  const openChat = useCallback(
    async (c: SavedChat) => {
      if (busy) return;
      setNotice(null);
      const res = await fetch(`/api/v1/bot/conversations/${c.id}`).catch(() => null);
      if (!res?.ok) {
        setHistory((h) => {
          const next = h.filter((x) => x.id !== c.id);
          writeJson(HISTORY_KEY, next);
          return next;
        });
        setNotice("That conversation has expired (chats are kept for 7 days).");
        return;
      }
      const conv = (await res.json()) as {
        id: string;
        portfolioId: string | null;
        turns: Array<{
          id: string;
          user: string;
          assistant: string;
          status: TurnStatus;
          portfolioId: string | null;
          tools: Array<{ callId: string; name: string; ok: boolean; summary: string }>;
          citations: Citation[];
          charts: VizSpec[];
        }>;
      };
      setConversationId(conv.id);
      if (conv.portfolioId) setPortfolioId(conv.portfolioId);
      setTurns(
        conv.turns.map((t) => ({
          key: t.id,
          user: t.user,
          portfolioId: t.portfolioId,
          text: t.assistant,
          status: t.status,
          stage: null,
          tools: t.tools.map((x) => ({
            callId: x.callId,
            name: x.name,
            args: {},
            status: x.ok ? "ok" : "error",
            ms: null,
            summary: x.summary,
          })),
          charts: t.charts,
          citations: t.citations,
          message: null,
          traceId: null,
          model: null,
          ttftMs: null,
        })),
      );
    },
    [busy],
  );

  const forget = useCallback(async (c: SavedChat) => {
    await fetch(`/api/v1/bot/conversations/${c.id}`, { method: "DELETE" }).catch(() => null);
    setHistory((h) => {
      const next = h.filter((x) => x.id !== c.id);
      writeJson(HISTORY_KEY, next);
      return next;
    });
  }, []);

  const choosePortfolio = (id: string) => {
    setPortfolioId(id);
    writeJson(PORTFOLIO_KEY, id);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    } else if (e.key === "Escape" && busy) {
      e.preventDefault();
      cancel();
    }
  };

  const selected = portfolios.find((p) => p.id === portfolioId) ?? null;
  const lastUser = [...turns]
    .reverse()
    .find((t) => t.status === "failed" || t.status === "partial" || t.status === "cancelled");

  return (
    <>
      <aside className="bot-rail" aria-label="Assistant controls">
        <section className="bot-block">
          <h2 className="bot-block-title">Demo portfolio</h2>
          <fieldset className="bot-portfolios">
            <legend className="sr-only">Demo portfolio</legend>
            {portfolios.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={p.id === portfolioId}
                className="bot-portfolio"
                onClick={() => choosePortfolio(p.id)}
              >
                <span className="bot-portfolio-name">{p.name}</span>
                <span className="bot-portfolio-meta">
                  <span
                    className="badge"
                    data-tone={p.risk === "high" ? "neg" : p.risk === "low" ? "pos" : "warn"}
                  >
                    {p.risk}
                  </span>
                  {p.holdings} holdings · vs {p.benchmark}
                </span>
              </button>
            ))}
          </fieldset>
          {selected ? <p className="bot-thesis">{selected.thesis}</p> : null}
          <p className="bot-synthetic">Synthetic ledgers valued at real NSE closes.</p>
        </section>
        <section className="bot-block bot-history">
          <div className="bot-block-head">
            <h2 className="bot-block-title">Chats</h2>
            <button type="button" className="chip" onClick={newChat}>
              + New
            </button>
          </div>
          {history.length ? (
            <ul>
              {history.map((c) => (
                <li key={c.id} data-active={c.id === conversationId ? "true" : undefined}>
                  <button
                    type="button"
                    className="bot-history-open truncate"
                    onClick={() => void openChat(c)}
                    title={c.title}
                  >
                    {c.title}
                  </button>
                  <button
                    type="button"
                    className="bot-history-del"
                    aria-label={`Delete chat ${c.title}`}
                    onClick={() => void forget(c)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No saved chats yet.</p>
          )}
        </section>
      </aside>

      <section
        className="bot-main pane"
        aria-labelledby="bot-title"
        data-pane="bot"
        data-hints="↵ send · ⇧↵ newline · esc stop"
      >
        <header className="pane-head">
          <h1 className="pane-title" id="bot-title">
            Analyst
          </h1>
          <span className="pane-meta truncate">
            {selected ? `${selected.name} · ` : ""}grounded in MA data · not investment advice
          </span>
          <div className="pane-actions">
            <label className="bot-select">
              <span className="sr-only">Portfolio</span>
              <select value={portfolioId ?? ""} onChange={(e) => choosePortfolio(e.target.value)}>
                {portfolios.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="chip" onClick={newChat}>
              New chat
            </button>
          </div>
        </header>
        <div
          className="bot-log scroll"
          ref={logRef}
          role="log"
          aria-live="polite"
          aria-busy={busy}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {turns.length === 0 ? (
            <div className="bot-empty">
              <p className="bot-empty-lead">
                Ask about the selected portfolio, any NSE company, news exposure, our supply-chain
                and alt-data signals, or Indian capital-gains tax.
              </p>
              {suggestions.map((g) => (
                <div key={g.label} className="bot-suggest">
                  <h3>{g.label}</h3>
                  <div className="chipset">
                    {g.items.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className="chip"
                        onClick={() => void send(s)}
                        disabled={busy}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            turns.map((t) => <Turn key={t.key} turn={t} />)
          )}
          {notice ? <p className="bot-notice">{notice}</p> : null}
        </div>
        <form
          className="bot-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft);
          }}
        >
          <label htmlFor="bot-input" className="sr-only">
            Message
          </label>
          <textarea
            id="bot-input"
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            rows={2}
            maxLength={2000}
            placeholder={
              selected ? `Ask about ${selected.name}, a company, news or tax…` : "Ask a question…"
            }
            autoComplete="off"
          />
          <div className="bot-composer-actions">
            {busy ? (
              <button type="button" className="bot-btn" data-variant="stop" onClick={cancel}>
                Stop
              </button>
            ) : (
              <>
                {lastUser && !draft ? (
                  <button
                    type="button"
                    className="bot-btn"
                    data-variant="ghost"
                    onClick={() => void send(lastUser.user)}
                  >
                    Retry
                  </button>
                ) : null}
                <button type="submit" className="bot-btn" disabled={!draft.trim()}>
                  Send
                </button>
              </>
            )}
          </div>
        </form>
      </section>
    </>
  );
}

function Turn({ turn }: { turn: UITurn }) {
  const scope = turn.key.replace(/[^a-zA-Z0-9-]/g, "");
  const known = new Set(turn.citations.map((c) => c.id));
  const jump = (id: string) => {
    const el = document.getElementById(`src-${scope}-${id}`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el?.classList.add("flash");
    setTimeout(() => el?.classList.remove("flash"), 1200);
  };
  const cite = (id: string) =>
    known.has(id) ? (
      <button type="button" className="cite" onClick={() => jump(id)} aria-label={`Source ${id}`}>
        {id}
      </button>
    ) : (
      <span className="cite" data-unknown="true" title="Source from an earlier answer">
        {id}
      </span>
    );
  const cited = new Set([...turn.text.matchAll(/\[\s*(S\d{1,3})\s*\]/g)].map((m) => m[1]));
  const sources = [...turn.citations].sort(
    (a, b) => Number(cited.has(b.id)) - Number(cited.has(a.id)),
  );
  return (
    <article className="bot-turn" data-status={turn.status}>
      <div className="bot-user">
        <span className="bot-who">YOU</span>
        <p>{turn.user}</p>
      </div>
      <div className="bot-answer">
        <span className="bot-who">MA</span>
        <div className="bot-answer-body">
          {turn.tools.length ? (
            <ol className="bot-steps" aria-label="Tool calls">
              {turn.tools.map((s) => (
                <li key={s.callId} data-status={s.status} title={s.summary ?? undefined}>
                  <span className="bot-step-dot" aria-hidden="true" />
                  <span className="bot-step-name">{TOOL_LABEL[s.name] ?? s.name}</span>
                  <span className="bot-step-args truncate">{argsLine(s.args)}</span>
                  <span className="bot-step-ms">
                    {s.status === "running" ? "…" : s.ms != null ? `${s.ms}ms` : s.status}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
          {turn.status === "streaming" && !turn.text ? (
            <p className="bot-stage" role="status">
              {STAGE_LABEL[turn.stage ?? "thinking"] ?? "Working"}
              <span className="bot-caret" aria-hidden="true" />
            </p>
          ) : null}
          {turn.text ? <Markdown text={turn.text} cite={cite} /> : null}
          {turn.status === "streaming" && turn.text ? (
            <span className="bot-caret" aria-hidden="true" />
          ) : null}
          {turn.charts.length ? (
            <div className="bot-viz">
              {turn.charts.map((c) => (
                <Viz key={c.id} spec={c} onSource={jump} />
              ))}
            </div>
          ) : null}
          {turn.message ? (
            <p className="bot-error" role="alert" data-status={turn.status}>
              {turn.message}
            </p>
          ) : null}
          {sources.length ? (
            <details className="bot-sources" open={cited.size > 0}>
              <summary>
                Sources ({cited.size} cited · {sources.length} retrieved)
              </summary>
              <ol>
                {sources.map((c) => (
                  <li
                    key={c.id}
                    id={`src-${scope}-${c.id}`}
                    data-cited={cited.has(c.id) ? "true" : undefined}
                  >
                    <span className="cite">{c.id}</span>
                    <span className="badge">{c.kind}</span>
                    {c.url ? (
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate"
                      >
                        {c.label}
                      </a>
                    ) : (
                      <span className="truncate">{c.label}</span>
                    )}
                    {c.publishedAt ? <time>{c.publishedAt.slice(0, 10)}</time> : null}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          {turn.status !== "streaming" && (turn.model || turn.traceId) ? (
            <p className="bot-meta">
              {turn.model ? `${turn.model}` : ""}
              {turn.ttftMs != null ? ` · first token ${(turn.ttftMs / 1000).toFixed(1)}s` : ""}
              {turn.traceId ? ` · trace ${turn.traceId.slice(0, 8)}` : ""}
            </p>
          ) : null}
        </div>
      </div>
    </article>
  );
}
