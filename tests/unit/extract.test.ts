/**
 * The extractor: propose, then gate.
 *
 * The tests that matter here are not the ones where extraction works. They are
 * the ones where a proposer is wrong -- inventing a value, naming a property
 * outside the registry, or reading two different values out of one sentence --
 * and the deterministic gates catch it without any model being consulted.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Extractor, GrammarProposer, type Proposal, type Proposer } from '#engine/extract/index';
import type { Registry } from '#engine/registry';
import { demoRegistry } from '../helpers.ts';

let registry: Registry;
beforeAll(() => {
  registry = demoRegistry();
});

const at = '2026-09-01T09:00:00.000Z';

function extractor(extra: Proposer[] = []): Extractor {
  return new Extractor(registry, [new GrammarProposer(registry), ...extra]);
}

/** A proposer that says whatever the test tells it to, to exercise the gates. */
function fixedProposer(name: 'bedrock' | 'grammar', proposals: Omit<Proposal, 'proposer'>[]): Proposer {
  return {
    name,
    propose: async () => proposals.map((p) => ({ ...p, proposer: name })),
  };
}

describe('GrammarProposer', () => {
  it('reads a config value that sits beside its lexeme', async () => {
    const out = await new GrammarProposer(registry).propose({ text: 'The checkout worker retries three times.', conversationId: '1', capturedAt: at });
    expect(out).toContainEqual(expect.objectContaining({ subject: 'checkout-worker', property: 'retry.max_attempts', assertedValue: 3 }));
  });

  it('refuses a sentence that names two systems', async () => {
    const out = await new GrammarProposer(registry).propose({
      text: 'The checkout worker retries three times and the events table stores the source IP.',
      conversationId: '1',
      capturedAt: at,
    });
    expect(out).toEqual([]);
  });

  it('picks the number nearest the property lexeme, not the first number in the sentence', async () => {
    const out = await new GrammarProposer(registry).propose({
      text: 'The checkout worker runs 8 consumers and retries three times.',
      conversationId: '1',
      capturedAt: at,
    });
    const retry = out.find((p) => p.property === 'retry.max_attempts');
    expect(retry?.assertedValue).toBe(3);
  });

  it('reads a presence claim only through a registered object alias', async () => {
    const out = await new GrammarProposer(registry).propose({
      text: 'The events table stores the source IP.',
      conversationId: '1',
      capturedAt: at,
    });
    expect(out).toContainEqual(expect.objectContaining({ property: 'column_exists', object: 'source_ip', assertedValue: true }));
  });
});

describe('Extractor gates', () => {
  it('accepts a grounded assertion', async () => {
    const r = await extractor().extract({ text: 'The checkout worker retries three times.', conversationId: '1', capturedAt: at });
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]!.proposal.assertedValue).toBe(3);
  });

  it('rejects a value the proposer invented', async () => {
    // The single most important test in the suite: a model hallucinating a
    // number the speaker never said must not reach verification.
    const r = await extractor([
      fixedProposer('bedrock', [
        { subject: 'checkout-worker', property: 'retry.max_attempts', claimType: 'CONFIG_VALUE', assertedValue: 3, confidence: 0.99 },
      ]),
    ]).extract({ text: 'The checkout worker retries a bunch of times.', conversationId: '1', capturedAt: at });

    expect(r.accepted).toEqual([]);
    expect(r.rejected[0]!.stage).toBe('grounding');
  });

  it('rejects a property that is not in the registry', async () => {
    const r = await extractor([
      fixedProposer('bedrock', [
        { subject: 'checkout-worker', property: 'retry.backoff_seconds', claimType: 'CONFIG_VALUE', assertedValue: 5, confidence: 0.99 },
      ]),
    ]).extract({ text: 'The checkout worker backs off five seconds.', conversationId: '1', capturedAt: at });

    expect(r.accepted).toEqual([]);
    expect(r.rejected[0]!.stage).toBe('registry');
  });

  it('drops both readings when one utterance supports two values for one property', async () => {
    const r = await extractor([
      fixedProposer('bedrock', [
        { subject: 'checkout-worker', property: 'retry.max_attempts', claimType: 'CONFIG_VALUE', assertedValue: 5, confidence: 0.95 },
      ]),
    ]).extract({ text: 'The checkout worker retries three times, or five, I forget.', conversationId: '1', capturedAt: at });

    expect(r.accepted).toEqual([]);
    expect(r.rejected.some((x) => x.stage === 'ambiguity')).toBe(true);
  });

  it('records corroboration when two independent proposers agree, and pays a confidence bonus for it', async () => {
    const text = 'The checkout worker retries three times.';
    const alone = await extractor().extract({ text, conversationId: '1', capturedAt: at });
    const together = await extractor([
      fixedProposer('bedrock', [
        { subject: 'checkout-worker', property: 'retry.max_attempts', claimType: 'CONFIG_VALUE', assertedValue: 3, confidence: 0.9 },
      ]),
    ]).extract({ text, conversationId: '1', capturedAt: at });

    expect(alone.accepted[0]!.corroborated).toBe(false);
    expect(together.accepted[0]!.corroborated).toBe(true);
    expect(together.accepted[0]!.confidence).toBeGreaterThan(alone.accepted[0]!.confidence);
  });

  it('keeps capturing when a proposer throws, and says which one failed', async () => {
    const broken: Proposer = {
      name: 'bedrock',
      propose: async () => {
        throw new Error('ThrottlingException: rate exceeded');
      },
    };
    const r = await extractor([broken]).extract({ text: 'The checkout worker retries three times.', conversationId: '1', capturedAt: at });

    expect(r.accepted).toHaveLength(1);
    expect(r.proposerStatus.find((p) => p.name === 'bedrock')).toMatchObject({ ok: false });
    expect(r.proposerStatus.find((p) => p.name === 'grammar')).toMatchObject({ ok: true });
  });

  it('queues rather than auto-verifies a claim whose subject had to be carried from context', async () => {
    const r = await extractor().extract({
      text: 'It retries three times.',
      window: ['The checkout worker is backing up again.'],
      conversationId: '1',
      capturedAt: at,
    });
    expect(r.accepted[0]?.disposition).toBe('QUEUED');
  });

  it('stays silent on questions, opinions, hypotheses and past beliefs', async () => {
    for (const text of [
      'Does the checkout worker retry three times?',
      'Three retries on the checkout worker seems too low.',
      'Maybe the checkout worker retries three times.',
      'I thought the checkout worker retried three times.',
    ]) {
      const r = await extractor().extract({ text, conversationId: '1', capturedAt: at });
      expect(r.accepted, text).toEqual([]);
    }
  });
});
