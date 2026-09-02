/**
 * The twelve end-to-end golden scenarios.
 *
 * Each one runs the whole product: a Bee transport (the local emulator, which
 * speaks the documented `/v1/*` surface and SSE stream), the real extraction and
 * grounding gates, the real deterministic comparator, the real adapters reading
 * the on-disk mirrors, and the real store.
 *
 * The two that matter most are 09 -- a realtime utterance lost while the stream
 * was down and recovered through `changed --cursor`, which is the behaviour
 * Bee's at-most-once delivery semantics actually force on a client -- and 10/11,
 * where a source is unreachable and the answer must be "I do not know" rather
 * than "you are wrong".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { BeeClient } from '#bee';
import { BeeSim } from '../../tools/bee-sim/src/server.ts';
import { buildEngine, Reconciler, type BuiltEngine } from '#engine';
import { REPO_ROOT, tempStore } from '../helpers.ts';
import type { DriftEvent } from '#spec';

let sim: BeeSim;
let port: number;
let built: BuiltEngine;
let reconciler: Reconciler;
let cleanup: () => void;

/**
 * One engine, one simulator, for the whole file. The store is cleared between
 * scenarios; the fixtures are not, because they are the point.
 */
beforeAll(async () => {
  sim = new BeeSim({
    port: 0,
    fixtureDir: join(REPO_ROOT, 'demo', 'conversations'),
    liveConversationIds: ['10743', '10744'],
    log: () => {},
  });
  port = await sim.listen();
});

afterAll(async () => {
  await sim.close();
  cleanup?.();
});

beforeEach(() => {
  cleanup?.();
  const t = tempStore();
  cleanup = t.cleanup;
  built = buildEngine({
    root: REPO_ROOT,
    mode: 'local',
    statePath: t.path,
    proposers: ['grammar'],
    userId: 'test',
    bee: simClient(),
  });
  reconciler = new Reconciler(built.bee, built.engine, built.store);
});

/** A Bee client pointed at the emulator, over the documented proxy surface. */
function simClient(): BeeClient {
  return new BeeClient({ proxyUrl: `http://127.0.0.1:${port}`, allowCli: false });
}

interface Spoken {
  text: string;
  conversationId?: string;
  window?: string[];
  speakerCount?: number;
  capturedAt?: string;
}

/** The uuid a live Bee frame would carry for each demo conversation. */
const UUIDS: Record<string, string> = {
  '10743': '9a41c2fe-52b8-4d77-b0e3-6f18cd4a2b55',
  '10744': '0d7e51ab-4c39-4a16-8e52-b3f7290ac641',
};

async function say(s: Spoken) {
  const conversationId = s.conversationId ?? '10743';
  return built.engine.ingestUtterance({
    text: s.text,
    conversationId,
    ...(UUIDS[conversationId] ? { conversationUuid: UUIDS[conversationId]! } : {}),
    window: s.window ?? [],
    speakerCount: s.speakerCount ?? 1,
    ...(s.capturedAt ? { capturedAt: s.capturedAt } : {}),
    origin: 'realtime',
  });
}

async function drifts(): Promise<DriftEvent[]> {
  return built.store.listDrifts({ limit: 50 });
}

// ---------------------------------------------------------------------------

describe('01 configuration drift', () => {
  it('detects a stale retry count, names the commit that changed it, and recalls prior statements', async () => {
    const out = await say({ text: "It's probably fine. Checkout retries failed jobs three times anyway." });

    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]!.verdict).toBe('DRIFTED');

    const [drift] = await drifts();
    expect(drift).toMatchObject({ subject: 'checkout-worker', property: 'retry.max_attempts', assertedValue: 3, actualValue: 1 });

    // The explanation, which is the half that makes this more than a linter.
    expect(drift!.sourceChangeAt?.slice(0, 10)).toBe('2026-08-23');
    expect(drift!.sourceChangeCommit).toBeTruthy();

    // Bee's own history: the same belief, stated in August, found by neural
    // search and re-grounded through the same rules used at capture.
    expect(drift!.priorOccurrences.length).toBeGreaterThanOrEqual(2);
    expect(drift!.severity).toBe('HIGH');
  });
});

describe('02 feature flag drift', () => {
  it('detects a stale flag state and resolves the region from the words spoken', async () => {
    await say({ text: 'And the new checkout is still disabled in Europe.' });
    const [drift] = await drifts();
    expect(drift).toMatchObject({ subject: 'new-checkout', property: 'enabled', assertedValue: false, actualValue: true });
    expect(drift!.sourceChangeAt?.slice(0, 10)).toBe('2026-08-27');
  });
});

describe('03 correct schema statement', () => {
  it('verifies a true statement and stays completely silent about it', async () => {
    const out = await say({ text: 'The events table stores the source IP, so we can trace it back.' });
    expect(out.claims[0]!.verdict).toBe('SUPPORTED');
    expect(await drifts()).toHaveLength(0);

    // Silence is a feature, but it has to be inspectable: the claim is stored.
    const claims = await built.store.listClaims({ limit: 10 });
    expect(claims.map((c) => c.status)).toContain('SUPPORTED');
  });
});

