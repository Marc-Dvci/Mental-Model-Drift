/**
 * The server as a judge or a user actually meets it: a real process, a real
 * port, bee-sim behind it.
 *
 * What is checked here cannot be checked in-process. The event backlog only
 * matters across a *connection*, and the guided-tour controls only matter as
 * routes that are absent by default. Both were written for the dashboard, and
 * both would pass a unit test while being broken over HTTP.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { BeeSim, streamUuid } from '../../tools/bee-sim/src/server.ts';
import { REPO_ROOT, TSX } from '../helpers.ts';

let sim: BeeSim;
let simBase: string;
let server: ChildProcess;
let base: string;
let stateDir: string;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(url: string, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`${url} never came up`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  sim = new BeeSim({
    port: 0,
    fixtureDir: join(REPO_ROOT, 'demo', 'conversations'),
    log: () => {},
  });
  const simPort = await sim.listen();
  simBase = `http://127.0.0.1:${simPort}`;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  stateDir = mkdtempSync(join(tmpdir(), 'mmd-server-'));

  server = spawn(process.execPath, [TSX, 'apps/server/src/main.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      BEE_PROXY_URL: `http://127.0.0.1:${simPort}`,
      BEE_ALLOW_CLI: '0',
      MMD_MODE: 'local',
      MMD_STATE: join(stateDir, 'store.json'),
      MMD_PROPOSERS: 'grammar',
      MMD_STREAM: '0',
    },
    stdio: 'ignore',
  });
  await waitFor(`${base}/api/status`);
}, 60_000);

afterAll(async () => {
  server?.kill();
  await sim.close();
  rmSync(stateDir, { recursive: true, force: true });
});

/**
 * Speak a sentence into a conversation and return the frame Bee would stream
 * for it: the conversation's uuid, and the utterance's id in the realtime
 * transcription the sim now serves.
 */
async function liveFrame(conversationId: string, text: string): Promise<Record<string, unknown>> {
  sim.appendUtterance(conversationId, text);
  const read = (await (await fetch(`${simBase}/v1/conversations/${conversationId}`)).json()) as {
    conversation: { transcriptions: { utterances: { id: number; start: number; end: number; text: string; spoken_at: number }[] }[] };
  };
  const u = read.conversation.transcriptions[0]!.utterances.at(-1)!;
  return {
    type: 'new-utterance',
    conversation_uuid: streamUuid(conversationId),
    utterance: { id: u.id, sample_id: streamUuid(`sample-${u.id}`), start: u.start, end: u.end, text: u.text, spoken_at: new Date(u.spoken_at).toISOString() },
  };
}

/** Read server-sent events until `stop` says enough, or the budget runs out. */
async function readEvents(stop: (events: Record<string, unknown>[]) => boolean, timeoutMs = 10_000) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (line) events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
      }
      if (stop(events)) break;
    }
  } finally {
    controller.abort();
  }
  return events;
}

