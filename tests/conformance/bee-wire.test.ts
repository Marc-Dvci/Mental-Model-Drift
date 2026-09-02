/**
 * Wire conformance: does the emulator speak Bee?
 *
 * Every other test in this repo runs the product against `tools/bee-sim`. That
 * proves the product agrees with the emulator, which is worth nothing unless
 * the emulator agrees with Bee. This file is the bridge, and it does not take
 * anyone's word for the format:
 *
 *   1. `parseSSEBuffer` below is copied verbatim from `@beeai/cli` 0.7.3
 *      (`sources/commands/stream/index.ts`, MIT). It is the function `bee
 *      stream` itself uses to turn socket bytes into events.
 *   2. The test opens a raw socket to the emulator, keeps the literal bytes it
 *      writes, and feeds them to that function.
 *   3. What comes back has to be the events that were sent, named.
 *
 * That is a stronger statement than "the shapes look right". Bee's parser only
 * emits an event once it has seen *both* an `event` field and a `data` field:
 * a frame written as `data:` alone is silently discarded, no error, no warning.
 * An emulator with that bug looks perfect to a client that does the same thing
 * and produces nothing at all against a real device -- which is exactly the
 * failure this file exists to make impossible.
 *
 * The same applies to the read endpoints: `/v1/conversations/:id/related` is
 * reachable through `bee proxy` because the proxy forwards every `/v1` path
 * upstream rather than exposing a route list, so the emulator has to answer it
 * too, in the shape the CLI's own reader expects.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Socket } from 'node:net';
import { BeeSim } from '../../tools/bee-sim/src/server.ts';
import { join } from 'node:path';
import { BEE_STREAM_EVENTS, BeeClient, classifyEvent } from '#bee';
import { REPO_ROOT } from '../helpers.ts';

// ---------------------------------------------------------------------------
// Vendored from @beeai/cli 0.7.3, sources/commands/stream/index.ts (MIT).
// Copied rather than imported: the point is to run Bee's parser, unmodified,
// over our bytes. Reformatted only for this repo's lint settings.
// ---------------------------------------------------------------------------

type SSEEvent = { event: string; data: string };
type ParsedEvents = { parsed: SSEEvent[]; remaining: string };

function parseSSEBuffer(buffer: string): ParsedEvents {
  const parsed: SSEEvent[] = [];
  const lines = buffer.split('\n');
  let currentEvent: Partial<SSEEvent> = {};
  let lastCompleteIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // Empty line marks end of event
    if (line === '') {
      if (currentEvent.event && currentEvent.data !== undefined) {
        parsed.push(currentEvent as SSEEvent);
      }
      currentEvent = {};
      lastCompleteIndex = i;
      continue;
    }

    // Comment (ping)
    if (line.startsWith(':')) {
      lastCompleteIndex = i;
      continue;
    }

    // Parse field
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      continue;
    }

    const field = line.slice(0, colonIndex);
    const value = line.slice(colonIndex + 1).trimStart();

    if (field === 'event') {
      currentEvent.event = value;
    } else if (field === 'data') {
      currentEvent.data = value;
    } else if (field === 'retry') {
      // Ignore retry field
    }
  }

  const remaining = lastCompleteIndex >= 0 ? lines.slice(lastCompleteIndex + 1).join('\n') : buffer;

  return { parsed, remaining };
}

// ---------------------------------------------------------------------------

let sim: BeeSim;
let port: number;

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
});

/** Open a raw socket, request the stream, and keep every byte it sends. */
async function captureStreamBytes(
  types: string,
  provoke: () => void | Promise<void>,
  settleMs = 250,
): Promise<string> {
  const socket: Socket = connect({ host: '127.0.0.1', port });
  let bytes = '';
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => (bytes += chunk));
  socket.write(
    `GET /v1/stream?types=${encodeURIComponent(types)} HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n`,
  );
  await new Promise((r) => setTimeout(r, 100));
  await provoke();
  await new Promise((r) => setTimeout(r, settleMs));
  socket.destroy();
  // Strip the HTTP response head; SSE starts after the blank line.
  const bodyAt = bytes.indexOf('\r\n\r\n');
  const body = bodyAt === -1 ? bytes : bytes.slice(bodyAt + 4);
  return /\btransfer-encoding:\s*chunked/i.test(bytes.slice(0, bodyAt)) ? dechunk(body) : body;
}

/**
 * Undo HTTP/1.1 chunked transfer framing.
 *
 * A streaming response has no content-length, so Node frames each write as a
 * hex length, CRLF, the payload, CRLF. That framing is the transport's, not
 * Bee's, and `fetch` would strip it -- but this test reads a raw socket
 * precisely so it can assert on the exact SSE bytes underneath, so it has to
 * strip the framing itself rather than assert against it.
 */
function dechunk(raw: string): string {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const eol = raw.indexOf('\r\n', i);
    if (eol === -1) break;
    const size = parseInt(raw.slice(i, eol).split(';')[0]!.trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    out += raw.slice(eol + 2, eol + 2 + size);
    i = eol + 2 + size + 2;
  }
  return out;
}

