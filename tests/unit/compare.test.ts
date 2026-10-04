/**
 * Adjudication.
 *
 * One invariant dominates this file: a connector that failed must never produce
 * DRIFTED. Telling someone their understanding is stale because an API timed
 * out costs more trust than a hundred missed drifts, and it is the failure mode
 * a two-valued true/false verdict would make structurally unavoidable.
 */
import { describe, expect, it } from 'vitest';
import { adjudicate, adjudicateAll, normalise, parseSemver } from '#spec';
import type { Evidence } from '#spec';
import { claim } from '../helpers.ts';

function evidence(partial: Partial<Evidence> = {}): Evidence {
  return {
    id: 'ev-1',
    claimId: 'claim-test',
    source: 'AWS_APPCONFIG',
    sourceLocator: 'appconfig://ecommerce/production/checkout-worker$.retry.max_attempts',
    status: 'OK',
    value: 1,
    authoritative: true,
    fetchedAt: '2026-09-01T09:00:00.000Z',
    evidenceHash: 'hash',
    ...partial,
  };
}

const retryClaim = claim({ subject: 'checkout-worker', property: 'retry.max_attempts', assertedValue: 3, valueType: 'integer' });

describe('normalise', () => {
  it('coerces spoken number words', () => {
    expect(normalise('three', 'integer')).toEqual({ ok: true, value: 3 });
    expect(normalise('twice', 'integer')).toEqual({ ok: true, value: 2 });
  });

  it('fills a missing patch segment so 4.12 and 4.12.0 are one release', () => {
    expect(normalise('4.12', 'semver')).toEqual({ ok: true, value: '4.12.0' });
    expect(normalise('v4.12.0', 'semver')).toEqual({ ok: true, value: '4.12.0' });
  });

  it('keeps a prerelease distinct from the release', () => {
    expect(normalise('4.13.0-rc1', 'semver')).toEqual({ ok: true, value: '4.13.0-rc1' });
    expect(normalise('4.13.0-rc1', 'semver')).not.toEqual(normalise('4.13.0', 'semver'));
  });

  it('reads the vocabulary people actually use for booleans', () => {
    for (const yes of [true, 'true', 'on', 'enabled', 'yes', '1']) expect(normalise(yes, 'boolean')).toEqual({ ok: true, value: true });
    for (const no of [false, 'false', 'off', 'disabled', 'no', '0']) expect(normalise(no, 'boolean')).toEqual({ ok: true, value: false });
  });

  it('fails loudly rather than guessing', () => {
    expect(normalise('a few', 'integer').ok).toBe(false);
    expect(normalise('3.5', 'integer').ok).toBe(false);
    expect(normalise(null, 'string').ok).toBe(false);
    expect(normalise('sometimes', 'boolean').ok).toBe(false);
  });

  it('parses versions with and without a leading v', () => {
    expect(parseSemver('v1.2.3')).toEqual([1, 2, 3, '']);
    expect(parseSemver('not-a-version')).toBeNull();
  });
});

describe('adjudicate', () => {
  it('reports DRIFTED when an authoritative source disagrees', () => {
    const a = adjudicate(retryClaim, evidence({ value: 1 }));
    expect(a.verdict).toBe('DRIFTED');
    expect(a.reason).toMatch(/stated 3, AWS_APPCONFIG reports 1/);
  });

  it('reports SUPPORTED when it agrees', () => {
    expect(adjudicate(retryClaim, evidence({ value: 3 })).verdict).toBe('SUPPORTED');
  });

  it('never converts a connector failure into drift', () => {
    for (const status of ['UNAVAILABLE', 'NOT_FOUND', 'FORBIDDEN', 'AMBIGUOUS'] as const) {
      const a = adjudicate(retryClaim, evidence({ status, value: undefined, error: 'boom' }));
      expect(a.verdict, status).toBe('INCONCLUSIVE');
    }
  });

  it('refuses to decide on a non-authoritative source', () => {
    // GitHub can say what the repository holds; only the deployed configuration
    // says what production is running.
    const a = adjudicate(retryClaim, evidence({ source: 'GITHUB', authoritative: false, value: 1 }));
    expect(a.verdict).toBe('INCONCLUSIVE');
    expect(a.reason).toMatch(/not authoritative/);
  });

  it('is inconclusive when the source value cannot be read as the declared type', () => {
    const a = adjudicate(retryClaim, evidence({ value: 'unlimited' }));
    expect(a.verdict).toBe('INCONCLUSIVE');
    expect(a.reason).toMatch(/source value unusable/);
  });
});

describe('adjudicateAll', () => {
  it('is inconclusive with no authoritative evidence at all', () => {
    expect(adjudicateAll(retryClaim, []).verdict).toBe('INCONCLUSIVE');
    expect(adjudicateAll(retryClaim, [evidence({ authoritative: false })]).verdict).toBe('INCONCLUSIVE');
  });

  it('treats two authoritative sources that disagree as a broken registry, not as drift', () => {
    const a = adjudicateAll(retryClaim, [
      evidence({ id: 'a', source: 'AWS_APPCONFIG', value: 1 }),
      evidence({ id: 'b', source: 'GITHUB', authoritative: true, value: 2 }),
    ]);
    expect(a.verdict).toBe('INCONCLUSIVE');
    expect(a.reason).toMatch(/disagree/);
  });

  it('ignores an unhealthy source when a healthy authoritative one answered', () => {
    const a = adjudicateAll(retryClaim, [
      evidence({ id: 'a', source: 'SENTRY', status: 'UNAVAILABLE', value: undefined }),
      evidence({ id: 'b', source: 'AWS_APPCONFIG', value: 1 }),
    ]);
    expect(a.verdict).toBe('DRIFTED');
  });
});
