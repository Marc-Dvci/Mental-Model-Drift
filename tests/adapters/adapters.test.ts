/**
 * Verification adapters, and specifically how they fail.
 *
 * Every adapter has one job on the happy path and one much more important job
 * off it: return evidence that is honestly labelled UNAVAILABLE / NOT_FOUND /
 * FORBIDDEN, so that the comparator upstream cannot turn a broken connector
 * into a claim that a person's understanding is stale.
 *
 * The matrix here is the one the design calls for: missing API, permission
 * denied, malformed document, property absent, source timeout, conflicting
 * sources.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppConfigVerifier } from '#engine/adapters/appconfig';
import { GitHubVerifier, extractValue } from '#engine/adapters/github';
import { SentryVerifier } from '#engine/adapters/sentry';
import { bindLocator, makeEvidence, readPath, stableStringify } from '#engine/adapters/common';
import { adjudicate, adjudicateAll } from '#spec';
import type { SourceRef } from '#spec';
import { claim, REPO_ROOT } from '../helpers.ts';

const appconfigSource: SourceRef = {
  adapter: 'aws_appconfig',
  authoritative: true,
  locator: { application: 'ecommerce', environment: 'production', profile: 'checkout-worker', json_path: '$.retry.max_attempts' },
};

const sentrySource: SourceRef = {
  adapter: 'sentry',
  authoritative: true,
  locator: { organization: 'drift-demo', project: 'checkout', environment: 'production' },
};

const retryClaim = claim({ subject: 'checkout-worker', property: 'retry.max_attempts', assertedValue: 3, valueType: 'integer' });
const versionClaim = claim({
  subject: 'checkout-service',
  property: 'deployed_version',
  assertedValue: '4.12',
  valueType: 'semver',
  claimType: 'DEPLOYMENT_VERSION',
});

const fixtures = { appconfig: join(REPO_ROOT, 'demo', 'appconfig'), sentry: join(REPO_ROOT, 'demo', 'sentry') };

describe('AppConfigVerifier (local mirror)', () => {
  const verifier = new AppConfigVerifier({ mode: 'local', fixtureRoot: fixtures.appconfig });

  it('reads the deployed value and records where it read it from', async () => {
    const e = await verifier.verify(retryClaim, appconfigSource);
    expect(e).toMatchObject({ status: 'OK', value: 1, source: 'AWS_APPCONFIG', authoritative: true });
    expect(e.sourceLocator).toMatch(/appconfig:\/\/ecommerce\/production\/checkout-worker/);
  });

  it('produces DRIFTED only through the comparator, never by itself', async () => {
    const e = await verifier.verify(retryClaim, appconfigSource);
    expect(adjudicate(retryClaim, e).verdict).toBe('DRIFTED');
  });

  it('reports NOT_FOUND for a json_path the document does not have', async () => {
    const e = await verifier.verify(retryClaim, {
      ...appconfigSource,
      locator: { ...appconfigSource.locator, json_path: '$.retry.jitter_ms' },
    });
    expect(e.status).toBe('NOT_FOUND');
    expect(adjudicate(retryClaim, e).verdict).toBe('INCONCLUSIVE');
  });

  it('reports UNAVAILABLE when the source cannot be reached at all', async () => {
    const missing = new AppConfigVerifier({ mode: 'local', fixtureRoot: join(tmpdir(), 'mmd-no-such-mirror') });
    const e = await missing.verify(retryClaim, appconfigSource);
    expect(e.status).toBe('UNAVAILABLE');
    expect(adjudicate(retryClaim, e).verdict).toBe('INCONCLUSIVE');
  });

  it('reconstructs when the value changed, from the hosted version history', async () => {
    const changes = await verifier.history(retryClaim, appconfigSource);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: 3, to: 1, at: '2026-08-23T09:41:00.000Z' });
    expect(changes[0]!.message).toMatch(/INC-2291/);
  });
});

describe('AppConfigVerifier (malformed and unreadable documents)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mmd-appconfig-'));
    mkdirSync(join(dir, 'ecommerce', 'production'), { recursive: true });
    writeFileSync(join(dir, 'ecommerce', 'production', 'checkout-worker.json'), '{ "retry": { "max_attempts": ');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reports UNAVAILABLE on a malformed document rather than guessing at it', async () => {
    const e = await new AppConfigVerifier({ mode: 'local', fixtureRoot: dir }).verify(retryClaim, appconfigSource);
    expect(e.status).toBe('UNAVAILABLE');
    expect(e.error).toBeTruthy();
    expect(adjudicate(retryClaim, e).verdict).toBe('INCONCLUSIVE');
  });
});

describe('SentryVerifier', () => {
  const verifier = new SentryVerifier({ mode: 'local', fixtureRoot: fixtures.sentry });

  it('reports the release most recently deployed to the named environment', async () => {
    const e = await verifier.verify(versionClaim, sentrySource);
    expect(e).toMatchObject({ status: 'OK', value: '4.13.0' });
  });

  it('ignores a release deployed only to another environment', async () => {
    // 4.13.0-rc1 went to staging on the 28th. Production is a different claim.
    const e = await verifier.verify(versionClaim, sentrySource);
    expect(e.value).not.toBe('4.13.0-rc1');
  });

  it('reports NOT_FOUND for an environment nothing has been deployed to', async () => {
    const e = await verifier.verify(versionClaim, { ...sentrySource, locator: { ...sentrySource.locator, environment: 'canary' } });
    expect(e.status).toBe('NOT_FOUND');
    expect(adjudicate(versionClaim, e).verdict).toBe('INCONCLUSIVE');
  });

  it('reports UNAVAILABLE for a project it cannot read', async () => {
    const e = await verifier.verify(versionClaim, { ...sentrySource, locator: { ...sentrySource.locator, project: 'nonexistent' } });
    expect(e.status).toBe('UNAVAILABLE');
  });

  it('gives the deployment series as history, newest first', async () => {
    const changes = await verifier.history(versionClaim, sentrySource);
    expect(changes[0]).toMatchObject({ from: '4.12.0', to: '4.13.0' });
    expect(changes.at(-1)).toMatchObject({ from: '4.11.0', to: '4.12.0' });
  });

  it('reports UNAVAILABLE, not drift, when live mode has no credential', async () => {
    const live = new SentryVerifier({ mode: 'live' });
    const e = await live.verify(versionClaim, sentrySource);
    expect(e.status).toBe('UNAVAILABLE');
    expect(e.error).toMatch(/SENTRY_AUTH_TOKEN/);
    expect(adjudicate(versionClaim, e).verdict).toBe('INCONCLUSIVE');
  });
});

describe('GitHubVerifier (HTTP failures)', () => {
  const schemaClaim = claim({
    subject: 'events',
    property: 'column_exists',
    assertedValue: true,
    valueType: 'presence',
    claimType: 'SCHEMA_FACT',
    object: 'source_ip',
  });
  const source: SourceRef = {
    adapter: 'github',
    authoritative: true,
    locator: { repository: 'Marc-Dvci/mmd-checkout-demo', path: 'database/schema.sql', table: 'events' },
  };

  /** A local server standing in for api.github.com, so status codes are real. */
  async function withApi(status: number, body: string, fn: (base: string) => Promise<void>): Promise<void> {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      await fn(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  it('maps 403 to FORBIDDEN, so a permissions problem reads as one', async () => {
    await withApi(403, '{"message":"Resource not accessible by integration"}', async (apiBase) => {
      const e = await new GitHubVerifier({ mode: 'api', apiBase, token: 'test' }).verify(schemaClaim, source);
      expect(e.status).toBe('FORBIDDEN');
      expect(adjudicate(schemaClaim, e).verdict).toBe('INCONCLUSIVE');
    });
  });

  it('maps 404 and 500 to UNAVAILABLE', async () => {
    for (const status of [404, 500]) {
      await withApi(status, '{"message":"nope"}', async (apiBase) => {
        const e = await new GitHubVerifier({ mode: 'api', apiBase, token: 'test' }).verify(schemaClaim, source);
        expect(e.status, String(status)).toBe('UNAVAILABLE');
      });
    }
  });

  it('reports UNAVAILABLE when the endpoint cannot be reached at all', async () => {
    // Port 1 on loopback: a connection refusal, which is what a source outage
    // looks like from inside the process.
    const e = await new GitHubVerifier({ mode: 'api', apiBase: 'http://127.0.0.1:1', token: 'test' }).verify(schemaClaim, source);
    expect(e.status).toBe('UNAVAILABLE');
    expect(adjudicate(schemaClaim, e).verdict).toBe('INCONCLUSIVE');
  });

  it('reports UNAVAILABLE when localgit has no clone to read', async () => {
    const e = await new GitHubVerifier({ mode: 'localgit', repoRoot: join(tmpdir(), 'mmd-no-such-clone') }).verify(schemaClaim, source);
    expect(e.status).toBe('UNAVAILABLE');
  });
});

