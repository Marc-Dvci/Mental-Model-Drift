/**
 * Wire conformance: does bee-sim speak Bee?
 *
 * Every other test in this repo runs the product against `tools/bee-sim`. That
 * proves the product agrees with bee-sim, which is worth nothing unless
 * bee-sim agrees with Bee. This file is the bridge, and it does not take
 * anyone's word for the format:
 *
 *   1. `parseSSEBuffer` below is copied verbatim from `@beeai/cli` 0.7.3
 *      (`sources/commands/stream/index.ts`, MIT). It is the function `bee
 *      stream` itself uses to turn socket bytes into events.
 *   2. The test opens a raw socket to bee-sim, keeps the literal bytes it
 *      writes, and feeds them to that function.
 *   3. What comes back has to be the events that were sent, named.
 *
 * That is a stronger statement than "the shapes look right". Bee's parser only
 * emits an event once it has seen *both* an `event` field and a `data` field:
 * a frame written as `data:` alone is silently discarded, no error, no warning.
 * A test double with that bug looks perfect to a client that does the same thing
 * and produces nothing at all in front of Bee's own parser -- which is exactly the
 * failure this file exists to make impossible.
 *
 * The same applies to the read endpoints, whose shapes are pinned to the types
 * `@beeai/cli` declares for the API's answers: a conversation's words under
 * `transcriptions[]`, epoch-millisecond times, no uuid on the record, every
 * speaker "Unknown", and `/v1/changes` with bare ids and its cursor at the top
 * level. `/v1/conversations/:id/related` is reachable through `bee proxy`
 * because the proxy forwards every `/v1` path upstream rather than exposing a
 * route list, so bee-sim has to answer it too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Socket } from 'node:net';
import { BeeSim, streamUuid } from '../../tools/bee-sim/src/server.ts';
import { join } from 'node:path';
import { BEE_STREAM_EVENTS, BeeClient, classifyEvent, readChangeBatch } from '#bee';
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

describe("bee-sim's stream through Bee's own SSE parser", () => {
  it('names every frame, so Bee\'s parser emits them instead of dropping them', async () => {
    const body = await captureStreamBytes('new-utterance', () => {
      sim.appendUtterance('10695705', 'the checkout worker retries three times');
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
    const said = payload.utterance as Record<string, unknown>;
    expect(said.text).toBe('the checkout worker retries three times');
    // A live frame: its type repeated in the payload, the utterance's own id,
    // `spoken_at` as ISO 8601, recording offsets in seconds, and no speaker.
    expect(payload.type).toBe('new-utterance');
    expect(payload.conversation_uuid).toBe(streamUuid('10695705'));
    expect(typeof said.id).toBe('number');
    expect(String(said.id)).toMatch(/^\d{10}$/);
    expect(typeof said.sample_id).toBe('string');
    expect(said.spoken_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
    expect(typeof said.start).toBe('number');
    expect(said).not.toHaveProperty('speaker');
  });

  it('carries the type in the frame itself, so the CLI\'s --json lines classify without inference', async () => {
    // `bee stream --json` prints the `data:` line and nothing else. What it
    // prints is still named, by its own `type`.
    const body = await captureStreamBytes('new-utterance', () => {
      sim.appendUtterance('10695705', 'it backs off five seconds between attempts');
    });
    const { parsed } = parseSSEBuffer(body);
    const line = parsed.find((e) => e.event === 'new-utterance')!.data;
    const event = classifyEvent(JSON.parse(line));
    expect(event.kind).toBe('new-utterance');
    expect(event.nameWasInferred).toBeUndefined();
    if (event.kind !== 'new-utterance') throw new Error('unreachable');
    expect(event.utteranceId).toMatch(/^\d{10}$/);
    expect(event.spokenAt).toBeDefined();
  });

  it('produces frames the product classifies with no inference at all', async () => {
    const body = await captureStreamBytes('new-utterance', () => {
      sim.appendUtterance('10695705', 'and it backs off five seconds between attempts');
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
    // Payload shapes taken from `bee stream`'s own formatEvent switch, and for
    // `new-utterance` the live frame's.
    const samples: Record<string, unknown> = {
      'new-conversation': { conversation: { id: 1, uuid: 'u', state: 'NEW', title: 'Standup' } },
      'update-conversation': { conversation: { id: 1, state: 'PROCESSING', short_summary: 's' } },
      'update-conversation-summary': { conversation_id: 1, short_summary: 'Debugging the queue' },
      'delete-conversation': { conversation: { id: 1, title: 'Standup' } },
      'update-location': { location: { latitude: 48.58, longitude: 7.75, name: 'Office' }, conversation_id: 1 },
      'new-utterance': {
        type: 'new-utterance',
        conversation_uuid: 'u',
        utterance: { id: 3766760407, sample_id: 's', start: 680.16, end: 691.36, text: 'hello', spoken_at: '2026-10-16T18:05:13.000Z' },
      },
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

describe('bee-sim\'s read endpoints', () => {
  it('answers /v1/conversations/:id/related, which reaches Bee through the proxy', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/conversations/10009909/related`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<Record<string, unknown>> };
    expect(Array.isArray(body.conversations)).toBe(true);
    // `related` returns conversation records, not the {id, score} hits that
    // /v1/search/* returns. The client has to handle both, so the shapes are
    // pinned separately.
    for (const c of body.conversations) {
      expect(c.id).toBeDefined();
      expect(String(c.id)).not.toBe('10009909');
    }
  });

  it('lets the client read related conversations with no CLI on the machine', async () => {
    // The regression this pins: `related()` used to return [] whenever the
    // `bee` binary was absent, so a proxy-only run -- a container, a judge's
    // laptop, the demo -- silently lost the capability rather than failing.
    const client = new BeeClient({ proxyUrl: `http://127.0.0.1:${port}`, allowCli: false });
    const related = await client.related('10009909', 3);
    expect(related.length).toBeGreaterThan(0);
    expect(related.length).toBeLessThanOrEqual(3);
  });

  it('serves the endpoints the four Bee capabilities are built on', async () => {
    const base = `http://127.0.0.1:${port}`;
    const client = new BeeClient({ proxyUrl: base, allowCli: false });

    // RECONCILE: a cursor changefeed, read into one batch.
    const changed = await client.changed();
    expect(changed.nextCursor).toMatch(/^v1-\d{13}$/);

    // RECALL: neural search over conversations, POST with a JSON body. Neural
    // hits are conversations: numeric ids and epoch-ms `started_at`.
    const hits = await client.search('checkout retries', { neural: true, limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(typeof hits[0]!.id).toBe('number');
    expect(typeof hits[0]!.started_at).toBe('number');

    // CORRECT: facts create, then confirm. A new fact starts unconfirmed.
    const fact = await client.createFact('Checkout retry attempts is 1 in production');
    expect(fact.id).toBeDefined();
    expect(fact.confirmed).toBe(false);
    const confirmed = await client.updateFact(String(fact.id), { confirmed: true });
    expect(confirmed.confirmed).toBe(true);
  });

  it('answers a conversation read in the API\'s shape', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/conversations/10009909`);
    const body = (await res.json()) as { conversation: Record<string, unknown>; timezone: string };
    const c = body.conversation;
    expect(typeof body.timezone).toBe('string');
    expect(c.id).toBe(10009909);
    expect(c).not.toHaveProperty('uuid');
    expect(c).not.toHaveProperty('utterances');
    expect(c.state).toBe('COMPLETED');
    for (const key of ['start_time', 'end_time', 'created_at', 'updated_at']) expect(typeof c[key]).toBe('number');
    // Not on whole minutes: these are real clock readings, not a schedule.
    expect((c.start_time as number) % 60_000).not.toBe(0);

    const [transcription] = c.transcriptions as { id: number; realtime: boolean; utterances: Record<string, unknown>[] }[];
    expect(transcription!.realtime).toBe(false);
    for (const u of transcription!.utterances) {
      expect(String(u.id)).toMatch(/^\d{10}$/);
      expect(u.speaker).toBe('Unknown');
      expect(typeof u.spoken_at).toBe('number');
      expect(u.start as number).toBeLessThan(3600); // seconds into the recording
    }
  });

  it('reads the transcript out of transcriptions[], not out of a flat list', async () => {
    const client = new BeeClient({ proxyUrl: `http://127.0.0.1:${port}`, allowCli: false });
    const words = await client.transcript('10009909');
    expect(words.length).toBe(8);
    expect(words[0]!.text).toMatch(/first day on the checkout queue/);
  });

  it('answers /v1/changes with bare ids and the cursor at the top level', async () => {
    sim.appendUtterance('10039701', 'and the queue depth alarm fires at five hundred');
    const body = (await (await fetch(`http://127.0.0.1:${port}/v1/changes`)).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('meta');
    expect(typeof body.next_cursor).toBe('string');
    expect(typeof body.since).toBe('number');
    expect(body.conversations).toContain(10039701);
    for (const key of ['facts', 'todos', 'dailies', 'journals']) expect(Array.isArray(body[key])).toBe(true);
  });

  it('reads both changefeed shapes: the API\'s, and the one `bee changed --json` prints', () => {
    const api = readChangeBatch({
      facts: [], conversations: [11331219], dailies: [], journals: [], todos: [],
      next_cursor: 'v1-1760610000000', since: 1760523600000, until: 1760610000000, updated: true, timezone: 'Europe/Paris',
    });
    expect(api).toMatchObject({ nextCursor: 'v1-1760610000000', conversationIds: ['11331219'], conversations: [] });

    const cli = readChangeBatch({
      meta: { cursor: undefined, next_cursor: 'v1-1760610000000', since: 1760523600000, until: 1760610000000, updated: true, timezone: 'Europe/Paris' },
      facts: [], todos: [], dailies: [], journals: [],
      conversations: [{ id: 11331219, state: 'CAPTURING', transcriptions: [] }],
    });
    expect(cli.nextCursor).toBe('v1-1760610000000');
    expect(cli.conversationIds).toEqual(['11331219']);
    expect(cli.conversations).toHaveLength(1);
  });
});

describe('joining a live frame to its conversation', () => {
  it('finds the conversation by the utterance id, since no record carries the uuid', async () => {
    const body = await captureStreamBytes('new-utterance', () => {
      sim.appendUtterance('10697402', 'the worker drains the queue before a deploy');
    });
    const { parsed } = parseSSEBuffer(body);
    const event = classifyEvent(JSON.parse(parsed.find((e) => e.event === 'new-utterance')!.data));
    if (event.kind !== 'new-utterance') throw new Error('unreachable');

    // The record is CAPTURING now, and its realtime transcription holds the
    // utterance under the id the frame carried.
    const read = (await (await fetch(`http://127.0.0.1:${port}/v1/conversations/10697402`)).json()) as {
      conversation: { state: string; transcriptions: { realtime: boolean; utterances: { id: number }[] }[] };
    };
    expect(read.conversation.state).toBe('CAPTURING');
    expect(read.conversation.transcriptions[0]!.realtime).toBe(true);
    expect(read.conversation.transcriptions[0]!.utterances.map((u) => String(u.id))).toContain(event.utteranceId);

    const client = new BeeClient({ proxyUrl: `http://127.0.0.1:${port}`, allowCli: false });
    expect(await client.resolveConversationId({ uuid: event.conversationUuid!, utteranceId: event.utteranceId! })).toBe('10697402');
  });

  it('reads the final transcription once Bee has processed the conversation', async () => {
    const client = new BeeClient({ proxyUrl: `http://127.0.0.1:${port}`, allowCli: false });
    const live = await client.transcript('10697402');
    sim.completeConversation('10697402');
    const final = await client.transcript('10697402');

    // Same words, new ids: the realtime ids do not survive processing, which
    // is why dedupe across the two paths keys on content.
    expect(final.map((u) => u.text)).toEqual(live.map((u) => u.text));
    expect(final.every((u) => u.realtime === false)).toBe(true);
    const liveIds = new Set(live.map((u) => u.id));
    expect(final.some((u) => liveIds.has(u.id))).toBe(false);
  });
});
