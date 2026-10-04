/**
 * Deterministic adjudication. Pure functions, no I/O, no model.
 *
 * The one invariant worth stating loudly: a connector failure must never become
 * DRIFTED. Telling someone their understanding is stale because an API timed
 * out destroys the product's credibility faster than missing a real drift ever
 * could.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Adjudication, Claim, Evidence, ValueType, Verdict } from './types.ts';

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, once: 1, twice: 2, thrice: 3,
};

const TRUE_WORDS = new Set(['true', 'yes', 'on', 'enabled', 'active', 'present', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'off', 'disabled', 'inactive', 'absent', '0']);

/** Coerce a raw value into the registry's declared domain, or fail loudly. */
export function normalise(value: unknown, type: ValueType): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (value === null || value === undefined) return { ok: false, reason: 'value is absent' };
  switch (type) {
    case 'integer': {
      const n = toNumber(value);
      if (n === null || !Number.isInteger(n)) return { ok: false, reason: `not an integer: ${String(value)}` };
      return { ok: true, value: n };
    }
    case 'number': {
      const n = toNumber(value);
      if (n === null) return { ok: false, reason: `not a number: ${String(value)}` };
      return { ok: true, value: n };
    }
    case 'boolean':
    case 'presence': {
      if (typeof value === 'boolean') return { ok: true, value };
      const s = String(value).trim().toLowerCase();
      if (TRUE_WORDS.has(s)) return { ok: true, value: true };
      if (FALSE_WORDS.has(s)) return { ok: true, value: false };
      return { ok: false, reason: `not a boolean: ${String(value)}` };
    }
    case 'semver': {
      const parts = parseSemver(String(value));
      if (!parts) return { ok: false, reason: `not a version: ${String(value)}` };
      const [major, minor, patch, tag] = parts;
      return { ok: true, value: `${major}.${minor}.${patch}${tag ? `-${tag}` : ''}` };
    }
    case 'string':
      return { ok: true, value: String(value).trim() };
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim().toLowerCase();
  if (s in NUMBER_WORDS) return NUMBER_WORDS[s]!;
  const stripped = s.replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(stripped)) return null;
  const n = Number(stripped);
  return Number.isFinite(n) ? n : null;
}

/**
 * "4.12" and "4.12.0" are the same release to a human and to Sentry, so a
 * missing patch segment is filled rather than treated as a mismatch. Prerelease
 * and build metadata are compared as-is; a claim about "4.12" is *not* satisfied
 * by "4.12.0-rc1".
 */
export function parseSemver(raw: string): [number, number, number, string] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.+))?$/.exec(raw.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0), m[4] ?? ''];
}

/**
 * Adjudicate one claim against one piece of evidence.
 *
 * Ordering matters: evidence health is checked before value comparison, and a
 * non-authoritative source can never produce DRIFTED on its own — it is only
 * ever corroborating context.
 */
export function adjudicate(claim: Claim, evidence: Evidence): Adjudication {
  if (evidence.status !== 'OK') {
    return {
      verdict: 'INCONCLUSIVE',
      reason: `source ${evidence.source} returned ${evidence.status}${evidence.error ? `: ${evidence.error}` : ''}`,
    };
  }
  if (!evidence.authoritative) {
    return {
      verdict: 'INCONCLUSIVE',
      reason: `source ${evidence.source} is not authoritative for ${claim.subject}.${claim.property}`,
    };
  }

  const asserted = normalise(claim.assertedValue, claim.valueType);
  if (!asserted.ok) {
    return { verdict: 'INCONCLUSIVE', reason: `asserted value unusable: ${asserted.reason}` };
  }
  const actual = normalise(evidence.value, claim.valueType);
  if (!actual.ok) {
    return { verdict: 'INCONCLUSIVE', reason: `source value unusable: ${actual.reason}` };
  }

  const same = asserted.value === actual.value;
  return {
    verdict: same ? 'SUPPORTED' : 'DRIFTED',
    reason: same
      ? `${claim.subject}.${claim.property} is ${fmt(actual.value)}, as stated`
      : `stated ${fmt(asserted.value)}, ${evidence.source} reports ${fmt(actual.value)}`,
    normalisedAsserted: asserted.value,
    normalisedActual: actual.value,
  };
}

/**
 * Fold several evidence rows for one claim into a single verdict.
 *
 * Two authoritative sources that disagree is not drift, it is a broken registry,
 * and the honest answer is INCONCLUSIVE with the disagreement named.
 */
export function adjudicateAll(claim: Claim, evidences: Evidence[]): Adjudication {
  const authoritative = evidences.filter((e) => e.authoritative);
  if (authoritative.length === 0) {
    return { verdict: 'INCONCLUSIVE', reason: 'no authoritative source configured or reachable' };
  }
  const healthy = authoritative.filter((e) => e.status === 'OK');
  if (healthy.length === 0) {
    return adjudicate(claim, authoritative[0]!);
  }
  const results = healthy.map((e) => adjudicate(claim, e));
  const distinct = new Set(results.map((r) => JSON.stringify(r.normalisedActual)));
  if (distinct.size > 1) {
    return {
      verdict: 'INCONCLUSIVE',
      reason: `authoritative sources disagree (${healthy.map((e) => `${e.source}=${fmt(e.value)}`).join(', ')})`,
    };
  }
  return results[0]!;
}

export function fmt(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

export function isActionable(verdict: Verdict): boolean {
  return verdict === 'DRIFTED';
}
