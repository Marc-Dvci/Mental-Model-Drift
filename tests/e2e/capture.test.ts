/**
 * Scenario 09, through the real subscription rather than by calling the
 * reconciler by hand.
 *
 * This is the test the design most needs, because the bug it guards against is
 * invisible: a client that reconciles only on disconnect passes every unit test,
 * looks correct in review, and silently loses exactly the conversations that
 * happen while nobody is connected -- which is most of them.
 *
 * So the stream is genuinely cut here, a conversation is genuinely recorded
 * while it is down, and the assertion is that the utterance arrives anyway.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { BeeClient } from '#bee';
import { Reconciler, buildEngine, liveUtteranceInput, startCapture, type Capture, type ReconcileReport } from '#engine';
import { BeeSim } from '../../tools/bee-sim/src/server.ts';
import { REPO_ROOT, tempStore } from '../helpers.ts';

let sim: BeeSim;
let port: number;
let capture: Capture;
let cleanup: () => void;
let built: ReturnType<typeof buildEngine>;
const reconciliations: { report: ReconcileReport; why: string }[] = [];

const post = (path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for a condition rather than for a duration, so the test is not a race. */
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('condition was never met');
    await sleep(100);
  }
}

beforeAll(async () => {
  sim = new BeeSim({
    port: 0,
    fixtureDir: join(REPO_ROOT, 'demo', 'conversations'),
    liveConversationIds: ['10695705', '10697402'],
    log: () => {},
  });
  port = await sim.listen();

  const t = tempStore();
  cleanup = t.cleanup;
  built = buildEngine({
    root: REPO_ROOT,
    mode: 'local',
    statePath: t.path,
    proposers: ['grammar'],
    userId: 'test',
    bee: new BeeClient({ proxyUrl: `http://127.0.0.1:${port}`, allowCli: false }),
  });

  capture = startCapture({
    bee: built.bee,
    reconciler: new Reconciler(built.bee, built.engine, built.store),
    // Long enough that nothing here can be explained by the periodic sweep.
    intervalMs: 600_000,
    // The server's own path: the frame's uuid is resolved to the conversation's
    // numeric id through its utterance id, which is what lets the reconciled
    // read of the same sentence be recognised as a duplicate.
    onUtterance: async (event) => {
      await built.engine.ingestUtterance(await liveUtteranceInput(built.bee, event));
    },
    onReconciled: (report, why) => reconciliations.push({ report, why }),
  });
});

afterAll(async () => {
  capture?.stop();
  await sim.close();
  cleanup?.();
});

describe('capture across a stream outage', () => {
  it('detects drift from the live stream', async () => {
    await post('/_sim/play', { conversationId: '10695705', speedMs: 0 });
    await until(async () => (await built.store.listDrifts({ limit: 10 })).length >= 3);

    const drifts = await built.store.listDrifts({ limit: 10 });
    expect(drifts.map((d) => d.property).sort()).toEqual(['deployed_version', 'enabled', 'retry.max_attempts']);
  });

  it('recovers a conversation recorded while the stream was down, without being asked', async () => {
    const before = (await built.store.listDrifts({ limit: 10 })).find((d) => d.property === 'retry.max_attempts')!;
    expect(before.priorOccurrences.some((o) => /platform team|Told them/.test(o.excerpt))).toBe(false);

    await post('/_sim/network', { up: false });
    await until(() => reconciliations.some((r) => r.why === 'stream lost'));

    // Recorded by Bee with nobody listening. Nothing streams it, ever.
    await post('/_sim/play', { conversationId: '10697402', speedMs: 0 });
    await post('/_sim/network', { up: true });

    // No manual reconcile call anywhere in this test.
    await until(() => reconciliations.some((r) => r.why === 'stream restored' && r.report.utterancesNew > 0), 20_000);

    const after = (await built.store.listDrifts({ limit: 10 })).find((d) => d.property === 'retry.max_attempts')!;
    expect(after.id).toBe(before.id);
    expect(after.priorOccurrences.some((o) => /Told them the checkout worker retries three times/.test(o.excerpt))).toBe(true);
    // Exactly one statement after the change: the recovered corridor sentence.
    // The card's own conversation is not a prior occurrence of itself, which
    // holds only because the live frame's uuid was resolved to the same numeric
    // id the history search returns.
    const afterChange = after.priorOccurrences.filter((o) => o.afterSourceChange);
    expect(afterChange.map((o) => o.conversationId)).toEqual(['10697402']);
    expect(after.priorOccurrences.some((o) => o.conversationId === '10695705')).toBe(false);
    expect(after.severity).toBe('HIGH');
  });

  it('reconciles on the reconnect, which is the only pass that can see the gap', () => {
    const onLoss = reconciliations.find((r) => r.why === 'stream lost');
    const onRestore = reconciliations.find((r) => r.why === 'stream restored' && r.report.utterancesNew > 0);

    // The disconnect pass runs first and finds nothing: the conversation it
    // needs has not been recorded yet. Reconciling only there recovers nothing.
    expect(onLoss?.report.utterancesNew ?? 0).toBe(0);
    expect(onRestore).toBeDefined();
  });

  it('counts the utterances the two paths both delivered, and processes each once', async () => {
    const metrics = await built.store.getMetrics();
    expect(metrics.BeeEventsReceived).toBeGreaterThan(0);
    expect(metrics.BeeEventsReconciled).toBeGreaterThan(0);
    expect(metrics.BeeEventsDeduplicated).toBeGreaterThan(0);
    // Three drift cards, no duplicates, however many times the sentences arrived.
    const drifts = await built.store.listDrifts({ limit: 20 });
    expect(new Set(drifts.map((d) => `${d.subject}.${d.property}`)).size).toBe(drifts.length);
  });

  it('recognises every sentence again once Bee replaces the realtime transcription with the final one', async () => {
    // Processing gives each utterance a new id. Nothing that was already heard
    // may come back as new, and no card may be raised twice.
    const before = await built.store.listDrifts({ limit: 20 });
    await post('/_sim/complete', { conversationId: '10695705' });
    await post('/_sim/complete', { conversationId: '10697402' });
    const report = await capture.reconcileNow();
    expect(report.conversationsChanged).toBeGreaterThan(0);
    expect(report.utterancesNew).toBe(0);
    expect(await built.store.listDrifts({ limit: 20 })).toHaveLength(before.length);
  });
});