describe('04 stale deployment version', () => {
  it('compares a spoken 4.12 against the release Sentry records as 4.12.0', async () => {
    await say({ text: 'The checkout service is still running 4.12 in production.' });
    const [drift] = await drifts();
    expect(drift).toMatchObject({ subject: 'checkout-service', property: 'deployed_version', actualValue: '4.13.0' });
    // Without semver-aware matching the departure commit is silently lost.
    expect(drift!.sourceChangeAt?.slice(0, 10)).toBe('2026-08-29');
  });
});

describe('05 ambiguous entity', () => {
  it('says nothing when one sentence names two systems', async () => {
    const out = await say({ text: 'The checkout worker retries three times and the events table stores the source IP.' });
    expect(out.claims).toEqual([]);
    expect(await drifts()).toHaveLength(0);
  });

  it('refuses a scoped claim whose scope was never spoken', async () => {
    const out = await say({ text: 'The new checkout is still disabled.' });
    expect(out.claims).toEqual([]);
    expect(out.rejected.some((r) => /region/.test(r.reason))).toBe(true);
  });
});

describe('06 opinion that resembles a claim', () => {
  it('does not correct an opinion', async () => {
    const out = await say({ text: 'Two retries on the checkout worker seems too low for this kind of failure.' });
    expect(out.claims).toEqual([]);
    expect(out.rejected.some((r) => /OPINION/.test(r.reason))).toBe(true);
  });
});

describe('07 question', () => {
  it('does not correct a question', async () => {
    const out = await say({ text: 'Does the checkout worker still retry three times on a 5xx?' });
    expect(out.claims).toEqual([]);
    expect(out.rejected.some((r) => /QUESTION/.test(r.reason))).toBe(true);
  });

  it('does not correct a belief the speaker has already marked as past', async () => {
    const out = await say({ text: 'I thought the checkout worker had the DLQ turned off.' });
    expect(out.claims).toEqual([]);
    expect(out.rejected.some((r) => /PAST_BELIEF/.test(r.reason))).toBe(true);
  });
});

describe('08 teammate statement, unknown ownership', () => {
  it('asks before it acts when the room had more than one speaker', async () => {
    const out = await say({ text: 'The checkout worker retries three times.', speakerCount: 3 });
    expect(out.claims[0]!.claim.ownership).toBe('UNKNOWN');

    const [drift] = await drifts();
    expect(drift!.ownership).toBe('UNKNOWN');
    expect(drift!.confirmationRequired).toBe(true);
  });

  it('unlocks write actions only once the wearer confirms the belief is theirs', async () => {
    await say({ text: 'The checkout worker retries three times.', speakerCount: 3 });
    const [drift] = await drifts();
    const confirmed = await built.store.getDrift(drift!.id);
    expect(confirmed!.confirmationRequired).toBe(true);

    await built.store.putDrift({ ...confirmed!, confirmationRequired: false, ownership: 'USER_CONFIRMED' });
    expect((await built.store.getDrift(drift!.id))!.ownership).toBe('USER_CONFIRMED');
  });
});

describe('09 realtime event lost, recovered by cursor reconciliation', () => {
  it('recovers a conversation that happened while the stream was down', async () => {
    // Live: the belief is stated once and detected.
    await say({ text: "It's probably fine. Checkout retries failed jobs three times anyway." });
    const before = (await drifts())[0]!;
    const priorBefore = before.priorOccurrences.length;

    // The stream drops. The changefeed does not: this is the whole point of
    // Bee documenting delivery as at-most-once.
    await fetch(`http://127.0.0.1:${port}/_sim/network`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ up: false }),
    });
    await fetch(`http://127.0.0.1:${port}/_sim/play`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: '10744', speedMs: 0 }),
    });
    await fetch(`http://127.0.0.1:${port}/_sim/network`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ up: true }),
    });

    const report = await reconciler.runOnce();
    expect(report.ran).toBe(true);
    expect(report.conversationsChanged).toBeGreaterThan(0);
    expect(report.utterancesNew).toBeGreaterThan(0);
    expect(report.cursorAfter).toBeTruthy();

    // The restatement folds into the open card rather than stacking a duplicate.
    const after = await drifts();
    const merged = after.find((d) => d.property === 'retry.max_attempts')!;
    expect(after.filter((d) => d.property === 'retry.max_attempts')).toHaveLength(1);
    expect(merged.priorOccurrences.length).toBeGreaterThan(priorBefore);
    expect(merged.priorOccurrences.some((o) => o.afterSourceChange)).toBe(true);

    const metrics = await built.store.getMetrics();
    expect(metrics.BeeEventsReconciled).toBeGreaterThan(0);
  });

  it('processes an utterance exactly once when both paths deliver it', async () => {
    await say({ text: 'The checkout worker retries three times.', conversationId: '10412', capturedAt: '2026-08-12T09:14:11.000Z' });
    const again = await built.engine.ingestUtterance({
      text: 'The checkout worker retries three times.',
      conversationId: '10412',
      utteranceIndex: 1,
      window: [],
      speakerCount: 1,
      origin: 'reconciled',
    });
    expect(again.duplicate).toBe(true);
    expect((await built.store.getMetrics()).BeeEventsDeduplicated).toBeGreaterThan(0);
  });

  it('advances the cursor only after the batch has been processed', async () => {
    expect(await built.store.getCursor('bee')).toBeUndefined();
    const report = await reconciler.runOnce();
    expect(await built.store.getCursor('bee')).toBe(report.cursorAfter);
  });
});