describe('the server over HTTP', () => {
  // First, before any test below speaks a sentence into the demo history.
  it('serves the coverage survey over the same Bee transport the pipeline uses', async () => {
    const report = (await (await fetch(`${base}/api/coverage`)).json()) as { utterances: number; checkable: number };
    expect(report.utterances).toBe(115);
    expect(report.checkable).toBe(17);
  }, 20_000);

  it('replays what already happened to a dashboard that connects afterwards', async () => {
    // Nothing has been ingested yet: a fresh connection sees only the greeting.
    const first = await readEvents((e) => e.some((x) => x.type === 'hello'), 5000);
    expect(first.filter((e) => e.type !== 'hello')).toHaveLength(0);
    expect(first.find((e) => e.type === 'hello')).toMatchObject({ backlog: 0 });

    const ingested = await fetch(`${base}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A live frame, sent bare as a `--webhook-body '{{raw}}'` relay posts
      // it: no envelope, so its own `type` is what names it.
      body: JSON.stringify(await liveFrame('10695705', "It's probably fine. Checkout retries failed jobs three times anyway.")),
    });
    expect(ingested.ok).toBe(true);
    expect(await ingested.json()).not.toMatchObject({ ignored: 'unknown' });

    // A second, later connection must see the reasoning it missed, marked as
    // history rather than as something that just arrived.
    const second = await readEvents((e) => e.some((x) => x.type === 'verdict'), 8000);
    const verdict = second.find((e) => e.type === 'verdict');
    expect(verdict).toBeDefined();
    expect(verdict).toMatchObject({ replay: true, verdict: 'DRIFTED' });
    expect(second.find((e) => e.type === 'hello')?.backlog).toBeGreaterThan(0);
  }, 30_000);

  it('refuses the guided-tour controls unless the server was started for a demonstration', async () => {
    const res = await fetch(`${base}/api/tour/play`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: '10695705' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/guided tour is off/);
  });

  it('has no route that returns a transcript', async () => {
    for (const path of ['/api/transcripts', '/api/conversations', '/api/utterances']) {
      expect((await fetch(base + path)).status).toBe(404);
    }
  });

  it('prepares the documentation patch, and says it did not push it, when pushing is off', async () => {
    const drifts = (await (await fetch(`${base}/api/drifts`)).json()) as { drift: { id: string; property: string } }[];
    const card = drifts.find((d) => d.drift.property === 'retry.max_attempts');
    expect(card).toBeDefined();
    const res = await fetch(`${base}/api/drifts/${card!.drift.id}/docs-pr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { opened: boolean; path: string; hunks: { before: string; after: string }[]; reason: string };
    expect(body.opened).toBe(false);
    expect(body.path).toBe('docs/architecture.md');
    expect(body.hunks[0]!.before).toContain('three');
    expect(body.hunks[0]!.after).not.toContain('three');
    expect(body.reason).toContain('MMD_ALLOW_PR=1');
  }, 30_000);

  it('accepts the enveloped frame a webhook template can also produce', async () => {
    // `bee stream --webhook-body '{"event":"{{event}}","data":{{{raw}}}}'`
    // wraps the frame in its SSE name. The bare form is covered by the replay
    // test above; this one must not be read as an unknown type either.
    const res = await fetch(`${base}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'new-utterance',
        data: await liveFrame('10695705', 'And it backs off five seconds between attempts.'),
      }),
    });
    expect(res.ok).toBe(true);
    expect(await res.json()).not.toMatchObject({ ignored: 'unknown' });
  }, 20_000);

  it('files a live sentence under the numeric id Bee reads it by, not the stream uuid', async () => {
    const res = await fetch(`${base}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await liveFrame('10695705', 'And the new checkout is still disabled in Europe.')),
    });
    const out = (await res.json()) as { claims: { claim: { sourceConversationId: string } }[] };
    expect(out.claims[0]!.claim.sourceConversationId).toBe('10695705');
  }, 20_000);

  it('ignores a named event it does not act on, rather than mis-reading it', async () => {
    // A summary update is flat -- {conversation_id, short_summary} -- and a
    // shape-guesser has nothing to go on. Named, it is unambiguously not an
    // utterance, and the server says so instead of processing it as one.
    const res = await fetch(`${base}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'update-conversation-summary',
        data: { conversation_id: 10695705, short_summary: 'Debugging the checkout queue' },
      }),
    });
    expect(res.ok).toBe(true);
    expect(await res.json()).toMatchObject({ ignored: 'update-conversation-summary' });
  }, 20_000);

  describe('POST /api/check -- the firewall over HTTP', () => {
    it('gives an agent the same verdict the drift card carries', async () => {
      const res = await fetch(`${base}/api/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ statement: 'The checkout worker retries three times, so a slow consumer is not the problem.' }),
      });
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { code: number; rendered: string; findings: { verdict: string }[] };
      expect(body.code).toBe(1);
      expect(body.findings[0]!.verdict).toBe('DRIFTED');
      expect(body.rendered).toContain('changed 2026-08-23');
    }, 30_000);

    it('records nothing: a question an agent asked is not something the wearer said', async () => {
      const before = ((await (await fetch(`${base}/api/claims`)).json()) as unknown[]).length;
      await fetch(`${base}/api/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ statement: 'The new checkout is still disabled in Europe.' }),
      });
      const after = ((await (await fetch(`${base}/api/claims`)).json()) as unknown[]).length;
      expect(after).toBe(before);
    }, 30_000);

    it('rejects a request with no statement rather than checking an empty string', async () => {
      const res = await fetch(`${base}/api/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(400);
    });
  });
});
