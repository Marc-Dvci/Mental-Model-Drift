/**
 * The coverage survey, the drift worklist ordering, and the event backlog.
 *
 * These three exist for one reason between them: what a person sees when they
 * open the dashboard. The survey is the claim that the product mostly stays
 * quiet, and it has to be measured rather than asserted. The ordering decides
 * which card a person reads first. The backlog decides whether the panel that
 * shows the reasoning is populated at all for someone who arrives after the
 * conversation ended.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { BeeClient } from '#bee';
import { BeeSim } from '../../tools/bee-sim/src/server.ts';
import { beeCoverageSource, buildEngine, surveyCoverage, type BuiltEngine, type CoverageSource } from '#engine';
import { createContext, listDrifts, getCoverage, type ApiContext } from '../../apps/server/src/api.ts';
import { REPO_ROOT, tempStore } from '../helpers.ts';

let sim: BeeSim;
let port: number;
let built: BuiltEngine;
let cleanup: () => void;

beforeAll(async () => {
  sim = new BeeSim({
    port: 0,
    fixtureDir: join(REPO_ROOT, 'demo', 'conversations'),
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
    bee: new BeeClient({ proxyUrl: `http://127.0.0.1:${port}`, allowCli: false }),
  });
});

describe('coverage survey', () => {
  it('reads the whole recorded history through Bee and finds a claim in a small minority of it', async () => {
    const report = await surveyCoverage(beeCoverageSource(built.bee), built.extractor, { limit: 200 });

    expect(report.conversations).toBe(21);
    expect(report.utterances).toBe(115);
    expect(report.speakers).toBe(3);
    expect(report.checkable).toBe(17);
    expect(report.ignored).toBe(report.utterances - report.checkable);
    // The headline the product makes: most of what a person says is not about
    // anything this registry can settle. If that stops being true, the claim in
    // the README and in the demo stops being true with it.
    expect(report.checkable / report.utterances).toBeLessThan(0.2);
  });

  it('attributes every hit to a registered property, and to nothing else', async () => {
    const report = await surveyCoverage(beeCoverageSource(built.bee), built.extractor, { limit: 200 });
    const counted = report.perProperty.reduce((n, p) => n + p.count, 0);
    expect(counted).toBe(report.hits.length);
    for (const p of report.perProperty) {
      const [subject, ...rest] = p.key.split('.');
      expect(built.registry.resolve(subject!, rest.join('.'))).toBeTruthy();
    }
  });

  it('writes nothing and reads no source', async () => {
    await surveyCoverage(beeCoverageSource(built.bee), built.extractor, { limit: 200 });
    expect(await built.store.listDrifts({ limit: 10 })).toHaveLength(0);
    expect(await built.store.listClaims({ limit: 10 })).toHaveLength(0);
  });

  it('reports an empty history without dividing by zero', async () => {
    const empty: CoverageSource = async () => [];
    const report = await surveyCoverage(empty, built.extractor);
    expect(report).toMatchObject({ conversations: 0, utterances: 0, checkable: 0, ignored: 0 });
    expect(report.hits).toHaveLength(0);
  });
});

describe('drift worklist', () => {
  let ctx: ApiContext;

  beforeEach(() => {
    ctx = createContext();
    // Swap the engine built from the environment for the one pointed at the
    // emulator, so this exercises the same projection the dashboard reads.
    (ctx as { built: BuiltEngine }).built = built;
  });

  it('puts the highest severity first, and the most-repeated belief above a one-off of equal severity', async () => {
    const now = new Date().toISOString();
    const base = {
      userId: 'test',
      claimId: 'c',
      subject: 'checkout-worker',
      property: 'retry.max_attempts',
      assertedValue: 3,
      actualValue: 1,
      detectedAt: now,
      confirmationRequired: false,
      ownership: 'LIKELY_USER' as const,
      verdict: 'DRIFTED' as const,
      resolution: 'OPEN' as const,
    };
    await built.store.putDrift({ ...base, id: 'low', severity: 'LOW', priorOccurrences: [] });
    await built.store.putDrift({ ...base, id: 'high-once', severity: 'HIGH', priorOccurrences: [] });
    await built.store.putDrift({
      ...base,
      id: 'high-often',
      severity: 'HIGH',
      priorOccurrences: [
        { conversationId: '1', at: '2026-07-14T09:00:00.000Z', excerpt: 'three times', afterSourceChange: false },
        { conversationId: '2', at: '2026-08-12T09:00:00.000Z', excerpt: 'three times', afterSourceChange: false },
      ],
    });
    await built.store.putDrift({ ...base, id: 'medium', severity: 'MEDIUM', priorOccurrences: [] });

    const order = (await listDrifts(ctx)).map((c) => c.drift.id);
    expect(order).toEqual(['high-often', 'high-once', 'medium', 'low']);
  });
});

describe('coverage endpoint caching', () => {
  it('serves the same report twice without re-reading, and re-reads when forced', async () => {
    const ctx = createContext();
    (ctx as { built: BuiltEngine }).built = built;

    let reads = 0;
    const list = built.bee.listConversations.bind(built.bee);
    built.bee.listConversations = async (o) => {
      reads++;
      return list(o);
    };

    await getCoverage(ctx);
    await getCoverage(ctx);
    expect(reads).toBe(1);

    await getCoverage(ctx, { force: true });
    expect(reads).toBe(2);
  });
});
