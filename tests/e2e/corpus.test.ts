/**
 * The golden corpus, as a regression gate.
 *
 * `pnpm eval` prints the full report for a human. This runs the same 204
 * utterances in CI and fails the build if precision or the false-positive rate
 * moves, because those are the two numbers that decide whether the product is
 * safe to leave listening.
 *
 * The thresholds are deliberately a little below the measured values: this is a
 * guard against regression, not a target to tune against.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Extractor, GrammarProposer } from '#engine/extract/index';
import { Registry } from '#engine/registry';
import { REPO_ROOT } from '../helpers.ts';

interface GoldRow {
  id: string;
  category: 'SUPPORTED_CLAIM' | 'DRIFTED_CLAIM' | 'UNVERIFIABLE' | 'NON_CLAIM';
  text: string;
  window?: string[];
  expect: { subject: string; property: string; value: unknown; object?: string; scope?: Record<string, string> } | null;
}

let corpus: GoldRow[];
let extractor: Extractor;

beforeAll(() => {
  corpus = readFileSync(join(REPO_ROOT, 'tools', 'eval', 'corpus', 'golden.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as GoldRow);
  const registry = Registry.fromFile(join(REPO_ROOT, 'demo', 'source-registry.yaml'));
  extractor = new Extractor(registry, [new GrammarProposer(registry)]);
});

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  const pad = (s: string) => {
    const parts = s.replace(/^v/, '').split('.').map(Number);
    while (parts.length < 3) parts.push(0);
    return parts.join('.');
  };
  const [sa, sb] = [String(a), String(b)];
  if (/^v?\d+(\.\d+)*$/.test(sa) && /^v?\d+(\.\d+)*$/.test(sb)) return pad(sa) === pad(sb);
  return sa.toLowerCase() === sb.toLowerCase();
}

describe('golden corpus', () => {
  it('is balanced across the four categories', () => {
    const counts = corpus.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.category]: (acc[r.category] ?? 0) + 1 }), {});
    expect(Object.keys(counts).sort()).toEqual(['DRIFTED_CLAIM', 'NON_CLAIM', 'SUPPORTED_CLAIM', 'UNVERIFIABLE']);
    for (const [category, n] of Object.entries(counts)) expect(n, category).toBeGreaterThanOrEqual(50);
  });

  it('holds precision at or above 95% and never fires on a non-claim', async () => {
    let truePositives = 0;
    let falsePositives = 0;
    const firedOnNonClaims: string[] = [];

    for (const row of corpus) {
      const { accepted } = await extractor.extract({
        text: row.text,
        ...(row.window ? { window: row.window } : {}),
        conversationId: `corpus-${row.id}`,
        capturedAt: '2026-09-01T09:00:00.000Z',
      });

      if (!row.expect) {
        if (accepted.length > 0) firedOnNonClaims.push(`[${row.id}] ${row.text}`);
        falsePositives += accepted.length;
        continue;
      }
      const gold = row.expect;
      for (const a of accepted) {
        const matches =
          a.proposal.subject === gold.subject &&
          a.proposal.property === gold.property &&
          sameValue(a.proposal.assertedValue, gold.value) &&
          (gold.object === undefined || a.proposal.object === gold.object);
        if (matches) truePositives++;
        else falsePositives++;
      }
    }

    const precision = truePositives / Math.max(1, truePositives + falsePositives);
    const recall = truePositives / corpus.filter((r) => r.expect).length;

    expect(firedOnNonClaims, 'fired on an utterance that asserts nothing').toEqual([]);
    expect(precision).toBeGreaterThanOrEqual(0.95);
    // Recall is the number allowed to be imperfect; it is what the design trades
    // away for the guarantee above.
    expect(recall).toBeGreaterThanOrEqual(0.85);
  });
});
