/**
 * The server as a judge or a user actually meets it: a real process, a real
 * port, a real Bee emulator behind it.
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
import { BeeSim } from '../../tools/bee-sim/src/server.ts';
import { REPO_ROOT, TSX } from '../helpers.ts';

let sim: BeeSim;
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
  it('replays what already happened to a dashboard that connects afterwards', async () => {
    // Nothing has been ingested yet: a fresh connection sees only the greeting.
    const first = await readEvents((e) => e.some((x) => x.type === 'hello'), 5000);
    expect(first.filter((e) => e.type !== 'hello')).toHaveLength(0);
    expect(first.find((e) => e.type === 'hello')).toMatchObject({ backlog: 0 });

    const ingested = await fetch(`${base}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The shape a Bee realtime frame's payload actually has: an `utterance`
      // object, and the conversation keyed by uuid. Sent bare, without the
      // envelope, so the fallback path stays covered.
      body: JSON.stringify({
        conversation_uuid: '9a41c2fe-52b8-4d77-b0e3-6f18cd4a2b55',
        utterance: {
          text: "It's probably fine. Checkout retries failed jobs three times anyway.",
          speaker: 'speaker_1',
          created_at: new Date().toISOString(),
        },
      }),
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
      body: JSON.stringify({ conversationId: '10743' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/guided tour is off/);
  });

  it('serves the coverage survey over the same Bee transport the pipeline uses', async () => {
    const report = (await (await fetch(`${base}/api/coverage`)).json()) as { utterances: number; checkable: number };
    expect(report.utterances).toBe(115);
    expect(report.checkable).toBe(17);
  }, 20_000);

  it('has no route that returns a transcript', async () => {
    for (const path of ['/api/transcripts', '/api/conversations', '/api/utterances']) {
      expect((await fetch(base + path)).status).toBe(404);
    }
  });

  it('keeps the event name when a relay posts the enveloped frame', async () => {
    // `bee stream --webhook-body '{"event":"{{event}}","data":{{{raw}}}}'` is
    // the shape that preserves the SSE event name across the webhook hop. The
    // bare-payload form is covered by the replay test above; this is the one
    // that arrives already named, and it must not be read as an unknown type.
    const res = await fetch(`${base}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'new-utterance',
        data: {
          conversation_uuid: '9a41c2fe-52b8-4d77-b0e3-6f18cd4a2b55',
          utterance: { text: 'And it backs off five seconds between attempts.', speaker: 'speaker_1' },
        },
      }),
    });
    expect(res.ok).toBe(true);
    expect(await res.json()).not.toMatchObject({ ignored: 'unknown' });
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
        data: { conversation_id: 10743, short_summary: 'Debugging the checkout queue' },
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
