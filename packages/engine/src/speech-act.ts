/**
 * Speech-act classification, deterministic.
 *
 * Ambient capture hears everything, and most of what it hears looks superficially
 * like a claim. "Does the worker retry twice?", "two retries seems too low",
 * "maybe retries caused it" and "the worker retries twice" all contain a subject,
 * a property and a number. Only the last is a statement about what the system is.
 *
 * Getting this wrong is not a small error. A false positive here means telling
 * someone their understanding is stale about something they never asserted, and
 * one of those costs more trust than ten missed drifts gain.
 *
 * Two design points worth stating:
 *
 *  - Classification is per *clause*, not per utterance. "It's probably fine.
 *    Checkout retries failed jobs three times anyway." is a hedge followed by a
 *    flat assertion, and scoring the whole utterance as hedged would throw away
 *    the single most representative example of the problem this product exists
 *    to solve.
 *
 *  - "I thought it was three" is deliberately *not* an assertion. The speaker has
 *    already marked the belief as past. Correcting someone who is mid-correction
 *    is the most irritating possible behaviour.
 */

export type SpeechAct =
  | 'ASSERTION'       // "the worker retries three times"
  | 'BELIEF_HEDGE'    // "I'm pretty sure the worker retries three times"
  | 'QUESTION'        // "does the worker retry three times?"
  | 'HYPOTHESIS'      // "maybe the worker retries three times"
  | 'OPINION'         // "three retries seems too low"
  | 'DIRECTIVE'       // "set the worker to three retries"
  | 'CONDITIONAL'     // "if the worker retried three times we'd be fine"
  | 'FUTURE'          // "the worker will retry three times"
  | 'PAST_BELIEF'     // "I thought the worker retried three times"
  | 'REPORTED'        // "Sam said the worker retries three times"
  | 'NEGATED';        // "the worker doesn't retry three times"

export interface SpeechActResult {
  act: SpeechAct;
  clause: string;
  /** True when the clause states what the system currently is. */
  assertive: boolean;
  /** Present on REPORTED: whose statement this appears to be. */
  attributedTo?: string;
  trigger?: string;
}

