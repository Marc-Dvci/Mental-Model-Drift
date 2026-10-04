/**
 * Registry resolution. The alias-overlap tests are the important ones: three of
 * the demo systems answer to a name containing the word "checkout", and getting
 * the span-claiming wrong silently misattributes claims to the wrong system --
 * which then verifies against the wrong source and produces a confident, wrong
 * card.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Registry } from '#engine/registry';
import { validateRegistry } from '#spec';
import { demoRegistry } from '../helpers.ts';

let registry: Registry;
beforeAll(() => {
  registry = demoRegistry();
});

describe('Registry.findSubjects', () => {
  it('prefers the longest alias and claims its span', () => {
    expect(registry.findSubjects('the checkout service is still running 4.12')).toEqual([
      { systemKey: 'checkout-service', alias: 'checkout service' },
    ]);
    expect(registry.findSubjects('and the new checkout is still disabled in Europe')).toEqual([
      { systemKey: 'new-checkout', alias: 'new checkout' },
    ]);
  });

  it('returns every distinct system named, so the caller can refuse ambiguity', () => {
    const hits = registry.findSubjects('the checkout worker and the events table both changed');
    expect(hits.map((h) => h.systemKey).sort()).toEqual(['checkout-worker', 'events']);
  });

  it('finds nothing in a sentence that names nothing', () => {
    expect(registry.findSubjects('the deploy went out this morning')).toEqual([]);
  });
});

describe('Registry.findProperties', () => {
  it('matches on declared lexemes, longest first', () => {
    const props = registry.findProperties('checkout-worker', 'it retries three times before the dead letter queue');
    expect(props.map((p) => p.propertyKey)).toContain('retry.max_attempts');
    expect(props.map((p) => p.propertyKey)).toContain('dlq.enabled');
    expect(props[0]!.lexeme.length).toBeGreaterThanOrEqual(props.at(-1)!.lexeme.length);
  });

  it('returns nothing for a system the words do not describe', () => {
    expect(registry.findProperties('checkout-worker', 'the deploy went out this morning')).toEqual([]);
  });
});

describe('Registry.resolve', () => {
  it('resolves through any alias', () => {
    for (const alias of ['checkout-worker', 'checkout worker', 'payment worker', 'the worker']) {
      expect(registry.resolve(alias, 'retry.max_attempts')?.systemKey).toBe('checkout-worker');
    }
  });

  it('returns undefined for a property outside the registry', () => {
    expect(registry.resolve('checkout-worker', 'retry.backoff_seconds')).toBeUndefined();
    expect(registry.resolve('kafka', 'partitions')).toBeUndefined();
  });
});

describe('validateRegistry', () => {
  it('accepts the shipped demo registry', () => {
    expect(() => validateRegistry(registry.raw)).not.toThrow();
  });

  it('rejects a property with no authoritative source', () => {
    expect(() =>
      validateRegistry({
        version: 1,
        systems: {
          s: { aliases: ['s'], properties: { p: { type: 'integer', impact: 'HIGH', claimType: 'CONFIG_VALUE', lexemes: ['p'] } } },
        },
      }),
    ).toThrow();
  });

  it('rejects an unknown value type', () => {
    expect(() =>
      validateRegistry({
        version: 1,
        systems: {
          s: {
            aliases: ['s'],
            properties: {
              p: {
                type: 'timestamp',
                impact: 'HIGH',
                claimType: 'CONFIG_VALUE',
                lexemes: ['p'],
                authoritative_source: { adapter: 'github', authoritative: true, locator: {} },
              },
            },
          },
        },
      }),
    ).toThrow();
  });
});

describe('promptCatalogue', () => {
  it('sends the model property names and vocabulary, never a source or a secret', () => {
    const catalogue = registry.promptCatalogue();
    const serialised = JSON.stringify(catalogue);
    expect(serialised).not.toMatch(/appconfig|sentry|locator|repository/i);
    expect(catalogue.find((c) => c.subject === 'checkout-worker')?.properties.map((p) => p.property)).toContain(
      'retry.max_attempts',
    );
  });
});
