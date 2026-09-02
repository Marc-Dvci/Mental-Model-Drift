/**
 * The grammar proposer -- registry-driven extraction with no model at all.
 *
 * It exists for three reasons, in order of importance:
 *
 *  1. It is the corroborating opinion. When Bedrock and a rule-based reader
 *     independently land on the same triple, the candidate is much more likely
 *     to be real, and the pipeline records that agreement rather than assuming
 *     it.
 *  2. It is the offline path. The verification half of this product is
 *     deterministic; it would be strange for the capture half to stop working
 *     when a region is degraded or a key expires.
 *  3. It is the measurement floor. Publishing precision for the LLM proposer
 *     means nothing without a baseline that the same golden corpus was run
 *     against.
 *
 * It is deliberately narrow. It reads only what the registry declares, and it
 * reads a value only when that value sits close to a lexeme for the property.
 */
import type { Registry } from '../registry.ts';
import {
  NUMBER_RE,
  PRESENCE_VERBS,
  SEMVER_RE,
  findPolarityWords,
  negatedAfter,
  negatedBefore,
  wearsAUnit,
} from '../polarity.ts';
import type { ExtractionContext, Proposal, Proposer } from './types.ts';
import type { RegistryProperty, ValueType } from '#spec';

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, once: 1, twice: 2, thrice: 3,
};

/** Words nearer than this to the property lexeme count as being about it. */
const PROXIMITY_CHARS = 60;

export class GrammarProposer implements Proposer {
  readonly name = 'grammar';

  constructor(private readonly registry: Registry) {}

  async propose(ctx: ExtractionContext): Promise<Proposal[]> {
    const text = ctx.text;
    let subjects = this.registry.findSubjects(text);

    // A pronoun-only sentence ("it retries three times") is common in speech.
    // Look back at the window for a subject, but only when the current sentence
    // names none -- never to override one it does name.
    if (subjects.length === 0 && ctx.window?.length) {
      const recent = ctx.window.slice(-3).join(' ');
      const carried = this.registry.findSubjects(recent);
      if (carried.length === 1 && /\b(it|its|that|they|them|this)\b/i.test(text)) {
        subjects = carried;
      }
    }
    // Two systems in one sentence is ambiguous. Silence beats a coin flip.
    if (subjects.length !== 1) return [];
    const { systemKey } = subjects[0]!;

    const out: Proposal[] = [];
    for (const { propertyKey, lexeme, property } of this.registry.findProperties(systemKey, text)) {
      const lexemeIndex = indexOfWord(text, lexeme);
      const read = readValue(text, property, lexemeIndex);
      if (read === null) continue;
      out.push({
        subject: systemKey,
        property: propertyKey,
        claimType: property.claimType,
        assertedValue: read.value,
        object: read.object,
        confidence: read.confidence,
        proposer: 'grammar',
        note: `lexeme "${lexeme}" -> ${String(read.value)} from "${read.literal}"`,
      });
    }
    return out;
  }
}

interface ValueRead {
  value: unknown;
  literal: string;
  confidence: number;
  object?: string;
}

/**
 * Read a value of the declared type out of an utterance.
 *
 * `anchor` is where the property was named. Distance from it is the only
 * disambiguation signal used, which is crude but honest: "the worker retries
 * three times and the queue holds four hundred" needs the 3 and not the 400,
 * and nothing subtler than proximity is available without a parser.
 */
