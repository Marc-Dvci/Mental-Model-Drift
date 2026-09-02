/**
 * The pipeline: one utterance in, at most one drift record out.
 *
 *   dedupe -> redact -> extract -> gate -> verify -> adjudicate
 *                                                       |
 *                                              DRIFTED  |  SUPPORTED / INCONCLUSIVE
 *                                                       |            |
 *                            reconstruct when it changed             stored, never shown
 *                            recall prior occurrences (Bee)
 *                            score severity
 *
 * Two rules run through all of it:
 *
 *   Silence is a feature. A supported claim is recorded and produces no card,
 *   no badge and no notification. The product only ever interrupts on evidence
 *   of disagreement.
 *
 *   Nothing is decided in real time. Capture and verification happen live so
 *   the answer is ready, but the wearer is never corrected mid-conversation.
 */
import { randomUUID } from 'node:crypto';
import type { BeeClient } from '#bee';
import { contentKey } from '#bee';
import {
  adjudicateAll,
  normalise,
  scoreSeverity,
  type Claim,
  type DriftEvent,
  type Evidence,
  type HistoricalChange,
  type Ownership,
  type Verdict,
  type Verifier,
} from '#spec';
import type { Extractor } from './extract/index.ts';
import type { Registry } from './registry.ts';
import type { RecurrenceFinder, RecurrenceQuery, RecurrenceResult } from './recurrence.ts';
import { redact } from './redact.ts';
import type { Store } from './store/types.ts';

export interface UtteranceInput {
  text: string;
  conversationId: string;
  conversationUuid?: string;
  utteranceIndex?: number;
  speaker?: string;
  capturedAt?: string;
  /** Preceding utterances, oldest first. */
  window?: string[];
  /** How many distinct speakers the conversation has, if known. */
  speakerCount?: number;
  origin: 'realtime' | 'reconciled' | 'replay';
}

export type PipelineEvent =
  | { type: 'utterance'; at: string; text: string; conversationId: string; origin: string }
  | { type: 'duplicate'; at: string; conversationId: string; because: string }
  | { type: 'candidate'; at: string; claim: Claim; confidence: number; corroborated: boolean; disposition: string }
  | { type: 'rejected'; at: string; text: string; reason: string; stage: string }
  | { type: 'verifying'; at: string; claimId: string; source: string; locator: string }
  | { type: 'verdict'; at: string; claimId: string; verdict: Verdict; reason: string; evidence: Evidence[] }
  | { type: 'drift'; at: string; drift: DriftEvent }
  | { type: 'explained'; at: string; driftId: string; change?: HistoricalChange; occurrences: number };

export interface EngineOptions {
  userId: string;
  registry: Registry;
  extractor: Extractor;
  verifiers: Verifier[];
  store: Store;
  bee: BeeClient;
  recurrence?: RecurrenceFinder;
  onEvent?: (event: PipelineEvent) => void;
}

export interface IngestOutcome {
  duplicate: boolean;
  claims: { claim: Claim; verdict?: Verdict; driftId?: string }[];
  rejected: { reason: string; stage: string }[];
}

export class DriftEngine {
  constructor(private readonly o: EngineOptions) {}

  private emit(e: PipelineEvent): void {
    this.o.onEvent?.(e);
  }

  get registry(): Registry {
    return this.o.registry;
  }
  get store(): Store {
    return this.o.store;
  }
  get bee(): BeeClient {
    return this.o.bee;
  }

  /**
   * Extraction and gating, with nothing written and no source read.
   *
   * The MCP server needs exactly this: an agent asking "is this sentence even
   * a checkable claim, and about what" must not create a claim record, and must
   * not have its question counted as something the wearer said.
   */
  async extractOnly(input: { text: string; window?: string[] }): Promise<ReturnType<Extractor['extract']>> {
    return this.o.extractor.extract({
      text: redact(input.text).text,
      ...(input.window?.length ? { window: input.window } : {}),
      conversationId: 'ad-hoc',
      capturedAt: new Date().toISOString(),
    });
  }

