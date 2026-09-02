/**
 * Extraction: propose, then gate.
 *
 * Proposers are allowed to be clever. Nothing downstream of this file is.
 * Every proposal must survive three checks that no model participates in:
 *
 *   registry    the subject and property exist and are configured
 *   grounding   the subject, the property and the value were actually spoken,
 *               in a clause that asserts rather than asks, proposes or hedges
 *   ambiguity   the utterance does not support two different values for the
 *               same property
 *
 * Precision is the metric this is tuned for. A missed claim costs an
 * opportunity; a false one costs the user's trust in every card that follows.
 */
import type { GroundingReport } from '#spec';
import { ground } from '../grounding.ts';
import type { Registry } from '../registry.ts';
import type {
  AcceptedClaim,
  ExtractionContext,
  ExtractionResult,
  Proposal,
  Proposer,
  RejectedProposal,
} from './types.ts';

export * from './types.ts';
export { GrammarProposer } from './grammar.ts';
export { BedrockProposer } from './bedrock.ts';

export interface ExtractorOptions {
  /** Below this, the candidate is dropped silently. */
  discardBelow?: number;
  /** At or above this, verification runs without asking the user anything. */
  autoVerifyAt?: number;
}

export type Disposition = 'AUTO' | 'QUEUED';

export interface Accepted extends AcceptedClaim {
  disposition: Disposition;
}

export class Extractor {
  private readonly discardBelow: number;
  private readonly autoVerifyAt: number;

  constructor(
    private readonly registry: Registry,
    private readonly proposers: Proposer[],
    opts: ExtractorOptions = {},
  ) {
    this.discardBelow = opts.discardBelow ?? 0.8;
    this.autoVerifyAt = opts.autoVerifyAt ?? 0.92;
  }

  async extract(ctx: ExtractionContext): Promise<ExtractionResult & { accepted: Accepted[] }> {
    const proposerStatus: ExtractionResult['proposerStatus'] = [];
    const all: Proposal[] = [];

    // Proposers are independent and one failing must not silence the others:
    // losing Bedrock should degrade extraction, not stop capture.
    const settled = await Promise.all(
      this.proposers.map(async (p) => {
        const t0 = Date.now();
        try {
          const proposals = await p.propose(ctx);
          return { name: p.name, ok: true, ms: Date.now() - t0, proposals };
        } catch (err) {
          return { name: p.name, ok: false, ms: Date.now() - t0, proposals: [] as Proposal[], error: (err as Error).message };
        }
      }),
    );
    for (const s of settled) {
      proposerStatus.push({ name: s.name, ok: s.ok, ms: s.ms, ...(s.error ? { error: s.error } : {}) });
      all.push(...s.proposals);
    }

    const rejected: RejectedProposal[] = [];
    const merged = mergeProposals(all);
    const accepted: Accepted[] = [];

    for (const { proposal, proposers } of merged) {
      const resolved = this.registry.resolve(proposal.subject, proposal.property);
      if (!resolved) {
        rejected.push({ proposal, reason: `${proposal.subject}.${proposal.property} is not in the registry`, stage: 'registry' });
        continue;
      }

      const g = ground({
        text: ctx.text,
        ...(ctx.window?.length ? { windowText: ctx.window.slice(-3).join(' ') } : {}),
        subject: resolved.systemKey,
        subjectAliases: resolved.system.aliases,
        propertyKey: resolved.propertyKey,
        property: resolved.property,
        assertedValue: proposal.assertedValue,
        object: proposal.object,
        scope: proposal.scope,
      });

      const report: GroundingReport = {
        speechAct: g.speechAct.act,
        subjectAliasMatched: g.subjectAliasMatched,
        valueLiteralMatched: g.valueLiteralMatched,
        propertyLexemeMatched: g.propertyLexemeMatched,
        passed: g.passed,
        ...(g.rejectedBy ? { rejectedBy: g.rejectedBy } : {}),
      };

      if (!g.passed) {
        rejected.push({ proposal, reason: g.rejectedBy!, stage: 'grounding' });
        continue;
      }

      const corroborated = proposers.size > 1;
      const confidence = combine(proposal.confidence, g.strength, corroborated);
      if (confidence < this.discardBelow) {
        rejected.push({ proposal, reason: `confidence ${confidence.toFixed(2)} below ${this.discardBelow}`, stage: 'threshold' });
        continue;
      }

      accepted.push({
        proposal: { ...proposal, scope: g.resolvedScope ?? proposal.scope },
        grounding: report,
        confidence,
        corroborated,
        disposition: confidence >= this.autoVerifyAt ? 'AUTO' : 'QUEUED',
      });
    }

    // One utterance cannot assert two different values for the same property.
    // When it appears to, the reading is wrong, and both readings go.
    const byProperty = new Map<string, Accepted[]>();
    for (const a of accepted) byProperty.set(key(a.proposal), [...(byProperty.get(key(a.proposal)) ?? []), a]);
    const survivors: Accepted[] = [];
    for (const group of byProperty.values()) {
      const distinct = new Set(group.map((a) => JSON.stringify(a.proposal.assertedValue)));
      if (distinct.size > 1) {
        for (const a of group) {
          rejected.push({ proposal: a.proposal, reason: 'the utterance supports more than one value for this property', stage: 'ambiguity' });
        }
        continue;
      }
      survivors.push(group[0]!);
    }

    return { proposals: all, accepted: survivors, rejected, proposerStatus };
  }
}

/**
 * Confidence after gating.
 *
 * Deliberately a blend rather than a product: a strongly grounded claim from a
 * hesitant proposer and a confident proposal that barely grounds should both
 * land in the middle, and multiplication would push both to the floor. The
 * corroboration bonus is small because the two proposers are not independent --
 * they read the same registry.
 */
function combine(proposerConfidence: number, groundingStrength: number, corroborated: boolean): number {
  const blended = 0.55 * proposerConfidence + 0.45 * groundingStrength;
  return Math.max(0, Math.min(1, blended + (corroborated ? 0.07 : 0)));
}

function key(p: Proposal): string {
  return `${p.subject}\u0000${p.property}\u0000${p.object ?? ''}\u0000${JSON.stringify(p.scope ?? {})}`;
}

function fullKey(p: Proposal): string {
  return `${key(p)}\u0000${JSON.stringify(p.assertedValue)}`;
}

function mergeProposals(all: Proposal[]): { proposal: Proposal; proposers: Set<string> }[] {
  const byKey = new Map<string, { proposal: Proposal; proposers: Set<string> }>();
  for (const p of all) {
    const k = fullKey(p);
    const existing = byKey.get(k);
    if (!existing) {
      byKey.set(k, { proposal: p, proposers: new Set([p.proposer]) });
      continue;
    }
    existing.proposers.add(p.proposer);
    if (p.confidence > existing.proposal.confidence) {
      existing.proposal = { ...p, note: [existing.proposal.note, p.note].filter(Boolean).join('; ') };
    } else {
      existing.proposal = { ...existing.proposal, note: [existing.proposal.note, p.note].filter(Boolean).join('; ') };
    }
  }
  return [...byKey.values()];
}