describe("the emulator's stream through Bee's own SSE parser", () => {
  it('names every frame, so Bee\'s parser emits them instead of dropping them', async () => {
    const body = await captureStreamBytes('new-utterance', () => {
      sim.appendUtterance('10743', 'the checkout worker retries three times');
    });

    // The literal bytes carry an `event:` line. This is the assertion that
    // fails loudly if anyone reverts the emitter to `data:` alone.
    expect(body).toMatch(/^event: connected\r?\ndata: /);
    expect(body).toContain('event: new-utterance\n');

    const { parsed } = parseSSEBuffer(body);
    const names = parsed.map((e) => e.event);
    expect(names).toContain('connected');
    expect(names).toContain('new-utterance');

    const utterance = parsed.find((e) => e.event === 'new-utterance');
    expect(utterance).toBeDefined();
    const payload = JSON.parse(utterance!.data) as Record<string, unknown>;
    expect((payload.utterance as { text: string }).text).toBe('the checkout worker retries three times');
    expect((payload.utterance as { speaker: string }).speaker).toBe('speaker_1');
    expect(typeof payload.conversation_uuid).toBe('string');
  });

  it('produces frames the product classifies with no inference at all', async () => {
    const body = await captureStreamBytes('new-utterance', () => {
      sim.appendUtterance('10743', 'and it backs off five seconds between attempts');
    });

    const { parsed } = parseSSEBuffer(body);
    const events = parsed.map((e) => classifyEvent(JSON.parse(e.data), e.event));

    // Nothing was guessed: every frame arrived named, and every name was one
    // this build knows. `nameWasInferred` set anywhere here would mean the
    // product is reading Bee's stream the lossy way.
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.kind === 'new-utterance')).toBe(true);
    for (const e of events) {
      expect(e.nameWasInferred).toBeUndefined();
      expect(e.kind).not.toBe('unknown');
    }
  });

  it('round-trips every event type `bee stream` documents', async () => {
    // Payload shapes taken from `bee stream`'s own formatEvent switch.
    const samples: Record<string, unknown> = {
      'new-conversation': { conversation: { id: 1, uuid: 'u', state: 'NEW', title: 'Standup' } },
      'update-conversation': { conversation: { id: 1, state: 'PROCESSING', short_summary: 's' } },
      'update-conversation-summary': { conversation_id: 1, short_summary: 'Debugging the queue' },
      'delete-conversation': { conversation: { id: 1, title: 'Standup' } },
      'update-location': { location: { latitude: 48.58, longitude: 7.75, name: 'Office' }, conversation_id: 1 },
      'new-utterance': { utterance: { text: 'hello', speaker: 'speaker_1' }, conversation_uuid: 'u' },
      'todo-created': { todo: { id: 1, text: 'ship it', completed: false } },
      'todo-updated': { todo: { id: 1, text: 'ship it', completed: true } },
      'todo-deleted': { todo: { id: 1, text: 'ship it' } },
      'journal-created': { journal: { id: 1, state: 'READY', text: 'a memo' } },
      'journal-updated': { journal: { id: 1, state: 'READY', text: 'a memo' } },
      'journal-deleted': { journalId: 1, reason: 'user' },
      'journal-text': { journalId: 1, text: 'a memo' },
    };
    expect(Object.keys(samples).sort()).toEqual([...BEE_STREAM_EVENTS].sort());

    const body = await captureStreamBytes('all', () => {
      for (const [name, frame] of Object.entries(samples)) sim.emitEvent(name, frame);
    });

    const { parsed } = parseSSEBuffer(body);
    const seen = parsed.filter((e) => e.event !== 'connected');
    expect(seen.map((e) => e.event)).toEqual(Object.keys(samples));

    // And each one classifies as itself -- including the three whose payloads
    // are not disjoint and which a structural reader gets wrong.
    for (const e of seen) {
      const classified = classifyEvent(JSON.parse(e.data), e.event);
      expect(classified.kind).toBe(e.event);
      expect(classified.nameWasInferred).toBeUndefined();
    }
  });

  it("keeps a keep-alive comment from being read as a field", async () => {
    // Bee's parser treats a `:`-prefixed line as a comment. So must ours: a
    // naive field split would read the empty name before the colon as a field.
    const withPing = 'event: new-utterance\ndata: {"utterance":{"text":"x"}}\n\n: ping\n\n';
    const { parsed } = parseSSEBuffer(withPing);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.event).toBe('new-utterance');
  });
});

describe('the emulator\'s read endpoints', () => {
  it('answers /v1/conversations/:id/related, which reaches Bee through the proxy', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/conversations/10188/related`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<Record<string, unknown>> };
    expect(Array.isArray(body.conversations)).toBe(true);
    // `related` returns conversation records, not the {id, score} hits that
    // /v1/search/* returns. The client has to handle both, so the shapes are
    // pinned separately.
    for (const c of body.conversations) {
      expect(c.id).toBeDefined();
      expect(String(c.id)).not.toBe('10188');
    }
  });

  it('lets the client read related conversations with no CLI on the machine', async () => {
    // The regression this pins: `related()` used to return [] whenever the
    // `bee` binary was absent, so a proxy-only run -- a container, a judge's
    // laptop, the demo -- silently lost the capability rather than failing.
    const client = new BeeClient({ proxyUrl: `http://127.0.0.1:${port}`, allowCli: false });
    const related = await client.related('10188', 3);
    expect(related.length).toBeGreaterThan(0);
    expect(related.length).toBeLessThanOrEqual(3);
  });

  it('serves the endpoints the four Bee capabilities are built on', async () => {
    const base = `http://127.0.0.1:${port}`;
    const client = new BeeClient({ proxyUrl: base, allowCli: false });

    // RECONCILE: a cursor changefeed with next_cursor in meta.
    const changed = await client.changed();
    expect(typeof changed.meta.next_cursor).toBe('string');

    // RECALL: neural search over conversations, POST with a JSON body.
    const hits = await client.search('checkout retries', { neural: true, limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBeDefined();

    // CORRECT: facts create, then confirm.
    const fact = await client.createFact('Checkout retry attempts is 1 in production');
    expect(fact.id).toBeDefined();
    const confirmed = await client.updateFact(String(fact.id), { confirmed: true });
    expect(confirmed.confirmed).toBe(true);
  });
});
