/**
 * Severity is an integer lattice, and these tests pin the lattice rather than
 * the labels: what earns a point, and where the two thresholds sit. A change to
 * the scoring that does not also change this file is a change nobody reviewed.
 */
import { describe, expect, it } from 'vitest';
import { scoreSeverity, type PriorOccurrence } from '#spec';

const detectedAt = '2026-09-01T09:02:13.000Z';

function occurrence(at: string, afterSourceChange: boolean): PriorOccurrence {
  return { conversationId: 'c', at, excerpt: 'it retries three times', afterSourceChange };
}

describe('scoreSeverity', () => {
  it('scores impact alone for a first-time, historical statement', () => {
    const s = scoreSeverity({ impact: 'LOW', priorOccurrences: [], detectedAt: '2026-09-01T09:00:00.000Z' });
    // impact 1 + recency 1 (the claim itself is today) = 2 -> LOW
    expect(s.score).toBe(2);
    expect(s.severity).toBe('LOW');
  });

  it('adds a point when the belief was restated after the source changed', () => {
    const without = scoreSeverity({ impact: 'HIGH', priorOccurrences: [occurrence('2026-08-12T09:00:00.000Z', false)], detectedAt });
    const with_ = scoreSeverity({ impact: 'HIGH', priorOccurrences: [occurrence('2026-08-30T09:00:00.000Z', true)], detectedAt });
    expect(with_.score).toBe(without.score + 1);
    expect(with_.factors.map((f) => f.name)).toContain('used-after-change');
  });

  it('adds a point once the belief has been spoken three times in total', () => {
    const twice = scoreSeverity({ impact: 'MEDIUM', priorOccurrences: [occurrence('2026-08-12T09:00:00.000Z', false)], detectedAt });
    const thrice = scoreSeverity({
      impact: 'MEDIUM',
      priorOccurrences: [occurrence('2026-08-12T09:00:00.000Z', false), occurrence('2026-08-18T09:00:00.000Z', false)],
      detectedAt,
    });
    expect(twice.factors.map((f) => f.name)).not.toContain('entrenched');
    expect(thrice.factors.map((f) => f.name)).toContain('entrenched');
  });

  it('reaches HIGH for the demo case: high impact, restated after the change, entrenched, recent', () => {
    const s = scoreSeverity({
      impact: 'HIGH',
      sourceChangeAt: '2026-08-23T09:41:00.000Z',
      priorOccurrences: [
        occurrence('2026-08-12T09:14:11.000Z', false),
        occurrence('2026-08-18T14:02:18.000Z', false),
        occurrence('2026-09-01T11:40:21.000Z', true),
      ],
      detectedAt,
    });
    expect(s.score).toBeGreaterThanOrEqual(5);
    expect(s.severity).toBe('HIGH');
  });

  it('explains every point it awarded', () => {
    const s = scoreSeverity({ impact: 'HIGH', priorOccurrences: [occurrence('2026-08-30T09:00:00.000Z', true)], detectedAt });
    expect(s.factors.reduce((total, f) => total + f.points, 0)).toBe(s.score);
    for (const f of s.factors) expect(f.because).toBeTruthy();
  });

  it('scores recency against when the belief was spoken, not when it was checked', () => {
    // A conversation recovered by cursor reconciliation a fortnight later is not
    // evidence of an active belief. Scoring against `detectedAt` would make this
    // factor structurally always true, which is the same as not having it.
    const spokenToday = scoreSeverity({
      impact: 'HIGH',
      priorOccurrences: [occurrence('2026-08-30T09:00:00.000Z', true)],
      lastSpokenAt: '2026-09-01T08:55:00.000Z',
      detectedAt,
    });
    const spokenInJanuary = scoreSeverity({
      impact: 'HIGH',
      priorOccurrences: [occurrence('2026-01-02T09:00:00.000Z', true)],
      lastSpokenAt: '2026-01-02T09:00:00.000Z',
      detectedAt,
    });
    expect(spokenToday.factors.map((f) => f.name)).toContain('recent');
    expect(spokenInJanuary.factors.map((f) => f.name)).not.toContain('recent');
    expect(spokenInJanuary.score).toBe(spokenToday.score - 1);
  });
});
