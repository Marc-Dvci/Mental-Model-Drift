/**
 * Grounding is the gate that makes the product safe to point at a microphone.
 *
 * The failure it exists to prevent is a proposer -- model or rule -- quietly
 * inventing a number, and the system then telling a person their understanding
 * of production is wrong about something they never said. Every rejection case
 * below is that failure, caught.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { findValueLiteral, ground } from '#engine/grounding';
import type { Registry } from '#engine/registry';
import { demoRegistry, property } from '../helpers.ts';

let registry: Registry;
beforeAll(() => {
  registry = demoRegistry();
});

function groundRetry(text: string, assertedValue: unknown, windowText?: string) {
  return ground({
    text,
    ...(windowText ? { windowText } : {}),
    subject: 'checkout-worker',
    subjectAliases: registry.system('checkout-worker')!.aliases,
    propertyKey: 'retry.max_attempts',
    property: property(registry, 'checkout-worker', 'retry.max_attempts'),
    assertedValue,
  });
}

describe('ground', () => {
  it('passes when subject, property lexeme and value literal were all spoken', () => {
    const g = groundRetry('The checkout worker retries three times.', 3);
    expect(g.passed).toBe(true);
    expect(g.subjectAliasMatched).toBe('checkout worker');
    expect(g.propertyLexemeMatched).toBe('retries');
    expect(g.valueLiteralMatched).toBe('three');
  });

  it('rejects a value that was never spoken', () => {
    // The whole point: a proposal of 3 over "retries a few times" grounds nothing.
    const g = groundRetry('The checkout worker retries a few times.', 3);
    expect(g.passed).toBe(false);
    expect(g.rejectedBy).toMatch(/does not appear literally/);
  });

  it('rejects when no property lexeme is present', () => {
    const g = groundRetry('The checkout worker handles three orders a second.', 3);
    expect(g.passed).toBe(false);
    expect(g.rejectedBy).toMatch(/no lexeme/);
  });

  it('rejects when the subject is absent from the utterance and its window', () => {
    const g = groundRetry('It retries three times.', 3);
    expect(g.passed).toBe(false);
    expect(g.rejectedBy).toMatch(/no registry alias/);
  });

  it('carries the subject from the window, but only behind a pronoun', () => {
    const carried = groundRetry('It retries three times.', 3, 'The checkout worker is backing up again.');
    expect(carried.passed).toBe(true);
    expect(carried.subjectCarried).toBe(true);

    const noPronoun = groundRetry('Retries land three times before the DLQ.', 3, 'The checkout worker is backing up again.');
    expect(noPronoun.passed).toBe(false);
  });

  it('scores a carried subject lower than a named one', () => {
    const named = groundRetry('The checkout worker retries three times.', 3);
    const carried = groundRetry('It retries three times.', 3, 'The checkout worker is backing up again.');
    expect(carried.strength).toBeLessThan(named.strength);
  });

  it('rejects every non-assertive speech act', () => {
    for (const text of [
      'Does the checkout worker retry three times?',
      'Three retries for the checkout worker seems too low.',
      'Maybe the checkout worker retries three times.',
      'I thought the checkout worker retried three times.',
      "Let's set the checkout worker to three retries.",
    ]) {
      const g = groundRetry(text, 3);
      expect(g.passed, text).toBe(false);
      expect(g.rejectedBy, text).toMatch(/not an assertion/);
    }
  });

  it('reports the speech act even on rejection, so the UI can explain itself', () => {
    const g = groundRetry('Does the checkout worker retry three times?', 3);
    expect(g.speechAct.act).toBe('QUESTION');
  });
});

describe('ground: scoped properties', () => {
  function groundFlag(text: string, value: unknown, scope?: Record<string, string>) {
    return ground({
      text,
      subject: 'new-checkout',
      subjectAliases: registry.system('new-checkout')!.aliases,
      propertyKey: 'enabled',
      property: property(registry, 'new-checkout', 'enabled'),
      assertedValue: value,
      ...(scope ? { scope } : {}),
    });
  }

  it('resolves a scope from the words spoken', () => {
    const g = groundFlag('The new checkout is still disabled in Europe.', false);
    expect(g.passed).toBe(true);
    expect(g.resolvedScope).toEqual({ region: 'EU' });
  });

  it('refuses a claim whose scope was never spoken', () => {
    const g = groundFlag('The new checkout is still disabled.', false);
    expect(g.passed).toBe(false);
    expect(g.rejectedBy).toMatch(/requires a region/);
  });

  it('refuses a proposal whose scope contradicts the words', () => {
    const g = groundFlag('The new checkout is still disabled in Europe.', false, { region: 'US' });
    expect(g.passed).toBe(false);
    expect(g.rejectedBy).toMatch(/proposed as US but the utterance says EU/);
  });

  it('refuses an ambiguous scope rather than picking one', () => {
    const g = groundFlag('The new checkout is disabled in Europe and the US.', false);
    expect(g.passed).toBe(false);
    expect(g.rejectedBy).toMatch(/ambiguous/);
  });
});

describe('findValueLiteral', () => {
  it('matches digits and number words', () => {
    expect(findValueLiteral('it retries 3 times', 'integer', 3)?.literal).toBe('3');
    expect(findValueLiteral('it retries three times', 'integer', 3)?.literal).toBe('three');
    expect(findValueLiteral('it retries twice', 'integer', 2)?.literal).toBe('twice');
  });

  it('does not match a digit embedded in a version or identifier', () => {
    expect(findValueLiteral('we are on 4.12 in production', 'integer', 4)).toBeNull();
  });

  it('grounds a boolean through local negation', () => {
    const g = findValueLiteral("the flag isn't enabled in Europe", 'boolean', false);
    expect(g?.negated).toBe(true);
    expect(g?.value).toBe(false);
  });

  it('accepts 4.12 as grounding for a claim about 4.12.0 and back', () => {
    expect(findValueLiteral('still running 4.12 in production', 'semver', '4.12.0')?.literal).toBe('4.12');
    expect(findValueLiteral('still running 4.12.0 in production', 'semver', '4.12')?.literal).toBe('4.12.0');
  });

  it('does not accept a different release', () => {
    expect(findValueLiteral('still running 4.13 in production', 'semver', '4.12')).toBeNull();
  });

  it('requires the object to be named for a presence claim', () => {
    const props = { source_ip: ['source ip'] };
    expect(findValueLiteral('the events table stores the source IP', 'presence', true, { object: 'source_ip', objectAliases: props })?.value).toBe(true);
    expect(findValueLiteral('the events table stores the user agent', 'presence', true, { object: 'source_ip', objectAliases: props })).toBeNull();
  });
});