export function readValue(text: string, property: RegistryProperty, anchor: number): ValueRead | null {
  const type: ValueType = property.type;
  const lower = text.toLowerCase();

  if (type === 'integer' || type === 'number') {
    const candidates: { value: number; literal: string; index: number }[] = [];
    for (const m of lower.matchAll(NUMBER_RE)) {
      const v = Number(m[1]);
      if (type === 'integer' && !Number.isInteger(v)) continue;
      // A number wearing a unit is measuring something else. See polarity.ts.
      if (wearsAUnit(lower, m.index + m[0].length)) continue;
      candidates.push({ value: v, literal: m[0], index: m.index });
    }
    for (const m of lower.matchAll(/\b([a-z]+)\b/g)) {
      const v = NUMBER_WORDS[m[1]!];
      if (v === undefined) continue;
      // "backs off five seconds between attempts" is not a retry count.
      if (wearsAUnit(lower, m.index + m[0].length)) continue;
      candidates.push({ value: v, literal: m[0], index: m.index });
    }
    const best = nearest(candidates, anchor);
    if (!best) return null;
    return { value: best.value, literal: best.literal, confidence: proximityConfidence(best.index, anchor) };
  }

  if (type === 'semver') {
    const candidates: { value: string; literal: string; index: number }[] = [];
    for (const m of lower.matchAll(SEMVER_RE)) {
      candidates.push({ value: m[1]!, literal: m[0], index: m.index });
    }
    const best = nearest(candidates, anchor);
    if (!best) return null;
    return { value: best.value, literal: best.literal, confidence: proximityConfidence(best.index, anchor) };
  }

  if (type === 'boolean') {
    const candidates = findPolarityWords(lower).map((hit) => ({
      value: negatedBefore(lower, hit.index) ? !hit.value : hit.value,
      literal: text.slice(hit.index, hit.index + hit.literal.length),
      index: hit.index,
    }));
    const best = nearest(candidates, anchor);
    if (!best) return null;
    return { value: best.value, literal: best.literal, confidence: proximityConfidence(best.index, anchor) };
  }

  if (type === 'presence') {
    // Which object is being asserted about has to come from the registry, not
    // from guessing at nouns: "the events table stores the source IP" only
    // resolves to `source_ip` because the registry says those words name it.
    const objects = property.objectAliases ?? {};
    let matchedObject: string | undefined;
    let objectIndex = -1;
    for (const [objectKey, aliases] of Object.entries(objects)) {
      for (const alias of aliases) {
        const i = findWord(lower, alias.toLowerCase());
        if (i !== -1 && (objectIndex === -1 || i < objectIndex)) {
          matchedObject = objectKey;
          objectIndex = i;
        }
      }
    }
    if (!matchedObject) return null;
    const candidates: { value: boolean; literal: string; index: number }[] = [];
    for (const verb of PRESENCE_VERBS) {
      const i = findWord(lower, verb);
      if (i === -1) continue;
      // "has no user agent column" negates after the verb, not before it.
      const negated = negatedBefore(lower, i) || negatedAfter(lower, i + verb.length);
      candidates.push({ value: !negated, literal: text.slice(i, i + verb.length), index: i });
    }
    const best = nearest(candidates, objectIndex === -1 ? anchor : objectIndex);
    if (!best) return null;
    return {
      value: best.value,
      literal: best.literal,
      confidence: proximityConfidence(best.index, objectIndex),
      object: matchedObject,
    };
  }

  return null;
}

function nearest<T extends { index: number }>(candidates: T[], anchor: number): T | null {
  if (candidates.length === 0) return null;
  if (anchor < 0) return candidates[0]!;
  const within = candidates.filter((c) => Math.abs(c.index - anchor) <= PROXIMITY_CHARS);
  const pool = within.length ? within : [];
  if (pool.length === 0) return null;
  return pool.reduce((a, b) => (Math.abs(a.index - anchor) <= Math.abs(b.index - anchor) ? a : b));
}

function proximityConfidence(index: number, anchor: number): number {
  if (anchor < 0) return 0.72;
  const d = Math.abs(index - anchor);
  // 0.92 when the value sits right against the lexeme, decaying to 0.7 at the
  // edge of the proximity window. Never 1.0 -- a rule is not a certainty.
  return Math.max(0.7, 0.92 - (d / PROXIMITY_CHARS) * 0.22);
}

function findWord(haystack: string, needle: string): number {
  const re = new RegExp(`(?<![a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`);
  return haystack.search(re);
}

function indexOfWord(text: string, word: string): number {
  return findWord(text.toLowerCase(), word.toLowerCase());
}
