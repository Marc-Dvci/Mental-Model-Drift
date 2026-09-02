/**
 * The Assumption Firewall, made visible.
 *
 * The rest of the dashboard is for the person, after the fact. This panel is
 * about the other consumer: a coding agent, mid-task, holding a premise a human
 * handed it. It cannot tell a fact from a memory, so it writes a confident patch
 * on something that stopped being true three weeks ago -- and then defends it,
 * because it reasoned correctly from what it was given.
 *
 * Everything here is real. The statement goes to `POST /api/check`, which runs
 * the same registry, the same grounding gate and the same deterministic
 * comparator as the wearable feed, and returns the same verdict the drift card
 * would carry. Nothing is scripted and nothing is stored: a question an agent
 * asked is not something the wearer said, so it never becomes a claim.
 */
import { useState } from 'react';
import { api, fmt, shortDate, type FirewallResult } from './api.ts';

/** The three shapes of premise, so the panel demonstrates the whole contract. */
const EXAMPLES = [
  'The checkout worker retries three times, so a slow consumer is not the problem.',
  'The events table stores the source IP, so we can trace it back.',
  'I think we should probably refactor the queue at some point.',
];

export function AgentPanel() {
  const [statement, setStatement] = useState(EXAMPLES[0]!);
  const [result, setResult] = useState<FirewallResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(text: string): Promise<void> {
    setStatement(text);
    setBusy(true);
    setError(null);
    try {
      setResult(await api.check(text));
    } catch (err) {
      setError((err as Error).message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="agent" data-tour="agent">
      <h2>The Assumption Firewall</h2>
      <p className="muted">
        An agent is handed human context constantly and has no way to tell a fact from a memory.
        Before it acts on a premise, it can ask here — over MCP, over <code>mmd</code> on the command
        line, or over this endpoint. Same registry, same gate, same answer as the card above.
      </p>

      <form
        className="agent-input"
        onSubmit={(e) => {
          e.preventDefault();
          void run(statement);
        }}
      >
        <label htmlFor="agent-statement">check_assumption</label>
        <textarea
          id="agent-statement"
          rows={2}
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
          spellCheck={false}
        />
        <div className="agent-actions">
          <button type="submit" disabled={busy || !statement.trim()} data-tour="agent-run">
            {busy ? 'Checking…' : 'Check'}
          </button>
          {EXAMPLES.map((example, i) => (
            <button
              key={example}
              type="button"
              className="ghost"
              data-tour={`agent-example-${i}`}
              onClick={() => void run(example)}
            >
              {['a stale premise', 'a true one', 'an opinion'][i]}
            </button>
          ))}
        </div>
      </form>

      {error && <p className="notice bad">{error}</p>}
      {result && <Answer result={result} />}
    </section>
  );
}

function Answer({ result }: { result: FirewallResult }) {
  if (result.unsupported) {
    return (
      <div className="agent-answer" data-verdict="UNSUPPORTED">
        <div className="agent-verdict">UNSUPPORTED</div>
        <p>
          Nothing here can be settled from a source, so nothing is claimed about it. {result.unsupported.reason}.
        </p>
        <p className="muted small">
          An opinion is not a wrong belief. The agent carries on and never mentions the check.
        </p>
      </div>
    );
  }

  return (
    <>
      {result.findings.map((f, i) => (
        <div className="agent-answer" data-verdict={f.verdict} key={`${f.subject}.${f.property}.${i}`}>
          <div className="agent-verdict">
            {f.verdict}
            {f.severity && <span className="sev">{f.severity}</span>}
            <span className="agent-label">{f.label}</span>
          </div>

          {f.verdict === 'DRIFTED' && (
            <>
              <p className="agent-values">
                stated <b>{fmt(f.assertedValue)}</b>, actually <b>{fmt(f.actualValue)}</b>
              </p>
              {f.changedAt && (
                <p>
                  changed {shortDate(f.changedAt)}
                  {f.changeMessage ? ` — ${f.changeMessage}` : ''}
                </p>
              )}
              {!!f.priorOccurrences?.length && (
                <p>
                  restated in {f.priorOccurrences.length} earlier conversation
                  {f.priorOccurrences.length === 1 ? '' : 's'}
                  {(() => {
                    const after = f.priorOccurrences!.filter((o) => o.afterSourceChange).length;
                    return after ? `, ${after} of them after the change` : '';
                  })()}
                </p>
              )}
              {/* The instruction is the product. Knowing the value is not
                  enough: an agent that silently substitutes it leaves the
                  person still believing the old one. */}
              <p className="agent-instruction">
                Act on the actual value, and tell the human what changed and when rather than silently
                correcting them.
              </p>
            </>
          )}

          {f.verdict === 'SUPPORTED' && (
            <p className="agent-values">
              <b>{fmt(f.actualValue)}</b>, as stated. Safe to act on, and nothing is said about it.
            </p>
          )}

          {f.verdict !== 'DRIFTED' && f.verdict !== 'SUPPORTED' && (
            <>
              <p>{f.reason}</p>
              <p className="agent-instruction">
                Neither confirmed nor refuted. A source that could not be read must never look like a
                person being wrong.
              </p>
            </>
          )}

          {f.evidence.map((e) => (
            <div className="agent-evidence" key={e.locator}>
              <span>{e.source}</span>
              <span className={e.status === 'OK' ? 'ok' : 'bad'}>{e.status}</span>
              <code>{e.locator}</code>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