  /**
   * Longitudinal recall for one property, through Bee.
   *
   * Exposed because "how long have they believed this" is useful on its own,
   * not only as a step inside drift detection.
   */
  async recallOccurrences(query: RecurrenceQuery): Promise<RecurrenceResult> {
    if (!this.o.recurrence) {
      return { occurrences: [], query: '', conversationsSearched: 0, searchMode: 'unavailable', note: 'no recurrence finder configured' };
    }
    return this.o.recurrence.find(query);
  }

  async ingestUtterance(input: UtteranceInput): Promise<IngestOutcome> {
    const at = input.capturedAt ?? new Date().toISOString();
    const ref = input.conversationUuid ?? input.conversationId;

    // The live stream and the reconciliation pass will both deliver the same
    // sentence. Keying on content plus conversation is what makes that safe.
    const key = contentKey(ref, input.text);
    if (await this.o.store.markProcessed(key, { origin: input.origin, at })) {
      this.emit({ type: 'duplicate', at, conversationId: input.conversationId, because: `already processed via a previous path` });
      await this.o.store.incrementMetric('BeeEventsDeduplicated');
      return { duplicate: true, claims: [], rejected: [] };
    }
    await this.o.store.incrementMetric(input.origin === 'reconciled' ? 'BeeEventsReconciled' : 'BeeEventsReceived');

    const { text } = redact(input.text);
    this.emit({ type: 'utterance', at, text, conversationId: input.conversationId, origin: input.origin });

    const result = await this.o.extractor.extract({
      text,
      window: input.window,
      conversationId: input.conversationId,
      utteranceIndex: input.utteranceIndex,
      speaker: input.speaker,
      capturedAt: at,
    });

    for (const r of result.rejected) {
      this.emit({ type: 'rejected', at, text, reason: r.reason, stage: r.stage });
    }

    const outcome: IngestOutcome = {
      duplicate: false,
      claims: [],
      rejected: result.rejected.map((r) => ({ reason: r.reason, stage: r.stage })),
    };

    for (const accepted of result.accepted) {
      const claim: Claim = {
        id: randomUUID(),
        userId: this.o.userId,
        sourceConversationId: input.conversationId,
        ...(input.utteranceIndex !== undefined ? { sourceUtteranceIndex: input.utteranceIndex } : {}),
        originalText: text,
        claimType: accepted.proposal.claimType,
        subject: accepted.proposal.subject,
        property: accepted.proposal.property,
        ...(accepted.proposal.scope ? { scope: accepted.proposal.scope } : {}),
        ...(accepted.proposal.object ? { object: accepted.proposal.object } : {}),
        assertedValue: accepted.proposal.assertedValue,
        valueType: this.o.registry.resolve(accepted.proposal.subject, accepted.proposal.property)!.property.type,
        ownership: inferOwnership(input.speakerCount),
        extractionConfidence: accepted.confidence,
        grounding: accepted.grounding,
        capturedAt: at,
        status: 'CANDIDATE',
      };
      await this.o.store.putClaim(claim);
      await this.o.store.incrementMetric('ClaimsDetected');
      this.emit({
        type: 'candidate',
        at,
        claim,
        confidence: accepted.confidence,
        corroborated: accepted.corroborated,
        disposition: accepted.disposition,
      });

      const verified = await this.verifyClaim(claim, accepted.disposition === 'QUEUED');
      outcome.claims.push({ claim: verified.claim, verdict: verified.verdict, ...(verified.driftId ? { driftId: verified.driftId } : {}) });
    }
    return outcome;
  }

