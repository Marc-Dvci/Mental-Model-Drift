/**
 * Grounding -- the deterministic gate every candidate claim must pass.
 *
 * The extraction step is allowed to use a language model. This step is not. A
 * proposal survives only if the words it claims were spoken were, in fact,
 * spoken: the subject alias, a lexeme for the property, and a literal for the
 * value must each be found in the utterance itself.
 *
 * That constraint is what stops the failure mode that would sink this product:
 * a model that quietly normalises "it retries a few times" into
 * `max_attempts = 3` and then tells a human their understanding is wrong about
 * a number they never said.
 */
import type { RegistryProperty, ValueType } from '#spec';
import {
  NUMBER_RE,
  PRESENCE_VERBS,
  SEMVER_RE,
  findPolarityWords,
  negatedAfter,
  negatedBefore,
  wearsAUnit,
} from './polarity.ts';
import { classifyCarrier, type SpeechActResult } from './speech-act.ts';

export interface ValueLiteral {
  /** The exact substring of the utterance the value was read from. */
  literal: string;
  value: unknown;
  /** True when the surrounding clause negates it (handled only for booleans). */
  negated: boolean;
}

export interface GroundingInput {
  text: string;
  /**
   * Preceding utterances of the same conversation, joined. A subject may be
   * grounded here rather than in the utterance itself, but only when the
   * utterance carries a pronoun and the window names exactly one system.
   */
  windowText?: string;
  subject: string;
  subjectAliases: string[];
  propertyKey: string;
  property: RegistryProperty;
  assertedValue: unknown;
  object?: string;
  scope?: Record<string, string>;
}

export interface GroundingResult {
  passed: boolean;
  rejectedBy?: string;
  speechAct: SpeechActResult;
  subjectAliasMatched: string | null;
  propertyLexemeMatched: string | null;
  valueLiteralMatched: string | null;
  resolvedScope?: Record<string, string>;
  /** True when the subject came from the conversation window, not this sentence. */
  subjectCarried: boolean;
  /** 0..1. Reflects how much of the claim was literally present in speech. */
  strength: number;
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, once: 1, twice: 2, thrice: 3, single: 1,
};

