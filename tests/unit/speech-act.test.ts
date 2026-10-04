/**
 * Speech-act classification is the first of the two gates that decide whether a
 * sentence is even eligible to be checked. Every case here is a sentence that
 * contains a subject, a property and a number -- the tests are about modality
 * alone, because that is the only thing separating a claim from the four things
 * that look exactly like one.
 */
import { describe, expect, it } from 'vitest';
import { classifyCarrier, classifyClause, splitClauses } from '#engine/speech-act';

describe('classifyClause', () => {
  const cases: [string, string][] = [
    ['The worker retries three times.', 'ASSERTION'],
    ['Checkout retries failed jobs three times anyway.', 'ASSERTION'],
    ['I think the worker retries three times.', 'BELIEF_HEDGE'],
    ['Pretty sure the worker retries three times.', 'BELIEF_HEDGE'],
    ['Does the worker retry three times?', 'QUESTION'],
    ['Does the worker retry three times', 'QUESTION'],
    ['The worker retries three times, right?', 'QUESTION'],
    ['Maybe the worker retries three times.', 'HYPOTHESIS'],
    ['It probably retries three times.', 'HYPOTHESIS'],
    ['Three retries seems too low.', 'OPINION'],
    ['Two retries is too aggressive.', 'OPINION'],
    ["Let's set the worker to three retries.", 'DIRECTIVE'],
    ['We should bump the retries to three.', 'DIRECTIVE'],
    ['If the worker retried three times we would be fine.', 'CONDITIONAL'],
    ['The worker will retry three times after the change.', 'FUTURE'],
    ['I thought the worker retried three times.', 'PAST_BELIEF'],
    ['I assumed the DLQ was turned off.', 'PAST_BELIEF'],
    ['Sam said the worker retries three times.', 'REPORTED'],
    ['They said the worker retries three times.', 'REPORTED'],
    ['The worker does not retry three times.', 'NEGATED'],
  ];

  for (const [text, expected] of cases) {
    it(`${expected}: ${text}`, () => {
      expect(classifyClause(text).act).toBe(expected);
    });
  }

  it('marks only ASSERTION and BELIEF_HEDGE as assertive', () => {
    expect(classifyClause('The worker retries three times.').assertive).toBe(true);
    expect(classifyClause('I think the worker retries three times.').assertive).toBe(true);
    expect(classifyClause('Does the worker retry three times?').assertive).toBe(false);
    expect(classifyClause('Three retries seems too low.').assertive).toBe(false);
  });

  it('names who a reported statement was attributed to', () => {
    expect(classifyClause('Priya said the worker retries three times.').attributedTo).toBe('Priya');
  });
});

describe('splitClauses', () => {
  it('splits on sentence terminators', () => {
    expect(splitClauses("It's probably fine. Checkout retries failed jobs three times anyway.")).toEqual([
      "It's probably fine.",
      'Checkout retries failed jobs three times anyway.',
    ]);
  });

  it('splits on contrast and consequence markers', () => {
    expect(splitClauses('The queue is slow, but the worker retries three times.')).toHaveLength(2);
    expect(splitClauses('The checkout worker retries three times, so a slow consumer is not the problem.')).toHaveLength(2);
    expect(splitClauses('The worker retries three times, because that was the incident fix.')).toHaveLength(2);
  });

  it('does not split on ", and", which joins clauses of the same modality', () => {
    // Splitting here would let the hedge stop applying to the second half.
    expect(splitClauses('Maybe the worker retries three times, and the DLQ is off.')).toHaveLength(1);
  });
});

describe('classifyCarrier', () => {
  it('classifies the clause containing the value, not the whole utterance', () => {
    // The flagship case: a hedge followed by a flat assertion. Scoring the
    // utterance as hedged would discard the best example the product has.
    const r = classifyCarrier("It's probably fine. Checkout retries failed jobs three times anyway.", 'three');
    expect(r.act).toBe('ASSERTION');
    expect(r.clause).toBe('Checkout retries failed jobs three times anyway.');
  });

  it('recovers the assertion in front of a consequence comma', () => {
    const r = classifyCarrier('Told them the checkout worker retries three times, so a slow consumer is not the problem.', 'three');
    expect(r.assertive).toBe(true);
  });

  it('without a carrier, an utterance is assertive only if every clause is', () => {
    expect(classifyCarrier("It's probably fine. Checkout retries three times.").assertive).toBe(false);
  });

  it('falls back to whole-utterance classification when the carrier is absent', () => {
    expect(classifyCarrier('Does the worker retry three times?', 'nine').act).toBe('QUESTION');
  });
});
