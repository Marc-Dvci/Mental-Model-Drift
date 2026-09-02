import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  daysAgo,
  fmt,
  shortDate,
  type ClaimRow,
  type Coverage,
  type DriftCard,
  type Status,
  type Timeline as TimelineData,
} from './api.ts';
import { Timeline } from './Timeline.tsx';
import { Tour } from './Tour.tsx';

type Tab = 'drift' | 'heard' | 'sources';

export interface Notice {
  tone: 'ok' | 'bad';
  title: string;
  body?: string;
}

interface FeedItem {
  id: number;
  at: string;
  kind: string;
  primary: string;
  secondary?: string;
  tone: 'neutral' | 'candidate' | 'drift' | 'supported' | 'quiet' | 'system';
  replay?: boolean;
}

export function App() {
  const [tab, setTab] = useState<Tab>('drift');
  const [status, setStatus] = useState<Status | null>(null);
  const [drifts, setDrifts] = useState<DriftCard[]>([]);
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  // Acting on a card can move it from the open list to the resolved one, which
  // remounts it. The result of the action has to outlive that, so it is held
  // here by drift id rather than inside the card.
  const [notices, setNotices] = useState<Record<string, Notice>>({});
  const feedId = useRef(0);

  const setNotice = useCallback((id: string, notice: Notice) => {
    setNotices((n) => ({ ...n, [id]: notice }));
  }, []);

  const refresh = useCallback(async () => {
    const [s, d, c] = await Promise.allSettled([api.status(), api.drifts(), api.claims()]);
    if (s.status === 'fulfilled') setStatus(s.value);
    if (d.status === 'fulfilled') setDrifts(d.value);
    if (c.status === 'fulfilled') setClaims(c.value);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 8000);
    return () => clearInterval(t);
  }, [refresh]);

  // The live feed exists so the pipeline is legible while it runs: every
  // utterance, every rejection with its reason, every source read. A product
  // that tells people they are wrong should show its working. The server
  // replays what it has already emitted, so this panel is populated for
  // someone who opens the dashboard after the conversation is over.
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as Record<string, unknown>;
      const item = toFeedItem(event, ++feedId.current);
      if (item) setFeed((f) => [item, ...f].slice(0, 80));
      if (['drift', 'verdict', 'reconcile'].includes(String(event.type)) && event.replay !== true) void refresh();
    };
    return () => source.close();
  }, [refresh]);

  const open = drifts.filter((d) => d.drift.resolution === 'OPEN');
  const closed = drifts.filter((d) => d.drift.resolution !== 'OPEN');
  const card = selected ? drifts.find((d) => d.drift.id === selected) : undefined;
  const tour = useMemo(() => new URLSearchParams(location.search).has('tour'), []);

  return (
    <div className={`app${tour ? ' touring' : ''}`}>
      <Header status={status} openCount={open.length} />

      <div className="layout">
        <main>
          <nav className="tabs" role="tablist">
            {(
              [
                ['drift', `Drift${open.length ? ` (${open.length})` : ''}`],
                ['heard', `Heard (${claims.length})`],
                ['sources', 'Sources'],
              ] as [Tab, string][]
            ).map(([key, label]) => (
              <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </nav>

          {tab === 'drift' && (
            <>
              <Ledger status={status} claims={claims} openCount={open.length} />
              <DriftList
                open={open}
                closed={closed}
                onSelect={setSelected}
                selected={selected}
                onChanged={refresh}
                notices={notices}
                setNotice={setNotice}
              />
            </>
          )}
          {tab === 'heard' && <HeardList claims={claims} />}
          {tab === 'sources' && <Sources status={status} />}
        </main>

        <aside className="feed">
          <h2>Live capture</h2>
          <p className="muted small">
            Everything Bee sends, and what the pipeline did with it.
          </p>
          {feed.length === 0 && <p className="muted small">Waiting for utterances.</p>}
          <ol>
            {feed.map((f) => (
              <li key={f.id} data-kind={f.kind} className={`feed-${f.tone}${f.replay ? ' replayed' : ''}`}>
                <span className="feed-kind">{f.kind}</span>
                <span className="feed-primary">{f.primary}</span>
                {f.secondary && <span className="feed-secondary">{f.secondary}</span>}
              </li>
            ))}
          </ol>
        </aside>
      </div>

      {card && <Detail card={card} onClose={() => setSelected(null)} onChanged={refresh} />}
      {tour && <Tour controls={{ setTab, setSelected, refresh }} />}
    </div>
  );
}

// ---------------------------------------------------------------------- header

function Header({ status, openCount }: { status: Status | null; openCount: number }) {
  const beeOk = status?.bee.connected;
  return (
    <header>
      <div className="brand">
        <span className="mark" aria-hidden="true" />
        <div>
          <h1>Mental Model Drift</h1>
          <p>Your system changes every day. Your mental model doesn&rsquo;t.</p>
        </div>
      </div>
      <div className="chips">
        <span className={`chip ${beeOk ? 'ok' : 'bad'}`} title={status?.bee.detail}>
          <span className="dot" /> Bee {beeOk ? 'connected' : 'unavailable'}
        </span>
        <span className="chip">{status?.bee.transport ?? '—'}</span>
        <span className="chip">{status?.mode === 'live' ? 'live sources' : 'local sources'}</span>
        <span className="chip">{status?.proposers ?? '—'}</span>
        <span className={`chip ${openCount ? 'warn' : ''}`}>{openCount} open</span>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------- ledger

/**
 * How much was heard, against how little was said about it.
 *
 * This is the honest headline for a product that reads someone's conversations:
 * not how much it found, but the ratio between what it listened to and what it
 * decided was worth interrupting a person over.
 */
function Ledger({ status, claims, openCount }: { status: Status | null; claims: ClaimRow[]; openCount: number }) {
  const m = status?.metrics ?? {};
  const heard = (m.BeeEventsReceived ?? 0) + (m.BeeEventsReconciled ?? 0);
  const supported = claims.filter((c) => c.claim.status === 'SUPPORTED').length;
  if (heard === 0) return null;

  const cells: [string, number, string][] = [
    ['heard', heard, 'utterances Bee delivered, live and reconciled'],
    ['checkable', claims.length, 'about a property the registry can settle'],
    ['agreed', supported, 'matched production, so no card was raised'],
    ['drifted', openCount, 'disagreed with production'],
  ];

  return (
    <section className="ledger" aria-label="What was heard, and what was said about it">
      {cells.map(([name, value, why]) => (
        <div key={name} className={name === 'drifted' && openCount > 0 ? 'ledger-cell hot' : 'ledger-cell'}>
          <span className="ledger-value mono">{value}</span>
          <span className="ledger-name">{name}</span>
          <span className="ledger-why">{why}</span>
        </div>
      ))}
    </section>
  );
}

// ------------------------------------------------------------------ drift list

function DriftList({
  open,
  closed,
  onSelect,
  selected,
  onChanged,
  notices,
  setNotice,
}: {
  open: DriftCard[];
  closed: DriftCard[];
  onSelect: (id: string) => void;
  selected: string | null;
  onChanged: () => void;
  notices: Record<string, Notice>;
  setNotice: (id: string, notice: Notice) => void;
}) {
  if (open.length === 0 && closed.length === 0) {
    return (
      <div className="empty">
        <h2>Nothing to correct</h2>
        <p>
          Statements that match production produce no card at all. Silence here means the things you said about these
          systems were checked and agreed with their sources.
        </p>
      </div>
    );
  }
  return (
    <>
      {open.map((c) => (
        <Card
          key={c.drift.id}
          card={c}
          onSelect={onSelect}
          selected={selected === c.drift.id}
          onChanged={onChanged}
          notice={notices[c.drift.id]}
          setNotice={setNotice}
        />
      ))}
      {closed.length > 0 && (
        <>
          <h2 className="section">Resolved</h2>
          {closed.map((c) => (
            <Card
              key={c.drift.id}
              card={c}
              onSelect={onSelect}
              selected={selected === c.drift.id}
              onChanged={onChanged}
              notice={notices[c.drift.id]}
              setNotice={setNotice}
              muted
            />
          ))}
        </>
      )}
    </>
  );
}

function Card({
  card,
  onSelect,
  selected,
  onChanged,
  notice,
  setNotice,
  muted,
}: {
  card: DriftCard;
  onSelect: (id: string) => void;
  selected: boolean;
  onChanged: () => void;
  notice?: Notice;
  setNotice: (id: string, notice: Notice) => void;
  muted?: boolean;
}) {
  const { drift, claim, label, systemLabel, change } = card;
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setNotice(drift.id, { tone: 'bad', title: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const afterChange = drift.priorOccurrences.filter((o) => o.afterSourceChange).length;

  return (
    <article
      data-drift-key={`${drift.subject}.${drift.property}`}
      className={`card sev-${drift.severity.toLowerCase()} ${muted ? 'muted-card' : ''} ${selected ? 'selected' : ''}`}
    >
      <div className="card-head">
        <div>
          <span className="severity">{drift.severity}</span>
          <span className="system">{systemLabel}</span>
        </div>
        <h3>{label}</h3>
      </div>

      {drift.confirmationRequired && (
        <div className="confirm">
          <p>
            {drift.ownership === 'LIKELY_USER'
              ? 'Read back before acting on it:'
              : 'Heard in your conversation, but more than one person was speaking:'}
          </p>
          <p className="confirm-q">Was this your understanding?</p>
          <button
            className="ghost"
            data-tour="confirm"
            onClick={() => void act('confirm', async () => {
              await api.confirm(drift.id);
            })}
            disabled={busy !== null}
          >
            Yes, that was my understanding
          </button>
          <button
            className="ghost"
            onClick={() => void act('not-mine', async () => {
              await api.resolve(drift.id, 'NOT_MY_BELIEF');
            })}
            disabled={busy !== null}
          >
            No, not my belief
          </button>
        </div>
      )}

      <blockquote>{claim?.originalText ?? '—'}</blockquote>

      <div className="values">
        <div className="value asserted">
          <span className="value-label">You said</span>
          <span className="value-number">{fmt(drift.assertedValue)}</span>
        </div>
        <span className="arrow" aria-hidden="true">
          →
        </span>
        <div className="value actual">
          <span className="value-label">Production</span>
          <span className="value-number">{fmt(drift.actualValue)}</span>
        </div>
      </div>

      {drift.sourceChangeAt ? (
        <p className="why">
          <strong>Why you may remember {fmt(drift.assertedValue)}:</strong> that was the value until{' '}
          {shortDate(drift.sourceChangeAt)}
          {change?.message ? ` — ${change.message}` : ''}
          {drift.sourceChangeCommit ? ` (${drift.sourceChangeCommit.slice(0, 7)})` : ''}.
        </p>
      ) : (
        <p className="why muted">The moment this value changed has not been reconstructed.</p>
      )}

      {drift.priorOccurrences.length > 0 && (
        <p className="recurrence">
          Stated in {drift.priorOccurrences.length + 1} conversations since{' '}
          {shortDate(drift.priorOccurrences[0]!.at)}
          {afterChange > 0 && <>, {afterChange} of them after the change</>}.
        </p>
      )}

      <div className="actions">
        <button data-tour="evidence" onClick={() => onSelect(drift.id)}>
          View evidence
        </button>
        <button
          data-tour="update"
          disabled={busy !== null || drift.confirmationRequired}
          title={drift.confirmationRequired ? 'Confirm the reading first' : undefined}
          onClick={() => void act('update', async () => {
            const r = await api.updateUnderstanding(drift.id);
            if (r.error) throw new Error(r.error);
            setNotice(drift.id, { tone: 'ok', title: 'Written to Bee memory as a confirmed fact', body: r.factText });
          })}
        >
          {busy === 'update' ? 'Writing…' : 'Update my understanding'}
        </button>
        <button
          data-tour="pr"
          disabled={busy !== null || drift.confirmationRequired}
          onClick={() => void act('pr', async () => {
            const pr = await api.openPr(drift.id);
            setNotice(drift.id, { tone: 'ok', title: `Documentation pull request #${pr.number} opened`, body: pr.url });
          })}
        >
          {busy === 'pr' ? 'Opening…' : 'Create docs PR'}
        </button>
        <button
          className="ghost"
          disabled={busy !== null}
          onClick={() => void act('dismiss', async () => {
            await api.resolve(drift.id, 'NOT_MY_BELIEF');
          })}
        >
          This isn&rsquo;t my belief
        </button>
      </div>

      {notice && (
        <div className={`notice ${notice.tone}`} role="status">
          <strong>{notice.title}</strong>
          {notice.body && <span className="mono small">{notice.body}</span>}
        </div>
      )}

      {drift.resolution !== 'OPEN' && <p className="resolution">{drift.resolution.replaceAll('_', ' ').toLowerCase()}</p>}
    </article>
  );
}

// ---------------------------------------------------------------------- detail

function Detail({ card, onClose, onChanged }: { card: DriftCard; onClose: () => void; onChanged: () => void }) {
  const [timeline, setTimeline] = useState<TimelineData | null>(null);
  const [patch, setPatch] = useState<Awaited<ReturnType<typeof api.docsPatch>> | null>(null);

  useEffect(() => {
    setTimeline(null);
    setPatch(null);
    void api.timeline(card.drift.subject, card.drift.property).then(setTimeline).catch(() => undefined);
    void api.docsPatch(card.drift.id).then(setPatch).catch(() => undefined);
  }, [card.drift.id, card.drift.subject, card.drift.property]);

  const grounding = card.claim?.grounding;

  return (
    <div className="drawer" role="dialog" aria-label={`Evidence for ${card.label}`}>
      <div className="drawer-head">
        <h2>{card.label}</h2>
        <button className="ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <section>
        <h3>Evidence</h3>
        <table className="evidence">
          <thead>
            <tr>
              <th>Source</th>
              <th>Value</th>
              <th>Read from</th>
              <th>At</th>
            </tr>
          </thead>
          <tbody>
            {card.evidence.map((e) => (
              <tr key={e.id} className={e.status === 'OK' ? '' : 'bad-row'}>
                <td>
                  {e.source}
                  {e.authoritative && <span className="tag">authoritative</span>}
                  {e.status !== 'OK' && <span className="tag bad">{e.status}</span>}
                </td>
                <td className="mono">{e.status === 'OK' ? fmt(e.value) : (e.error ?? '—')}</td>
                <td className="mono small">{e.sourceLocator}</td>
                <td className="small">{new Date(e.fetchedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          Evidence rows are append-only and hashed. Re-verifying this claim adds a row; it never edits one.
        </p>
      </section>

      <section>
        <h3>Timeline</h3>
        {timeline ? <Timeline data={timeline} driftAt={card.drift.detectedAt} /> : <p className="muted">Loading…</p>}
      </section>

      {grounding && (
        <section>
          <h3>How this was read</h3>
          <p className="muted small">
            The model proposed this claim. These checks, which no model takes part in, are what let it through.
          </p>
          <dl className="grounding">
            <div>
              <dt>Clause type</dt>
              <dd className="mono">{grounding.speechAct}</dd>
            </div>
            <div>
              <dt>Subject heard as</dt>
              <dd className="mono">{grounding.subjectAliasMatched ?? '—'}</dd>
            </div>
            <div>
              <dt>Property heard as</dt>
              <dd className="mono">{grounding.propertyLexemeMatched ?? '—'}</dd>
            </div>
            <div>
              <dt>Value read from</dt>
              <dd className="mono">&ldquo;{grounding.valueLiteralMatched ?? '—'}&rdquo;</dd>
            </div>
            <div>
              <dt>Attribution</dt>
              <dd className="mono">{card.drift.ownership}</dd>
            </div>
            <div>
              <dt>Confidence</dt>
              <dd className="mono">{card.claim?.extractionConfidence.toFixed(2)}</dd>
            </div>
          </dl>
        </section>
      )}

      <section>
        <h3>Why this is {card.drift.severity}</h3>
        <ul className="severity-list">
          {card.severityBreakdown.factors.map((f) => (
            <li key={f.name}>
              <span className="mono">+{f.points}</span> {f.because}
            </li>
          ))}
        </ul>
        <p className="muted small">
          Impact is set by a human in the source registry. The rest is counted, not estimated. There is no probability
          here because there is nothing honest to compute one from.
        </p>
      </section>

      {card.drift.priorOccurrences.length > 0 && (
        <section>
          <h3>Earlier conversations</h3>
          <p className="muted small">
            Found with Bee neural search, then re-checked with the same grounding rules used at capture.
          </p>
          <ul className="occurrences">
            {card.drift.priorOccurrences.map((o) => (
              <li key={`${o.conversationId}-${o.at}`} className={o.afterSourceChange ? 'stale' : ''}>
                <span className="occ-date">{shortDate(o.at)}</span>
                <span className="occ-text">{o.excerpt}</span>
                <span className="occ-flag">{o.afterSourceChange ? 'after the change' : 'correct at the time'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3>Proposed documentation fix</h3>
        {!patch && <p className="muted">Preparing…</p>}
        {patch?.reason && <p className="muted">{patch.reason}</p>}
        {patch?.patches?.map((p) => (
          <div key={p.path}>
            <p className="mono small">{p.path}</p>
            {p.error && <p className="muted small">{p.error}</p>}
            {!p.changed && !p.error && <p className="muted small">No line in this file states the stale value.</p>}
            {p.hunks.map((h) => (
              <pre key={h.line} className="diff">
                <span className="del">- {h.before}</span>
                {'\n'}
                <span className="add">+ {h.after}</span>
              </pre>
            ))}
          </div>
        ))}
        <p className="muted small">
          Prepared locally. Nothing is pushed until you choose <em>Create docs PR</em>, and that action is off unless the
          server was started with <span className="mono">MMD_ALLOW_PR=1</span>.
        </p>
      </section>

      <div className="drawer-foot">
        <button className="ghost" onClick={() => void api.resolve(card.drift.id, 'FALSE_POSITIVE').then(onChanged)}>
          Report as a false positive
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------- heard

function HeardList({ claims }: { claims: ClaimRow[] }) {
  const supported = claims.filter((c) => c.claim.status === 'SUPPORTED');
  return (
    <>
      <div className="explainer">
        <h2>Everything that was checked</h2>
        <p>
          {supported.length} of {claims.length} verified statements agreed with their source and produced no card. A tool
          that reads your conversations earns its place by staying quiet, so what it stayed quiet about is on the record.
        </p>
      </div>
      <CoveragePanel />
      <table className="claims">
        <thead>
          <tr>
            <th>Said</th>
            <th>Reading</th>
            <th>Verdict</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {claims.map(({ claim, label }) => (
            <tr key={claim.id}>
              <td className="quote">{claim.originalText}</td>
              <td className="mono small">
                {label} = {fmt(claim.assertedValue)}
              </td>
              <td>
                <span className={`verdict v-${claim.status.toLowerCase()}`}>{claim.status}</span>
              </td>
              <td className="small">{daysAgo(claim.capturedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/**
 * A dry run of extraction over everything Bee has recorded.
 *
 * Nothing here is verified and nothing is stored: it answers the question a
 * person should ask before leaving this running, which is how much of what they
 * say the product would ever have an opinion about. The honest answer is most of
 * the bar, and the bar is the point.
 */
function CoveragePanel() {
  const [cov, setCov] = useState<Coverage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .coverage()
      .then(setCov)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return null;
  if (!cov) return <p className="muted small">Surveying your recorded history…</p>;
  if (cov.utterances === 0) return null;

  const pct = (cov.checkable / cov.utterances) * 100;
  return (
    <section className="coverage">
      <div className="coverage-head">
        <h3>Across everything Bee has recorded</h3>
        <p className="muted small">
          {cov.conversations} conversations, {cov.utterances} utterances, {cov.speakers} distinct speakers
          {cov.earliest ? `, ${shortDate(cov.earliest)} to ${shortDate(cov.latest ?? cov.earliest)}` : ''}. Re-run of the
          same extraction and grounding gates, reading no source and writing nothing.
        </p>
      </div>
      <div className="coverage-bar" role="img" aria-label={`${cov.checkable} of ${cov.utterances} utterances carry a checkable claim`}>
        <span className="coverage-checkable" style={{ width: `${Math.max(pct, 1.5)}%` }} />
      </div>
      <div className="coverage-legend">
        <span>
          <strong className="mono">{cov.checkable}</strong> carried a checkable claim ({pct.toFixed(1)}%)
        </span>
        <span className="muted">
          <strong className="mono">{cov.ignored}</strong> were about something else, and produced nothing
        </span>
      </div>
      {cov.perProperty.length > 0 && (
        <ul className="coverage-props">
          {cov.perProperty.map((p) => (
            <li key={p.key}>
              <span className="mono small">{p.key}</span>
              <span className="coverage-count mono">{p.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --------------------------------------------------------------------- sources

function Sources({ status }: { status: Status | null }) {
  const list = status?.registrySystems ?? [];
  const metrics = status?.metrics ?? {};
  const keys = Object.keys(metrics).sort();

  return (
    <>
      <div className="explainer">
        <h2>What can be verified</h2>
        <p>
          Nothing outside this registry is checked, and nothing in it is decided by a language model. Each row names the
          system that gets the final word on that property, and the source used only to explain when it changed.
        </p>
      </div>

      {list.map((system) => (
        <section key={system.key} className="registry-system">
          <h3>
            {system.label} <span className="mono small">{system.key}</span>
          </h3>
          <table className="registry">
            <thead>
              <tr>
                <th>Property</th>
                <th>Type</th>
                <th>Impact</th>
                <th>Decides</th>
                <th>Explains</th>
              </tr>
            </thead>
            <tbody>
              {system.properties.map((p) => (
                <tr key={p.key}>
                  <td>
                    {p.label}
                    <div className="mono small muted">{p.key}</div>
                  </td>
                  <td className="mono small">{p.type}</td>
                  <td>
                    <span className={`impact i-${p.impact.toLowerCase()}`}>{p.impact}</span>
                  </td>
                  <td className="mono small">{p.source}</td>
                  <td className="mono small">{p.historicalSource ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      {keys.length > 0 && (
        <section className="registry-system">
          <h3>Counters</h3>
          <div className="metrics">
            {keys.map((k) => (
              <div key={k}>
                <span className="metric-value mono">{metrics[k]}</span>
                <span className="metric-name">{k}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

// ------------------------------------------------------------------- feed glue

function toFeedItem(event: Record<string, unknown>, id: number): FeedItem | null {
  const at = String(event.at ?? new Date().toISOString());
  const replay = event.replay === true;
  switch (event.type) {
    case 'utterance':
      return { id, at, replay, kind: String(event.origin), primary: String(event.text), tone: 'neutral' };
    case 'duplicate':
      return { id, at, replay, kind: 'deduped', primary: 'already processed by the other path', tone: 'quiet' };
    case 'rejected':
      return { id, at, replay, kind: 'not a claim', primary: String(event.reason), tone: 'quiet' };
    case 'candidate': {
      const claim = event.claim as { subject: string; property: string; assertedValue: unknown };
      return {
        id,
        at,
        replay,
        kind: 'candidate',
        primary: `${claim.subject}.${claim.property} = ${fmt(claim.assertedValue)}`,
        secondary: `${(event.confidence as number).toFixed(2)}${event.corroborated ? ' · corroborated' : ''} · ${String(event.disposition)}`,
        tone: 'candidate',
      };
    }
    case 'verifying':
      return { id, at, replay, kind: 'reading', primary: String(event.source), secondary: String(event.locator), tone: 'system' };
    case 'verdict':
      return {
        id,
        at,
        replay,
        kind: String(event.verdict).toLowerCase(),
        primary: String(event.reason),
        tone: event.verdict === 'DRIFTED' ? 'drift' : event.verdict === 'SUPPORTED' ? 'supported' : 'quiet',
      };
    case 'explained': {
      const change = event.change as { at?: string; commitSha?: string } | undefined;
      return {
        id,
        at,
        replay,
        kind: 'explained',
        primary: change?.at ? `changed ${shortDate(change.at)}${change.commitSha ? ` (${change.commitSha.slice(0, 7)})` : ''}` : 'no change found',
        secondary: `${String(event.occurrences)} earlier conversations`,
        tone: 'system',
      };
    }
    case 'reconcile': {
      const r = event.report as { utterancesNew?: number; conversationsChanged?: number; error?: string };
      return {
        id,
        at,
        replay,
        kind: 'reconciled',
        primary: r?.error ?? `${r?.utterancesNew ?? 0} new utterances recovered from ${r?.conversationsChanged ?? 0} conversations`,
        tone: 'system',
      };
    }
    default:
      return null;
  }
}