const PRONOUN = /\b(it|its|it's|that|they|them|this|these|those)\b/i;

export function ground(input: GroundingInput): GroundingResult {
  const text = input.text;
  const lower = ` ${norm(text)} `;

  const aliases = [...input.subjectAliases, input.subject].map((a) => norm(a)).filter(Boolean);
  const inUtterance = aliases.filter((a) => lower.includes(` ${a} `)).sort((a, b) => b.length - a.length)[0] ?? null;

  // People stop naming the subject after the first sentence. Allowing the
  // window to ground it is what makes "it retries three times" usable at all --
  // but only behind a pronoun, and at a confidence penalty, because the
  // referent is inferred rather than heard.
  const carried =
    inUtterance === null && input.windowText && PRONOUN.test(text)
      ? aliases.filter((a) => ` ${norm(input.windowText!)} `.includes(` ${a} `)).sort((a, b) => b.length - a.length)[0] ?? null
      : null;

  const subjectAliasMatched = inUtterance ?? carried;
  const subjectCarried = inUtterance === null && carried !== null;

  const propertyLexemeMatched =
    input.property.lexemes
      .map((l) => norm(l))
      .filter((l) => l && lower.includes(` ${l} `))
      .sort((a, b) => b.length - a.length)[0] ?? null;

  const literal = findValueLiteral(text, input.property.type, input.assertedValue, {
    object: input.object,
    objectAliases: input.property.objectAliases,
  });

  const speechAct = classifyCarrier(text, literal?.literal);

  const scopeResult = resolveScope(text, input.property, input.scope);

  const fail = (rejectedBy: string): GroundingResult => ({
    passed: false,
    rejectedBy,
    speechAct,
    subjectAliasMatched,
    propertyLexemeMatched,
    valueLiteralMatched: literal?.literal ?? null,
    resolvedScope: scopeResult.scope,
    subjectCarried,
    strength: 0,
  });

  if (!subjectAliasMatched) return fail('no registry alias for the subject appears in the utterance or its immediate context');
  if (!propertyLexemeMatched) return fail(`no lexeme for ${input.propertyKey} appears in the utterance`);
  if (!literal) return fail('the asserted value does not appear literally in the utterance');
  if (!speechAct.assertive && !assertsByNegation(speechAct, input.property.type, literal)) {
    return fail(`clause is ${speechAct.act}${speechAct.trigger ? ` ("${speechAct.trigger}")` : ''}, not an assertion`);
  }
  if (!scopeResult.ok) return fail(scopeResult.reason!);

  // Strength measures how much of the claim was literally spoken in this
  // sentence. It is not a probability that the claim is true, and it is never
  // shown to the user as one -- truth comes from the source, not from here.
  //
  // Reaching this line already means all three components were found, which is
  // the 0.55 floor. The rest asks how *directly* they were said.
  const lexemeIndex = indexOfPhrase(text, propertyLexemeMatched);
  const literalIndex = text.toLowerCase().indexOf(literal.literal.toLowerCase());
  const adjacent = lexemeIndex >= 0 && literalIndex >= 0 && Math.abs(lexemeIndex - literalIndex) <= 25;

  let strength = 0.55;
  if (!subjectCarried) strength += 0.15;
  if (adjacent) strength += 0.15;
  if (speechAct.act === 'ASSERTION') strength += 0.1;
  if (scopeResult.matchedWords) strength += 0.05;
  if (literal.negated) strength -= 0.05;

  return {
    passed: true,
    speechAct,
    subjectAliasMatched,
    propertyLexemeMatched,
    valueLiteralMatched: literal.literal,
    resolvedScope: scopeResult.scope,
    subjectCarried,
    strength: Math.max(0, Math.min(1, strength)),
  };
}

/**
 * Is a negated clause nonetheless asserting a value?
 *
 * "The dead letter queue is not enabled" states what the system is, as flatly
 * as "the dead letter queue is disabled" -- over a two-valued domain, denying
 * one value asserts the other, and the grounding step has already folded that
 * negation into the value it read.
 *
 * Over any wider domain it does not. "The worker doesn't retry three times"
 * denies a value without asserting one: not-three is not a number, and treating
 * it as a claim of three inverts what the person said. So this is allowed for
 * booleans and presence facts only.
 */
function assertsByNegation(speechAct: SpeechActResult, type: ValueType, literal: ValueLiteral): boolean {
  return speechAct.act === 'NEGATED' && literal.negated && (type === 'boolean' || type === 'presence');
}

/**
 * Find the exact substring the asserted value was read from.
 *
 * Returns null when the value cannot be traced to spoken words -- which is the
 * whole point. "It retries a bunch of times" grounds nothing.
 */
export function findValueLiteral(
  text: string,
  type: ValueType,
  assertedValue: unknown,
  opts: { object?: string; objectAliases?: Record<string, string[]> } = {},
): ValueLiteral | null {
  const lower = text.toLowerCase();

  switch (type) {
    case 'integer':
    case 'number': {
      const want = Number(assertedValue);
      if (!Number.isFinite(want)) return null;
      for (const m of lower.matchAll(NUMBER_RE)) {
        if (Number(m[1]) !== want) continue;
        // A number wearing a unit is measuring something else entirely.
        if (wearsAUnit(lower, m.index + m[0].length)) continue;
        return { literal: m[0], value: want, negated: false };
      }
      for (const [word, n] of Object.entries(NUMBER_WORDS)) {
        if (n !== want) continue;
        const m = new RegExp(`\\b${word}\\b`).exec(lower);
        if (m && !wearsAUnit(lower, m.index + m[0].length)) return { literal: m[0], value: want, negated: false };
      }
      return null;
    }

    case 'boolean': {
      const want = toBool(assertedValue);
      if (want === null) return null;
      // Read every polarity word, then apply local negation. This is what lets
      // "isn't enabled" ground a claim of `false`.
      for (const hit of findPolarityWords(lower)) {
        const negated = negatedBefore(lower, hit.index);
        if ((negated ? !hit.value : hit.value) === want) {
          return { literal: text.slice(hit.index, hit.index + hit.literal.length), value: want, negated };
        }
      }
      return null;
    }

    case 'presence': {
      const want = toBool(assertedValue);
      if (want === null) return null;
      const aliases = opts.object ? opts.objectAliases?.[opts.object] ?? [opts.object] : [];
      const objectSpoken = aliases.length === 0 || aliases.some((a) => lower.includes(norm(a)));
      if (!objectSpoken) return null;
      for (const verb of PRESENCE_VERBS) {
        const m = new RegExp(`\\b${verb}\\b`).exec(lower);
        if (!m) continue;
        // "has no user agent column" negates after the verb, not before it.
        const negated = negatedBefore(lower, m.index) || negatedAfter(lower, m.index + m[0].length);
        if ((negated ? false : true) === want) {
          return { literal: text.slice(m.index, m.index + m[0].length), value: want, negated };
        }
      }
      return null;
    }

    case 'semver': {
      const want = String(assertedValue).replace(/^v/, '');
      // Accept a claim of "4.12" grounded by the spoken "4.12.0" and vice versa;
      // to a human and to Sentry they name the same release.
      for (const m of lower.matchAll(SEMVER_RE)) {
        if (sameRelease(m[1]!, want)) return { literal: m[0], value: want, negated: false };
      }
      return null;
    }

    case 'string': {
      const want = String(assertedValue).toLowerCase().trim();
      if (!want) return null;
      const idx = lower.indexOf(want);
      return idx === -1 ? null : { literal: text.slice(idx, idx + want.length), value: assertedValue, negated: false };
    }
  }
}

function resolveScope(
  text: string,
  property: RegistryProperty,
  claimed?: Record<string, string>,
): { ok: boolean; scope?: Record<string, string>; reason?: string; matchedWords?: boolean } {
  if (!property.scopes) return { ok: true, scope: claimed };
  const lower = ` ${norm(text)} `;
  const resolved: Record<string, string> = {};
  let matchedWords = false;

  for (const [dimension, values] of Object.entries(property.scopes)) {
    const hits: string[] = [];
    for (const [value, words] of Object.entries(values)) {
      if (words.some((w) => lower.includes(` ${norm(w)} `))) hits.push(value);
    }
    if (hits.length > 1) {
      return { ok: false, reason: `scope ${dimension} is ambiguous (${hits.join(', ')} all mentioned)` };
    }
    if (hits.length === 1) {
      resolved[dimension] = hits[0]!;
      matchedWords = true;
      if (claimed?.[dimension] && claimed[dimension] !== hits[0]) {
        return { ok: false, reason: `scope ${dimension} was proposed as ${claimed[dimension]} but the utterance says ${hits[0]}` };
      }
    } else if (claimed?.[dimension]) {
      return { ok: false, reason: `scope ${dimension}=${claimed[dimension]} was proposed but no matching words were spoken` };
    } else {
      return { ok: false, reason: `property requires a ${dimension} and none was spoken` };
    }
  }
  return { ok: true, scope: resolved, matchedWords };
}

function sameRelease(a: string, b: string): boolean {
  const pad = (s: string) => {
    const p = s.split('.').map(Number);
    while (p.length < 3) p.push(0);
    return p.join('.');
  };
  return pad(a) === pad(b);
}

function toBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase().trim();
  if (['true', 'yes', 'on', 'enabled', '1'].includes(s)) return true;
  if (['false', 'no', 'off', 'disabled', '0'].includes(s)) return false;
  return null;
}

/** Index of a normalised phrase back in the original text, or -1. */
function indexOfPhrase(text: string, phrase: string): number {
  const words = phrase.split(' ').filter(Boolean);
  if (words.length === 0) return -1;
  const re = new RegExp(words.map(escape).join('[^a-z0-9]+'), 'i');
  return text.search(re);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[_\-.]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
