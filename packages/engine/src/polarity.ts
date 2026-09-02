/**
 * The spoken vocabulary of on and off, in one place.
 *
 * This used to be two lists -- one in the grammar proposer, one in the grounding
 * gate -- and they had already drifted apart from each other, which is a
 * pleasing kind of irony and also a real bug: a value the proposer could read
 * and the gate could not is a claim that silently disappears.
 *
 * The interesting entries are `on` and `off`. As bare words they are the most
 * common polarity terms in speech and also two of the most common prepositions
 * and particles in English:
 *
 *     "the DLQ on the checkout worker is inactive"
 *     "checkout backs off five seconds between attempts"
 *
 * Reading either of those as a polarity word is not a near miss, it is a
 * confident wrong answer -- the first one inverts the claim. So `on` and `off`
 * count only in a copular or adverbial frame ("is off", "still on", "back on"),
 * where they are being used as a state and not as a preposition.
 */

export interface PolarityHit {
  value: boolean;
  /** The exact substring the polarity was read from. */
  literal: string;
  index: number;
}

/** Words that mean a state on their own, in any position. */
const UNAMBIGUOUS: { re: RegExp; value: boolean }[] = [
  { re: /\b(?:enabled|enable|live|active|rolled out|turned on|switched on|shipped)\b/gi, value: true },
  { re: /\b(?:disabled|disable|dark|inactive|turned off|switched off)\b/gi, value: false },
];

/** `on` / `off` only where they are a state rather than a preposition. */
const COPULAR: { re: RegExp; value: boolean }[] = [
  { re: /\b(?:is|are|was|were|be|been|being|still|back|stays|stayed|remains|remained|left)\s+(on)\b/gi, value: true },
  { re: /\b(?:is|are|was|were|be|been|being|still|back|stays|stayed|remains|remained|left)\s+(off)\b/gi, value: false },
];

/**
 * `on` and `off` inside a fixed phrase, where they are not a state at all.
 *
 * "we are on call this week" and "the new checkout is on the roadmap" both sit
 * in the copular frame and neither says anything is switched on. A determiner
 * or one of these nouns following the word means it is taking a complement.
 */
const TAKES_A_COMPLEMENT = /^\s+(?:call|hold|track|top|site|board|purpose|average|prem|premise|premises|duty|leave|holiday|standby|the|a|an|my|our|its|their|his|her)\b/i;

/**
 * Every polarity word in the text, in order of appearance.
 *
 * `index` points at the polarity word itself, not at the copula, so callers can
 * measure distance to the property lexeme the way they do for numbers.
 */
export function findPolarityWords(text: string): PolarityHit[] {
  const hits: PolarityHit[] = [];
  for (const { re, value } of UNAMBIGUOUS) {
    for (const m of text.matchAll(re)) hits.push({ value, literal: m[0], index: m.index });
  }
  for (const { re, value } of COPULAR) {
    for (const m of text.matchAll(re)) {
      const word = m[1]!;
      const index = m.index + m[0].lastIndexOf(word);
      if (TAKES_A_COMPLEMENT.test(text.slice(index + word.length, index + word.length + 16))) continue;
      hits.push({ value, literal: word, index });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** Verbs that assert an attribute is present. */
export const PRESENCE_VERBS = [
  'stores', 'store', 'storing', 'has', 'have', 'contains', 'contain', 'includes', 'include',
  'records', 'record', 'logs', 'log', 'keeps', 'keep', 'tracks', 'track', 'captures', 'capture',
  'added', 'holds',
];

const NEGATORS = "not|isn't|is not|aren't|are not|no longer|never|doesn't|does not|don't|do not|didn't|did not|wasn't|was not|hasn't|has not|haven't|have not";

/**
 * Negation immediately before the matched word.
 *
 * Deliberately local. "we don't know whether checkout is enabled in Europe"
 * must not have `don't` reach across nine words to flip `enabled`; the
 * clause-level speech-act check is what handles that sentence.
 */
export function negatedBefore(lower: string, index: number): boolean {
  const before = lower.slice(Math.max(0, index - 40), index);
  return new RegExp(`\\b(?:${NEGATORS})\\b[\\s\\w']{0,20}$`).test(before);
}

/**
 * Negation carried by the object rather than by the verb: "has *no* user agent
 * column", "keeps *no* record of it". English puts the negative after the verb
 * in exactly the construction people use to deny that a column exists, and
 * looking only backwards reads those sentences as asserting the opposite.
 */
export function negatedAfter(lower: string, endIndex: number): boolean {
  return /^\s+(?:no|not|never|zero)\b/.test(lower.slice(endIndex, endIndex + 12));
}

/**
 * Units that mean a number is measuring something other than a count.
 *
 * "checkout backs off five seconds between attempts" contains a property lexeme
 * (`attempts`) and a number five characters from it, and the retry count is not
 * five. A number wearing a unit is answering a different question, and the
 * cheapest correct thing to do with it is nothing.
 */
const UNIT_AFTER = /^\s*(?:ms|milliseconds?|s|secs?|seconds?|mins?|minutes?|hours?|hrs?|days?|weeks?|months?|years?|percent|%|kb|mb|gb|tb|bytes?|k|m|bn)\b/i;

export function wearsAUnit(text: string, endIndex: number): boolean {
  return UNIT_AFTER.test(text.slice(endIndex, endIndex + 16));
}

/**
 * A number, allowing the sentence-final period.
 *
 * `(?![\w.])` looks correct and quietly loses every value spoken at the end of
 * a sentence -- "max attempts is 5." and "the release is 4.13." -- which in a
 * transcript is where values usually are. What must be excluded is a *digit*
 * continuing after a dot, not punctuation.
 */
export const NUMBER_RE = /(?<![\w.])(\d+(?:\.\d+)*)(?!\.?\d)(?!\w)/g;
export const SEMVER_RE = /(?<![\w.])v?(\d+\.\d+(?:\.\d+)?)(?!\.?\d)(?!\w)/g;
