/**
 * Drift severity.
 *
 * Deliberately a small integer lattice rather than a probability. "73% dangerous"
 * is not a thing an engineer can act on, and calibrating such a number honestly
 * would need outcome data this product does not have. What it does have is three
 * facts a human set or a source proved:
 *
 *   impact      how much damage acting on the stale belief could do (registry, human-set)
 *   recurrence  how often the belief was spoken, and whether after the change
 *   recency     whether it is still in active use
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import type { PriorOccurrence, Severity } from './types.ts';

const IMPACT_POINTS = { HIGH: 3, MEDIUM: 2, LOW: 1 } as const;

/** A belief nobody has voiced in this many days is not shaping today's decisions. */
const RECENT_DAYS = 7;

export interface SeverityInput {
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
  priorOccurrences: PriorOccurrence[];
  detectedAt: string;
  sourceChangeAt?: string;
  /**
   * When the belief was last actually spoken. Distinct from `detectedAt`, which
   * is when this process got round to checking: a conversation recovered by
   * cursor reconciliation days later is not evidence of an active belief, and
   * scoring recency against the detection instant would silently make this
   * factor always true.
   */
  lastSpokenAt?: string;
}

export interface SeverityBreakdown {
  severity: Severity;
  score: number;
  factors: { name: string; points: number; because: string }[];
}

export function scoreSeverity(input: SeverityInput): SeverityBreakdown {
  const factors: SeverityBreakdown['factors'] = [];

  const impact = IMPACT_POINTS[input.impact];
  factors.push({ name: 'impact', points: impact, because: `property impact is ${input.impact}` });

  // The belief being restated *after* the system changed is the strongest signal
  // available: it separates a one-off slip from a model that is actively wrong.
  const after = input.priorOccurrences.filter((o) => o.afterSourceChange).length;
  if (after > 0) {
    factors.push({
      name: 'used-after-change',
      points: 1,
      because: `stated ${after} time${after === 1 ? '' : 's'} after the source changed`,
    });
  }

  const total = input.priorOccurrences.length + 1;
  if (total >= 3) {
    factors.push({ name: 'entrenched', points: 1, because: `stated ${total} times in total` });
  }

  const days = daysBetween(mostRecent(input), input.detectedAt);
  if (days !== null && days <= RECENT_DAYS) {
    factors.push({ name: 'recent', points: 1, because: `in active use within the last ${RECENT_DAYS} days` });
  }

  const score = factors.reduce((s, f) => s + f.points, 0);
  const severity: Severity = score >= 5 ? 'HIGH' : score >= 3 ? 'MEDIUM' : 'LOW';
  return { severity, score, factors };
}

/**
 * The latest moment the belief was *voiced* -- never the moment it was checked.
 */
function mostRecent(input: SeverityInput): string {
  const times = input.priorOccurrences.map((o) => o.at).concat(input.lastSpokenAt ?? input.detectedAt);
  return times.sort().at(-1)!;
}

function daysBetween(a: string, b: string): number | null {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.abs(tb - ta) / 86_400_000;
}
