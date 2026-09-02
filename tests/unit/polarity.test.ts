/**
 * The spoken vocabulary of on and off.
 *
 * Every case here was a real disagreement between the engine and the golden
 * corpus before it was fixed. The preposition cases are the dangerous ones:
 * reading "the DLQ *on* the checkout worker is inactive" as `enabled = true`
 * does not merely miss the claim, it inverts it and then reports drift against
 * the inversion.
 */
import { describe, expect, it } from 'vitest';
import { NUMBER_RE, SEMVER_RE, findPolarityWords, negatedAfter, negatedBefore, wearsAUnit } from '#engine/polarity';

describe('findPolarityWords', () => {
  it('reads unambiguous state words wherever they appear', () => {
    expect(findPolarityWords('the new checkout is enabled in europe')[0]).toMatchObject({ value: true, literal: 'enabled' });
    expect(findPolarityWords('the dlq is inactive')[0]).toMatchObject({ value: false, literal: 'inactive' });
    expect(findPolarityWords('new checkout is rolled out in emea')[0]).toMatchObject({ value: true });
  });

  it('reads bare on and off only in a copular frame', () => {
    expect(findPolarityWords('the dlq is off in production')).toEqual([expect.objectContaining({ value: false, literal: 'off' })]);
    expect(findPolarityWords('new checkout is still off in asia')).toEqual([expect.objectContaining({ value: false })]);
    expect(findPolarityWords('the flag is back on')).toEqual([expect.objectContaining({ value: true })]);
  });

  it('ignores on and off used as prepositions and particles', () => {
    expect(findPolarityWords('the dlq on the checkout worker')).toEqual([]);
    expect(findPolarityWords('checkout backs off five seconds between attempts')).toEqual([]);
  });

  it('ignores on and off inside a fixed phrase, where they take a complement', () => {
    expect(findPolarityWords('we are on call this week')).toEqual([]);
    expect(findPolarityWords('the new checkout is on the roadmap')).toEqual([]);
    expect(findPolarityWords('that is off the table for now')).toEqual([]);
  });

  it('does not find `active` inside `inactive`', () => {
    const hits = findPolarityWords('the dlq on the checkout worker is inactive');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ value: false });
  });
});

describe('negation', () => {
  it('sees a negator immediately before the word', () => {
    const text = 'the new checkout is not enabled in europe';
    expect(negatedBefore(text, text.indexOf('enabled'))).toBe(true);
  });

  it('does not let a negator reach across a clause', () => {
    const text = "we don't know whether the new checkout is enabled in europe";
    expect(negatedBefore(text, text.indexOf('enabled'))).toBe(false);
  });

  it('sees the negative that English puts after the verb', () => {
    // "has no user agent column" -- the construction people actually use to say
    // a column is absent. Looking only backwards reads it as the opposite.
    const text = 'the events table has no user agent column';
    expect(negatedAfter(text, text.indexOf('has') + 3)).toBe(true);
    expect(negatedAfter('the events table has a user agent column', 'the events table has'.length)).toBe(false);
  });
});

describe('units', () => {
  it('recognises a number that is measuring something', () => {
    const text = 'checkout backs off five seconds between attempts';
    expect(wearsAUnit(text, text.indexOf('five') + 4)).toBe(true);
    expect(wearsAUnit('it retries five times', 'it retries five'.length)).toBe(false);
  });
});

describe('value patterns', () => {
  it('reads a number at the end of a sentence', () => {
    // The obvious `(?![\\w.])` guard silently loses every value spoken at the
    // end of a sentence, which in a transcript is where values usually are.
    expect([...'max attempts is 5.'.matchAll(NUMBER_RE)].map((m) => m[1])).toEqual(['5']);
    expect([...'the release is 4.13.'.matchAll(SEMVER_RE)].map((m) => m[1])).toEqual(['4.13']);
  });

  it('still refuses to split a version into integers', () => {
    expect([...'we are on 4.12 in production'.matchAll(NUMBER_RE)].map((m) => m[1])).toEqual(['4.12']);
  });

  it('reads versions with and without a patch segment, and with a leading v', () => {
    expect([...'running v4.13.0 now'.matchAll(SEMVER_RE)].map((m) => m[1])).toEqual(['4.13.0']);
    expect([...'running 4.13 now'.matchAll(SEMVER_RE)].map((m) => m[1])).toEqual(['4.13']);
  });
});