  /**
   * Read the authoritative source and adjudicate.
   *
   * A non-authoritative source is still read when one is configured, because it
   * is what makes the explanation possible -- but it is passed to the comparator
   * flagged, and it can never on its own produce a DRIFTED verdict.
   */
  async verifyClaim(claim: Claim, needsConfirmation = false): Promise<{ claim: Claim; verdict: Verdict; evidence: Evidence[]; driftId?: string }> {
    const resolved = this.o.registry.resolve(claim.subject, claim.property);
    if (!resolved) {
      const updated = { ...claim, status: 'INCONCLUSIVE' as const };
      await this.o.store.putClaim(updated);
      return { claim: updated, verdict: 'UNSUPPORTED_TYPE', evidence: [] };
    }

    await this.o.store.putClaim({ ...claim, status: 'VERIFYING' });

    const sources = [resolved.property.authoritative_source];
    const evidence: Evidence[] = [];
    for (const source of sources) {
      const verifier = this.o.verifiers.find((v) => v.canVerify(claim, source));
      if (!verifier) {
        evidence.push({
          id: randomUUID(),
          claimId: claim.id,
          source: source.adapter.toUpperCase(),
          sourceLocator: JSON.stringify(source.locator),
          status: 'UNAVAILABLE',
          value: undefined,
          authoritative: source.authoritative,
          fetchedAt: new Date().toISOString(),
          evidenceHash: '',
          error: `no verifier registered for adapter "${source.adapter}"`,
        });
        continue;
      }
      this.emit({ type: 'verifying', at: new Date().toISOString(), claimId: claim.id, source: verifier.name, locator: describeLocator(source.locator) });
      const e = await verifier.verify(claim, source);
      await this.o.store.putEvidence(e);
      evidence.push(e);
      if (e.status !== 'OK') await this.o.store.incrementMetric(`${e.source}Errors`);
    }

    const adjudication = adjudicateAll(claim, evidence);
    const status = adjudication.verdict === 'UNSUPPORTED_TYPE' ? 'INCONCLUSIVE' : adjudication.verdict;
    const updated: Claim = { ...claim, status };
    await this.o.store.putClaim(updated);
    await this.o.store.incrementMetric(
      adjudication.verdict === 'DRIFTED' ? 'DriftsDetected'
        : adjudication.verdict === 'SUPPORTED' ? 'ClaimsSupported'
          : 'ClaimsInconclusive',
    );
    this.emit({ type: 'verdict', at: new Date().toISOString(), claimId: claim.id, verdict: adjudication.verdict, reason: adjudication.reason, evidence });

    if (adjudication.verdict !== 'DRIFTED') {
      // Supported and inconclusive claims stop here, on purpose.
      return { claim: updated, verdict: adjudication.verdict, evidence };
    }

    const drift = await this.buildDrift(updated, adjudication.normalisedActual, resolved, needsConfirmation);

    // The same stale belief restated is not a second problem. Fold it into the
    // open card so recurrence climbs and severity is re-scored, rather than
    // stacking duplicate cards that all say the same thing.
    const existing = (await this.o.store.listDrifts({ limit: 100 })).find(
      (d) =>
        d.resolution === 'OPEN' &&
        d.subject === drift.subject &&
        d.property === drift.property &&
        String(d.assertedValue) === String(drift.assertedValue),
    );
    if (existing) {
      const merged: DriftEvent = {
        ...existing,
        actualValue: drift.actualValue,
        detectedAt: drift.detectedAt,
        priorOccurrences: mergeOccurrences(existing.priorOccurrences, drift.priorOccurrences, existing.claimId !== drift.claimId ? {
          conversationId: claim.sourceConversationId,
          at: claim.capturedAt,
          excerpt: claim.originalText,
          afterSourceChange: Boolean(drift.sourceChangeAt && claim.capturedAt > drift.sourceChangeAt),
        } : undefined),
        ...(drift.sourceChangeAt ? { sourceChangeAt: drift.sourceChangeAt } : {}),
        ...(drift.sourceChangeCommit ? { sourceChangeCommit: drift.sourceChangeCommit } : {}),
      };
      merged.severity = scoreSeverity({
        impact: resolved.property.impact,
        priorOccurrences: merged.priorOccurrences,
        detectedAt: merged.detectedAt,
        lastSpokenAt: claim.capturedAt,
        ...(merged.sourceChangeAt ? { sourceChangeAt: merged.sourceChangeAt } : {}),
      }).severity;
      await this.o.store.putDrift(merged);
      this.emit({ type: 'drift', at: merged.detectedAt, drift: merged });
      return { claim: updated, verdict: 'DRIFTED', evidence, driftId: merged.id };
    }

    await this.o.store.putDrift(drift);
    this.emit({ type: 'drift', at: drift.detectedAt, drift });
    return { claim: updated, verdict: 'DRIFTED', evidence, driftId: drift.id };
  }