const QUESTION_OPENERS = /^(do|does|did|is|are|was|were|can|could|should|would|will|have|has|had|am|any|anyone|what|whats|what's|how|why|when|which|who|where)\b/i;
const QUESTION_TAGS = /\b(right|correct|no|isn't it|innit|or not)\s*\?$/i;

// Hedges that place the clause in the space of possibility rather than fact.
const HYPOTHESIS = /\b(maybe|perhaps|might|may be|could be|possibly|probably|presumably|i guess|i suspect|i wonder|not sure|unsure|what if|assuming)\b/i;

// "I'm pretty sure" is still a claim about the world, just a flagged one.
const BELIEF_HEDGE = /\b(i think|i believe|i'm pretty sure|im pretty sure|i'm fairly sure|pretty sure|if i recall|iirc|as far as i know|afaik|last i checked|i'm certain|i know for a fact)\b/i;

const PAST_BELIEF = /\b(i thought|i used to think|i assumed|i had assumed|i remembered|i was under the impression|didn't realise|didn't realize|turns out)\b/i;

// `should` and `ought to` are deontic: they say what the world ought to be, not
// what it is. "The events table should have a user agent column" is a request
// with the surface form of an assertion, and reading it as one produces a
// correction to something nobody claimed.
const OPINION = /\b(seems|feels|looks like a|too (low|high|slow|fast|many|few|aggressive|conservative)|should|ought to|better|worse|prefer|the right (call|choice|architecture)|makes more sense|i'd rather|not ideal|overkill)\b/i;

const DIRECTIVE = /\b(let's|lets |we should|we need to|can you|please |go ahead and|set it to|bump (it|the)|change (it|the)|make it|raise the|lower the|let me)\b/i;

const CONDITIONAL = /^(if|unless|suppose|imagine|say)\b/i;

const FUTURE = /\b(will|we're going to|were going to|going to|about to|once we|after we|when we ship|planning to|plan to)\b/i;

const REPORTED = /\b([A-Z][a-z]+)\s+(said|says|told me|mentioned|reckons|claims|thinks|thought)\b/;
const REPORTED_GENERIC = /\b(they|he|she|someone|the team|ops|sre|support)\s+(said|says|told me|mentioned|reckons|claims)\b/i;

const NEGATION = /\b(doesn't|does not|don't|do not|didn't|did not|isn't|is not|aren't|are not|wasn't|was not|never|no longer|not)\b/i;

/**
 * Split an utterance into clauses that can carry independent modality.
 *
 * Sentence terminators are the primary boundary. The comma markers are the ones
 * that reliably introduce a clause whose modality is independent of the first --
 * contrast ("it's slow, but it retries three times") and consequence ("the
 * worker retries three times, so a slow consumer is not the problem"). Without
 * the consequence markers that second sentence reads as NEGATED and the
 * assertion in front of the comma is lost, which is a real transcript, not a
 * contrived one.
 *
 * ", and " is deliberately absent: it joins clauses of the *same* modality far
 * more often than not, and splitting on it would let a hedge in the first half
 * stop applying to the second.
 */
export function splitClauses(text: string): string[] {
  return text
    .split(
      /(?<=[.!?])\s+|,\s+(?=but\b|although\b|though\b|whereas\b|however\b|so\b|because\b|since\b|which\b|while\b)/i,
    )
    .map((c) => c.trim())
    .filter(Boolean);
}

/** Classify a single clause. */
export function classifyClause(clause: string): SpeechActResult {
  const c = clause.trim();
  const hit = (act: SpeechAct, trigger?: string, extra?: Partial<SpeechActResult>): SpeechActResult => ({
    act,
    clause: c,
    assertive: act === 'ASSERTION' || act === 'BELIEF_HEDGE',
    trigger,
    ...extra,
  });

  if (c.endsWith('?') || QUESTION_TAGS.test(c)) return hit('QUESTION', '?');
  if (QUESTION_OPENERS.test(c) && !/^(what|how|why)\s+(a|the)\b/i.test(c)) {
    // A leading auxiliary with no question mark is still almost always a
    // question in transcribed speech; punctuation from ASR is unreliable.
    return hit('QUESTION', c.split(/\s+/)[0]);
  }

  const past = PAST_BELIEF.exec(c);
  if (past) return hit('PAST_BELIEF', past[0]);

  const reported = REPORTED.exec(c) ?? REPORTED_GENERIC.exec(c);
  if (reported) return hit('REPORTED', reported[0], { attributedTo: reported[1] });

  if (CONDITIONAL.test(c)) return hit('CONDITIONAL', c.split(/\s+/)[0]);

  const directive = DIRECTIVE.exec(c);
  if (directive) return hit('DIRECTIVE', directive[0].trim());

  const hypothesis = HYPOTHESIS.exec(c);
  if (hypothesis) return hit('HYPOTHESIS', hypothesis[0]);

  const opinion = OPINION.exec(c);
  if (opinion) return hit('OPINION', opinion[0]);

  const future = FUTURE.exec(c);
  if (future) return hit('FUTURE', future[0]);

  const belief = BELIEF_HEDGE.exec(c);
  if (belief) return hit('BELIEF_HEDGE', belief[0]);

  const negation = NEGATION.exec(c);
  if (negation) return hit('NEGATED', negation[0]);

  return hit('ASSERTION');
}

/**
 * Classify the clause that actually carries the claim.
 *
 * `carrier` is a literal the caller believes the claim hangs on -- typically the
 * spoken value. Modality is a property of the clause containing that literal,
 * not of the whole breath the speaker took.
 */
export function classifyCarrier(text: string, carrier?: string): SpeechActResult {
  const clauses = splitClauses(text);
  if (clauses.length === 0) return classifyClause(text);
  if (carrier) {
    const needle = carrier.toLowerCase();
    const owning = clauses.find((cl) => cl.toLowerCase().includes(needle));
    if (owning) return classifyClause(owning);
  }
  // No carrier given: an utterance is assertive only if every clause is.
  const results = clauses.map(classifyClause);
  const nonAssertive = results.find((r) => !r.assertive);
  return nonAssertive ?? results[0]!;
}