describe('extractValue (SQL and structured documents)', () => {
  const schema = `
    -- events
    CREATE TABLE events (
      id BIGSERIAL PRIMARY KEY,
      source_ip INET,
      payload JSONB NOT NULL,
      CONSTRAINT events_payload_check CHECK (payload IS NOT NULL)
    );

    CREATE TABLE audit_log (
      id BIGSERIAL PRIMARY KEY,
      user_agent TEXT
    );
  `;

  it('finds a column that exists on the named table', () => {
    expect(extractValue({ repository: 'r', path: 'schema.sql', table: 'events', column: 'source_ip' }, schema)).toEqual({
      found: true,
      value: true,
    });
  });

  it('does not find a column that exists only on another table', () => {
    // A substring search would happily report user_agent on `events`.
    expect(extractValue({ repository: 'r', path: 'schema.sql', table: 'events', column: 'user_agent' }, schema)).toEqual({
      found: true,
      value: false,
    });
  });

  it('does not mistake a constraint name for a column', () => {
    expect(extractValue({ repository: 'r', path: 'schema.sql', table: 'events', column: 'events_payload_check' }, schema)).toEqual({
      found: true,
      value: false,
    });
  });

  it('says so when the table is absent, rather than reporting the column missing', () => {
    const r = extractValue({ repository: 'r', path: 'schema.sql', table: 'orders', column: 'source_ip' }, schema);
    expect(r.found).toBe(false);
    expect(r.reason).toMatch(/no CREATE TABLE orders/);
  });

  it('reports a parse failure rather than an absent value', () => {
    const r = extractValue({ repository: 'r', path: 'config/checkout.yaml', json_path: '$.retry.max_attempts' }, '{{{ not yaml');
    expect(r.found).toBe(false);
    expect(r.reason).toMatch(/could not parse/);
  });

  it('reads yaml and json through the same locator grammar', () => {
    expect(extractValue({ repository: 'r', path: 'c.yaml', json_path: '$.retry.max_attempts' }, 'retry:\n  max_attempts: 1\n')).toEqual({
      found: true,
      value: 1,
    });
    expect(extractValue({ repository: 'r', path: 'c.json', json_path: '$.retry.max_attempts' }, '{"retry":{"max_attempts":1}}')).toEqual({
      found: true,
      value: 1,
    });
  });
});