  /**
   * Turn a disagreement into an explanation.
   *
   * Order matters here: the change is reconstructed *before* prior occurrences
   * are counted, because "spoken after the system changed" is the fact that
   * distinguishes an entrenched wrong model from an old conversation that was
   * correct at the time.
   */
  private async buildDrift(
    claim: Claim,
    actualValue: unknown,
    resolved: NonNullable<ReturnType<Registry['resolve']>>,
    needsConfirmation: boolean,
  ): Promise<DriftEvent> {
    const detectedAt = new Date().toISOString();

    let changes: HistoricalChange[] = [];
    const historySource = resolved.property.historical_source ?? resolved.property.authoritative_source;
    const verifier = this.o.verifiers.find((v) => v.canVerify(claim, historySource));
    if (verifier?.history) {
      try {
        changes = await verifier.history(claim, historySource);
        await this.o.store.putHistory(claim.subject, claim.property, changes);
      } catch {
        changes = await this.o.store.getHistory(claim.subject, claim.property);
      }
    }

    // The interesting commit is the one that moved the value away from what the
    // wearer said, not simply the newest edit to the file.
    //
    // Matching goes through the same normalisation the comparator uses, so that
    // a spoken "4.12" recognises the release Sentry records as "4.12.0". A raw
    // string compare here silently loses every version drift.
    const asserted = normalise(claim.assertedValue, claim.valueType);
    const departure = changes.find((c) => {
      const from = normalise(c.from, claim.valueType);
      return asserted.ok && from.ok
        ? String(from.value) === String(asserted.value)
        : loose(c.from) === loose(claim.assertedValue);
    });
    const sourceChangeAt = departure?.at;

    let occurrences: DriftEvent['priorOccurrences'] = [];
    if (this.o.recurrence) {
      const found = await this.o.recurrence.find({
        subject: claim.subject,
        property: claim.property,
        assertedValue: claim.assertedValue,
        ...(claim.object ? { object: claim.object } : {}),
        ...(claim.scope ? { scope: claim.scope } : {}),
        excludeConversationId: claim.sourceConversationId,
        ...(sourceChangeAt ? { sourceChangeAt } : {}),
      });
      occurrences = found.occurrences;
    }

    const severity = scoreSeverity({
      impact: resolved.property.impact,
      priorOccurrences: occurrences,
      detectedAt,
      lastSpokenAt: claim.capturedAt,
      ...(sourceChangeAt ? { sourceChangeAt } : {}),
    });

    const drift: DriftEvent = {
      id: randomUUID(),
      claimId: claim.id,
      subject: claim.subject,
      property: claim.property,
      assertedValue: claim.assertedValue,
      actualValue,
      verdict: 'DRIFTED',
      detectedAt,
      ...(sourceChangeAt ? { sourceChangeAt } : {}),
      ...(departure?.commitSha ? { sourceChangeCommit: departure.commitSha } : {}),
      priorOccurrences: occurrences,
      severity: severity.severity,
      // A card that cannot be attributed to the wearer, or that rests on a
      // reading extraction was unsure of, asks before it acts.
      confirmationRequired: needsConfirmation || claim.ownership !== 'LIKELY_USER',
      ownership: claim.ownership,
      resolution: 'OPEN',
    };
    this.emit({ type: 'explained', at: detectedAt, driftId: drift.id, ...(departure ? { change: departure } : {}), occurrences: occurrences.length });
    return drift;
  }

