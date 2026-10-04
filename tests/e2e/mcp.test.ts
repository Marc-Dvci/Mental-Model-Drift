/**
 * The Assumption Firewall, driven by a real MCP client.
 *
 * These run over an in-memory transport rather than by mocking the server, so
 * what is exercised is the actual protocol surface: tool discovery, argument
 * validation, structured content, and the error paths an agent will hit.
 *
 * The behaviour that matters is what an agent is told. A DRIFTED answer has to
 * carry the real value *and* the change that produced it, or the agent will
 * either act on the stale value or silently overrule the human -- and both of
 * those are worse than saying nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BeeClient } from '#bee';
import { buildEngine, type BuiltEngine } from '#engine';
import { BeeSim } from '../../tools/bee-sim/src/server.ts';
import { createMcpServer } from '../../apps/mcp/src/server.ts';
import { REPO_ROOT, tempStore } from '../helpers.ts';

let sim: BeeSim;
let port: number;
let built: BuiltEngine;
let client: Client;
let cleanup: () => void;

beforeAll(async () => {
  sim = new BeeSim({
    port: 0,
    fixtureDir: join(REPO_ROOT, 'demo', 'conversations'),
    liveConversationIds: ['10743', '10744'],
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

  const server = createMcpServer(built, { allowWrites: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-agent', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
  await sim.close();
  cleanup?.();
});

function payload(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

function said(result: unknown): string {
  return (result as { content: { type: string; text: string }[] }).content.map((c) => c.text).join('\n');
}

describe('tool surface', () => {
  it('advertises the five tools an agent needs, with descriptions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'belief_history',
      'check_assumption',
      'list_verifiable_properties',
      'open_drifts',
      'record_understanding',
    ]);
    for (const tool of tools) expect(tool.description!.length).toBeGreaterThan(60);
  });

  it('marks the four read-only tools as read-only and the writing one as not', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.check_assumption!.annotations?.readOnlyHint).toBe(true);
    expect(byName.record_understanding!.annotations?.readOnlyHint).toBe(false);
  });

  it('publishes the registry as the boundary of what it will answer about', async () => {
    const result = await client.callTool({ name: 'list_verifiable_properties', arguments: {} });
    const data = payload(result) as { systems: { subject: string; properties: unknown[] }[] };
    expect(data.systems.map((s) => s.subject).sort()).toEqual(['checkout-service', 'checkout-worker', 'events', 'new-checkout']);
  });
});

describe('check_assumption', () => {
  it('tells an agent the real value, the change behind it, and what to do', async () => {
    const result = await client.callTool({
      name: 'check_assumption',
      arguments: { statement: 'The checkout worker retries three times, so a slow consumer is not the problem.' },
    });
    const data = payload(result) as { findings: Record<string, unknown>[] };
    const finding = data.findings[0]!;

    expect(finding.verdict).toBe('DRIFTED');
    expect(finding.assertedValue).toBe(3);
    expect(finding.actualValue).toBe(1);
    expect(String(finding.changedAt)).toMatch(/^2026-08-23/);
    expect(finding.severity).toBe('HIGH');

    const text = said(result);
    expect(text).toMatch(/DRIFTED/);
    expect(text).toMatch(/stated 3, actually 1/);
    expect(text).toMatch(/Act on the actual value/);
    // The evidence locator, so the agent can quote where the answer came from.
    expect(text).toMatch(/appconfig:\/\/ecommerce\/production\/checkout-worker/);
  });

  it('confirms a statement that is still true, without ceremony', async () => {
    const result = await client.callTool({
      name: 'check_assumption',
      arguments: { statement: 'The events table stores the source IP.' },
    });
    const finding = (payload(result) as { findings: Record<string, unknown>[] }).findings[0]!;
    expect(finding.verdict).toBe('SUPPORTED');
    expect(said(result)).toMatch(/Safe to act on/);
  });

  it('refuses a statement outside the registry instead of guessing at it', async () => {
    const result = await client.callTool({
      name: 'check_assumption',
      arguments: { statement: 'Kafka is a better fit than SQS for this workload.' },
    });
    expect(payload(result).verdict).toBe('UNSUPPORTED');
    expect(said(result)).toMatch(/list_verifiable_properties/);
  });

  it('does not answer a question as though it were a claim', async () => {
    const result = await client.callTool({
      name: 'check_assumption',
      arguments: { statement: 'Does the checkout worker still retry three times?' },
    });
    expect(payload(result).verdict).toBe('UNSUPPORTED');
    expect(said(result)).toMatch(/QUESTION|not an assertion/);
  });

  it('resolves a pronoun from the context an agent passes in', async () => {
    const result = await client.callTool({
      name: 'check_assumption',
      arguments: { statement: 'It retries three times.', context: ['Looking at the checkout worker alert.'] },
    });
    const finding = (payload(result) as { findings: Record<string, unknown>[] }).findings[0]!;
    expect(finding.subject).toBe('checkout-worker');
    expect(finding.verdict).toBe('DRIFTED');
  });

  it('reports a scoped flag against the region that was named', async () => {
    const eu = await client.callTool({
      name: 'check_assumption',
      arguments: { statement: 'The new checkout is still disabled in Europe.' },
    });
    const us = await client.callTool({
      name: 'check_assumption',
      arguments: { statement: 'The new checkout is still disabled in the US.' },
    });
    expect((payload(eu) as { findings: { verdict: string }[] }).findings[0]!.verdict).toBe('DRIFTED');
    expect((payload(us) as { findings: { verdict: string }[] }).findings[0]!.verdict).toBe('SUPPORTED');
  });

  it('validates its arguments through the protocol', async () => {
    const result = await client.callTool({ name: 'check_assumption', arguments: { statement: 'x' } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(said(result)).toMatch(/validation error/i);
  });
});

describe('belief_history', () => {
  it('returns the conversations in which the belief was stated, through Bee search', async () => {
    const result = await client.callTool({
      name: 'belief_history',
      arguments: { subject: 'checkout-worker', property: 'retry.max_attempts' },
    });
    const data = payload(result) as { occurrences: { excerpt: string }[]; searchMode: string; beeQuery: string };
    expect(data.occurrences.length).toBeGreaterThanOrEqual(2);
    expect(data.searchMode).toBe('neural');
    expect(data.beeQuery).toBeTruthy();
    expect(said(result)).toMatch(/retries three times/);
  });

  it('says so plainly when the property is not in the registry', async () => {
    const result = await client.callTool({ name: 'belief_history', arguments: { subject: 'kafka', property: 'partitions' } });
    expect(said(result)).toMatch(/No registry entry/);
  });
});

describe('record_understanding', () => {
  it('refuses to write to Bee memory when writes are not enabled', async () => {
    const result = await client.callTool({ name: 'record_understanding', arguments: { driftId: 'anything' } });
    expect(said(result)).toMatch(/disabled on this server/);
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it('refuses a drift that has not been attributed to the wearer, even with writes on', async () => {
    const writeServer = createMcpServer(built, { allowWrites: true });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const writeClient = new Client({ name: 'test-agent-writes', version: '1.0.0' });
    await Promise.all([writeServer.connect(st), writeClient.connect(ct)]);

    await built.engine.ingestUtterance({
      text: 'The checkout worker retries three times.',
      conversationId: '10743',
      speakerCount: 3, // a room, so the belief cannot be attributed to the wearer
      window: [],
      origin: 'realtime',
    });
    const [drift] = await built.store.listDrifts({ limit: 5 });
    const result = await writeClient.callTool({ name: 'record_understanding', arguments: { driftId: drift!.id } });

    expect(said(result)).toMatch(/not attributed to the wearer/);
    expect(await built.bee.listFacts({ limit: 50 })).not.toContainEqual(expect.objectContaining({ text: expect.stringMatching(/Checkout retry attempts/) }));
    await writeClient.close();
  });
});