describe('readPath', () => {
  const doc = { retry: { max_attempts: 1 }, regions: [{ name: 'EU', on: true }], 'a b': 2 };

  it('reads nested keys, array indices and quoted keys', () => {
    expect(readPath(doc, '$.retry.max_attempts')).toEqual({ found: true, value: 1 });
    expect(readPath(doc, '$.regions[0].on')).toEqual({ found: true, value: true });
    expect(readPath(doc, '$["a b"]')).toEqual({ found: true, value: 2 });
  });

  it('distinguishes an absent key from a false value', () => {
    expect(readPath(doc, '$.retry.jitter')).toEqual({ found: false, value: undefined });
    expect(readPath({ dlq: { enabled: false } }, '$.dlq.enabled')).toEqual({ found: true, value: false });
  });

  it('refuses an out-of-range index instead of returning undefined as a value', () => {
    expect(readPath(doc, '$.regions[7].on').found).toBe(false);
  });
});

describe('evidence integrity', () => {
  it('hashes evidence independently of property order', () => {
    expect(stableStringify({ a: 1, b: { c: 2, d: 3 } })).toBe(stableStringify({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('gives two readings of the same value the same hash and different ids', async () => {
    const verifier = new AppConfigVerifier({ mode: 'local', fixtureRoot: fixtures.appconfig });
    const a = await verifier.verify(retryClaim, appconfigSource);
    await new Promise((r) => setTimeout(r, 5));
    const b = await verifier.verify(retryClaim, appconfigSource);
    expect(a.fetchedAt).not.toBe(b.fetchedAt);
    expect(a.id).not.toBe(b.id);
    expect(a.evidenceHash).toBe(b.evidenceHash);
  });

  it('changes the hash when the value read changes', () => {
    const base = {
      claimId: 'c1',
      source: 'AWS_APPCONFIG',
      sourceLocator: 'appconfig://ecommerce/production/checkout-worker$.retry.max_attempts',
      status: 'OK' as const,
      authoritative: true,
    };
    const at = '2026-09-01T09:02:00.000Z';
    const one = makeEvidence({ ...base, value: 1, fetchedAt: at });
    const three = makeEvidence({ ...base, value: 3, fetchedAt: at });
    expect(one.evidenceHash).not.toBe(three.evidenceHash);
  });
});

describe('conflicting sources', () => {
  it('is inconclusive when two authoritative adapters disagree about one property', async () => {
    const appconfig = await new AppConfigVerifier({ mode: 'local', fixtureRoot: fixtures.appconfig }).verify(retryClaim, appconfigSource);
    const impostor = { ...appconfig, id: 'ev-2', source: 'GITHUB', value: 2 };
    const a = adjudicateAll(retryClaim, [appconfig, impostor]);
    expect(a.verdict).toBe('INCONCLUSIVE');
    expect(a.reason).toMatch(/disagree/);
  });
});


describe('scoped locators', () => {
  const flagSource: SourceRef = {
    adapter: 'aws_appconfig',
    authoritative: true,
    locator: {
      application: 'ecommerce',
      environment: 'production',
      profile: 'feature-flags',
      json_path: '$.new_checkout.regions.${scope.region}',
    },
  };
  const verifier = new AppConfigVerifier({ mode: 'local', fixtureRoot: fixtures.appconfig });

  function flagClaim(region: string, assertedValue: boolean) {
    return claim({
      subject: 'new-checkout',
      property: 'enabled',
      assertedValue,
      valueType: 'boolean',
      claimType: 'FEATURE_STATE',
      scope: { region },
    });
  }

  it('reads the region the wearer actually named', async () => {
    expect((await verifier.verify(flagClaim('EU', false), flagSource)).value).toBe(true);
    expect((await verifier.verify(flagClaim('US', false), flagSource)).value).toBe(false);
  });

  it('so a true statement about the US is not drift against the EU value', async () => {
    const us = flagClaim('US', false);
    expect(adjudicate(us, await verifier.verify(us, flagSource)).verdict).toBe('SUPPORTED');
    const eu = flagClaim('EU', false);
    expect(adjudicate(eu, await verifier.verify(eu, flagSource)).verdict).toBe('DRIFTED');
  });

  it('refuses to read anything when the scope slot cannot be filled', async () => {
    const unscoped = claim({ subject: 'new-checkout', property: 'enabled', assertedValue: false, valueType: 'boolean' });
    const e = await verifier.verify(unscoped, flagSource);
    expect(e.status).toBe('AMBIGUOUS');
    expect(adjudicate(unscoped, e).verdict).toBe('INCONCLUSIVE');
  });

  it('binds the region into history as well as into the current reading', async () => {
    const changes = await verifier.history(flagClaim('EU', false), flagSource);
    expect(changes).toEqual([expect.objectContaining({ from: false, to: true, at: '2026-08-27T07:31:00.000Z' })]);
    expect(await verifier.history(flagClaim('US', false), flagSource)).toEqual([]);
  });

  it('substitutes only declared slots and leaves the rest of the locator alone', () => {
    expect(bindLocator({ a: '$.x.${scope.region}', b: 'plain', c: { d: '${object}' } }, { scope: { region: 'EU' }, object: 'source_ip' })).toEqual({
      a: '$.x.EU',
      b: 'plain',
      c: { d: 'source_ip' },
    });
  });
});