  async resolveDrift(id: string, resolution: DriftEvent['resolution']): Promise<DriftEvent | undefined> {
    const drift = await this.o.store.getDrift(id);
    if (!drift) return undefined;
    const updated = { ...drift, resolution };
    await this.o.store.putDrift(updated);
    if (resolution === 'FALSE_POSITIVE' || resolution === 'NOT_MY_BELIEF') {
      // The dismissal rate is the honest quality signal for extraction. If it
      // climbs, the gate is too loose, and no other metric will say so.
      await this.o.store.incrementMetric('ClaimFalsePositiveFeedback');
    }
    return updated;
  }

  /**
   * Write the verified value into Bee's own memory.
   *
   * A confirmed Bee fact is not the same object as the spoken claim and does not
   * replace it: one records what the wearer believed at a moment, the other what
   * the system establishes now. Keeping both is what lets the timeline exist.
   */
  async updateUnderstanding(driftId: string): Promise<{ drift: DriftEvent; factText: string; factId?: string; error?: string }> {
    const drift = await this.o.store.getDrift(driftId);
    if (!drift) throw new Error(`no drift ${driftId}`);
    const resolved = this.o.registry.resolve(drift.subject, drift.property);
    const label = resolved?.property.label ?? `${drift.subject} ${drift.property}`;
    const evidence = await this.o.store.listEvidence(drift.claimId);
    const authoritative = evidence.find((e) => e.authoritative && e.status === 'OK');

    const factText =
      `${label} is currently ${fmt(drift.actualValue)} in production. ` +
      `Verified against ${authoritative?.source ?? 'the configured source of truth'}` +
      `${authoritative ? ` (${authoritative.sourceLocator})` : ''} on ${drift.detectedAt.slice(0, 10)}.`;

    try {
      const fact = await this.o.bee.createFact(factText);
      const id = fact?.id === undefined ? undefined : String(fact.id);
      // Bee facts start unconfirmed. This one is backed by a source read, so it
      // is confirmed explicitly rather than left as an inference.
      if (id) {
        try {
          await this.o.bee.updateFact(id, { confirmed: true });
        } catch {
          /* confirmation is best-effort; the fact itself is what matters */
        }
      }
      await this.resolveDrift(driftId, 'MODEL_UPDATED');
      await this.o.store.incrementMetric('BeeFactsWritten');
      return { drift: { ...drift, resolution: 'MODEL_UPDATED' }, factText, ...(id ? { factId: id } : {}) };
    } catch (err) {
      return { drift, factText, error: (err as Error).message };
    }
  }
}

/**
 * Speaker labels are diarisation, not identity.
 *
 * A multi-speaker conversation cannot be attributed to the wearer without
 * asking, so it is marked UNKNOWN and the UI says "heard in your conversation"
 * rather than "you said". Evaluating a colleague's sentence as the wearer's
 * belief would be both wrong and, in a workplace, genuinely harmful.
 */
export function inferOwnership(speakerCount?: number): Ownership {
  if (speakerCount === 1) return 'LIKELY_USER';
  return 'UNKNOWN';
}

function describeLocator(locator: Record<string, unknown>): string {
  return Object.entries(locator).map(([k, v]) => `${k}=${String(v)}`).join(' ');
}

/** Union by conversation + excerpt, oldest first. */
function mergeOccurrences(
  a: DriftEvent['priorOccurrences'],
  b: DriftEvent['priorOccurrences'],
  extra?: DriftEvent['priorOccurrences'][number],
): DriftEvent['priorOccurrences'] {
  const all = [...a, ...b, ...(extra ? [extra] : [])];
  const seen = new Set<string>();
  return all
    .filter((o) => {
      const key = `${o.conversationId}|${o.excerpt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((x, y) => x.at.localeCompare(y.at));
}

function loose(v: unknown): string {
  return String(v).trim().toLowerCase();
}

function fmt(v: unknown): string {
  return typeof v === 'boolean' ? (v ? 'enabled' : 'disabled') : String(v);
}
