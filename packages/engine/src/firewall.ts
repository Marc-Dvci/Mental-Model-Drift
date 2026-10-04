/**
 * The Assumption Firewall.
 *
 * One question, asked of one sentence: *is this still true, and since when not?*
 *
 * This lives in the engine rather than in any one of the three surfaces that
 * expose it, because the property that makes having three surfaces worth
 * anything is that they cannot disagree. The MCP tool, the `mmd` command line
 * and the dashboard's agent panel all call `checkAssumption`, so a sentence gets
 * the same verdict, from the same registry, through the same grounding gate and
 * the same deterministic comparator, whichever door it arrives at -- and the
 * same answer the wearable feed would have produced for it.
 *
 * Nothing here formats for a transport. `renderFindings` produces the text a
 * reader sees; the surfaces wrap it in whatever envelope they owe their client.
 */
import { randomUUID } from 'node:crypto';
import { adjudicateAll, scoreSeverity, type Claim, type Evidence, type HistoricalChange } from '#spec';
import type { BuiltEngine } from './config.ts';
import type { RecurrenceResult } from './recurrence.ts';

export interface FirewallFinding {
  verdict: string;
  reason: string;
  subject: string;
  property: string;
  label: string;
  scope?: Record<string, string>;
  object?: string;
  assertedValue: unknown;
  actualValue: unknown;
  evidence: { source: string; locator: string; status: string; value: unknown; fetchedAt: string }[];
  changedAt?: string;
  changedBy?: string;
  changeMessage?: string;
  priorOccurrences?: { at: string; excerpt: string; afterSourceChange: boolean }[];
  beeQuery?: string;
  severity?: string;
  severityFactors?: { name: string; points: number; because: string }[];
  groundedOn: unknown;
  confidence: number;
}

export interface FirewallResult {
  statement: string;
  findings: FirewallFinding[];
  /** Set when nothing checkable was said, with the gate's reason for saying so. */
  unsupported?: { reason: string };
}

export async function checkAssumption(
  built: BuiltEngine,
  statement: string,
  context: string[] = [],
  includeHistory = true,
): Promise<FirewallResult> {
  const extraction = await built.engine.extractOnly({ text: statement, window: context });

  if (extraction.accepted.length === 0) {
    return {
      statement,
      findings: [],
      unsupported: { reason: extraction.rejected[0]?.reason ?? 'no registry property is named in the statement' },
    };
  }

  const findings: FirewallFinding[] = [];
  for (const accepted of extraction.accepted) {
    const resolved = built.registry.resolve(accepted.proposal.subject, accepted.proposal.property)!;
    const claim: Claim = {
      id: randomUUID(),
      userId: 'firewall',
      sourceConversationId: 'firewall',
      originalText: statement,
      claimType: accepted.proposal.claimType,
      subject: accepted.proposal.subject,
      property: accepted.proposal.property,
      ...(accepted.proposal.object ? { object: accepted.proposal.object } : {}),
      ...(accepted.proposal.scope ? { scope: accepted.proposal.scope } : {}),
      assertedValue: accepted.proposal.assertedValue,
      valueType: resolved.property.type,
      ownership: 'UNKNOWN',
      extractionConfidence: accepted.confidence,
      grounding: accepted.grounding,
      capturedAt: new Date().toISOString(),
      status: 'CANDIDATE',
    };

    const source = resolved.property.authoritative_source;
    const verifier = built.verifiers.find((v) => v.canVerify(claim, source));
    const evidence: Evidence[] = verifier ? [await verifier.verify(claim, source)] : [];
    const adjudication = adjudicateAll(claim, evidence);

    let change: HistoricalChange | undefined;
    let recall: RecurrenceResult | undefined;
    if (includeHistory && adjudication.verdict === 'DRIFTED') {
      const historySource = resolved.property.historical_source ?? source;
      const historyVerifier = built.verifiers.find((v) => v.canVerify(claim, historySource));
      const changes = (await historyVerifier?.history?.(claim, historySource).catch(() => [])) ?? [];
      change = changes.find((c) => String(c.from) === String(claim.assertedValue));
      recall = await built.engine.recallOccurrences({
        subject: claim.subject,
        property: claim.property,
        assertedValue: claim.assertedValue,
        ...(claim.object ? { object: claim.object } : {}),
        ...(claim.scope ? { scope: claim.scope } : {}),
        ...(change ? { sourceChangeAt: change.at } : {}),
      });
    }

    const now = new Date().toISOString();
    const severity =
      adjudication.verdict === 'DRIFTED'
        ? scoreSeverity({
            impact: resolved.property.impact,
            priorOccurrences: recall?.occurrences ?? [],
            detectedAt: now,
            lastSpokenAt: now,
            ...(change ? { sourceChangeAt: change.at } : {}),
          })
        : undefined;

    findings.push({
      verdict: adjudication.verdict,
      reason: adjudication.reason,
      subject: claim.subject,
      property: claim.property,
      label: resolved.property.label ?? claim.property,
      ...(claim.scope ? { scope: claim.scope } : {}),
      ...(claim.object ? { object: claim.object } : {}),
      assertedValue: claim.assertedValue,
      actualValue: adjudication.normalisedActual,
      evidence: evidence.map((e) => ({
        source: e.source,
        locator: e.sourceLocator,
        status: e.status,
        value: e.value,
        fetchedAt: e.fetchedAt,
      })),
      ...(change ? { changedAt: change.at, changedBy: change.commitSha ?? change.locator, changeMessage: change.message } : {}),
      ...(recall ? { priorOccurrences: recall.occurrences, beeQuery: recall.query } : {}),
      ...(severity ? { severity: severity.severity, severityFactors: severity.factors } : {}),
      groundedOn: accepted.grounding,
      confidence: accepted.confidence,
    });
  }

  return { statement, findings };
}