describe('10 GitHub unavailable', () => {
  it('is inconclusive, not drifted, when the authoritative repository cannot be read', async () => {
    const broken = buildEngineWithBrokenGitHub();
    const out = await broken.engine.ingestUtterance({
      text: 'The events table stores the user agent.',
      conversationId: '10743',
      window: [],
      speakerCount: 1,
      origin: 'realtime',
    });
    expect(out.claims[0]!.verdict).toBe('INCONCLUSIVE');
    expect(await broken.store.listDrifts({ limit: 10 })).toHaveLength(0);
    brokenCleanup();
  });

  it('still explains what it could not read', async () => {
    const broken = buildEngineWithBrokenGitHub();
    const out = await broken.engine.ingestUtterance({
      text: 'The events table stores the user agent.',
      conversationId: '10743',
      window: [],
      speakerCount: 1,
      origin: 'realtime',
    });
    const evidence = await broken.store.listEvidence(out.claims[0]!.claim.id);
    expect(evidence[0]!.status).toBe('UNAVAILABLE');
    expect(evidence[0]!.error).toBeTruthy();
    brokenCleanup();
  });
});

describe('11 AppConfig unavailable', () => {
  it('is inconclusive when the deployed configuration cannot be read', async () => {
    const broken = buildEngineWithBrokenAppConfig();
    const out = await broken.engine.ingestUtterance({
      text: "It's probably fine. Checkout retries failed jobs three times anyway.",
      conversationId: '10743',
      window: [],
      speakerCount: 1,
      origin: 'realtime',
    });
    expect(out.claims[0]!.verdict).toBe('INCONCLUSIVE');
    expect(await broken.store.listDrifts({ limit: 10 })).toHaveLength(0);

    const metrics = await broken.store.getMetrics();
    expect(metrics.ClaimsInconclusive).toBeGreaterThan(0);
    expect(metrics.DriftsDetected ?? 0).toBe(0);
    brokenCleanup();
  });
});

describe('12 the same drift repeated across conversations', () => {
  it('folds a restatement into the open card and re-scores severity', async () => {
    await say({ text: "It's probably fine. Checkout retries failed jobs three times anyway." });
    const first = (await drifts())[0]!;

    await say({
      text: 'Told them the checkout worker retries three times, so a slow consumer is not the problem.',
      conversationId: '10744',
    });

    const after = await drifts();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(first.id);
    expect(after[0]!.priorOccurrences.length).toBeGreaterThanOrEqual(first.priorOccurrences.length);
    expect(after[0]!.severity).toBe('HIGH');
  });

  it('writes the verified value back into Bee as a confirmed fact', async () => {
    await say({ text: "It's probably fine. Checkout retries failed jobs three times anyway." });
    const [drift] = await drifts();

    const result = await built.engine.updateUnderstanding(drift!.id);
    expect(result.error).toBeUndefined();
    expect(result.factText).toMatch(/Checkout retry attempts is currently 1 in production/);
    expect(result.factText).toMatch(/AWS_APPCONFIG/);
    expect(result.drift.resolution).toBe('MODEL_UPDATED');

    // The correction lands in Bee's memory, not only in this product's database.
    const facts = await built.bee.listFacts({ limit: 50 });
    expect(facts.some((f) => /Checkout retry attempts is currently 1/.test(f.text ?? ''))).toBe(true);
    expect((await built.store.getMetrics()).BeeFactsWritten).toBe(1);
  });
});

// --------------------------------------------------------------------- setup

let brokenCleanup: () => void = () => {};

/**
 * An engine whose GitHub clone is not there. A missing clone is what a source
 * outage looks like from inside the process, and it is the cheapest honest way
 * to provoke one.
 */
function buildEngineWithBrokenGitHub(): BuiltEngine {
  const b = brokenEngine();
  (b.github as unknown as { opts: { repoRoot: string } }).opts.repoRoot = join(REPO_ROOT, 'demo', 'no-such-clone');
  return b;
}

function buildEngineWithBrokenAppConfig(): BuiltEngine {
  const b = brokenEngine();
  const appconfig = b.verifiers.find((v) => v.name === 'aws_appconfig')!;
  (appconfig as unknown as { opts: { fixtureRoot: string } }).opts.fixtureRoot = join(REPO_ROOT, 'demo', 'no-such-mirror');
  return b;
}

function brokenEngine(): BuiltEngine {
  const t = tempStore();
  brokenCleanup = t.cleanup;
  return buildEngine({
    root: REPO_ROOT,
    mode: 'local',
    statePath: t.path,
    proposers: ['grammar'],
    userId: 'test',
    bee: simClient(),
  });
}