/**
 * The text a reader sees. Written as an instruction rather than a report: the
 * useful behaviour is not "know the value", it is "use the real one and tell
 * the human what moved".
 */
export function renderFindings(result: FirewallResult, opts: { unsupportedHint?: string } = {}): string {
  if (result.unsupported) {
    // Each surface names its own way of listing the registry -- an MCP tool, a
    // subcommand -- because a reader who just hit UNSUPPORTED needs the next
    // step in the vocabulary of the door they came through.
    const hint = opts.unsupportedHint ?? 'Ask for the list of verifiable properties to see what is in the registry.';
    return `UNSUPPORTED -- this statement is outside what can be verified.\n  ${result.unsupported.reason}\n${hint}`;
  }
  return result.findings.map(renderFinding).join('\n\n');
}

export function renderFinding(f: FirewallFinding): string {
  const scope = f.scope ? ` (${Object.entries(f.scope).map(([k, v]) => `${k}=${v}`).join(', ')})` : '';
  const lines = [`${f.verdict} -- ${f.label}${scope}`];
  if (f.verdict === 'DRIFTED') {
    lines.push(`  stated ${fmt(f.assertedValue)}, actually ${fmt(f.actualValue)}`);
    if (f.changedAt) lines.push(`  changed ${f.changedAt.slice(0, 10)}${f.changeMessage ? ` -- ${f.changeMessage}` : ''}`);
    if (f.severity) lines.push(`  severity ${f.severity}`);
    const after = (f.priorOccurrences ?? []).filter((o) => o.afterSourceChange).length;
    if (f.priorOccurrences?.length) {
      lines.push(`  restated in ${f.priorOccurrences.length} earlier conversation(s)${after ? `, ${after} of them after the change` : ''}`);
    }
    lines.push('  Act on the actual value, and tell the human what changed and when rather than silently correcting them.');
  } else if (f.verdict === 'SUPPORTED') {
    lines.push(`  ${fmt(f.actualValue)}, as stated. Safe to act on.`);
  } else {
    lines.push(`  ${f.reason}`);
    lines.push('  Treat this as neither confirmed nor refuted; do not act as though it were checked.');
  }
  for (const e of f.evidence) lines.push(`  evidence: ${e.source} ${e.status} ${e.locator}`);
  return lines.join('\n');
}

/**
 * The exit code `mmd` returns and the status an HTTP caller gets.
 *
 * Three outcomes, not two. A source that could not be read must never be
 * indistinguishable from a person being wrong: an agent that collapses them
 * will announce a stale belief every time a connector times out, which is the
 * fastest way to make a product like this untrustworthy.
 */
export function verdictCode(result: FirewallResult): 0 | 1 | 2 {
  if (result.findings.some((f) => f.verdict === 'DRIFTED')) return 1;
  if (result.findings.some((f) => f.verdict === 'INCONCLUSIVE')) return 2;
  return 0;
}

function fmt(v: unknown): string {
  return typeof v === 'boolean' ? (v ? 'enabled' : 'disabled') : String(v);
}
