/**
 * bee-sim -- a local stand-in for `bee proxy`.
 *
 * WHAT THIS IS AND IS NOT
 *
 * Mental Model Drift talks to Bee through one client, over `/v1/*` on the local
 * proxy: the SSE stream, the cursor changefeed, conversation reads, neural
 * search and facts. This simulator implements that same surface over fixture
 * conversations, so the whole product can be developed and tested without a
 * device on the table -- and so the reliability behaviour that matters can be
 * *provoked* on demand rather than waited for.
 *
 * It is not a reimplementation of Bee. It has no transcription, no diarisation,
 * no fact extraction, and its "neural" search is token overlap with IDF
 * weighting rather than an embedding model. Nothing in the product depends on
 * any of that; it depends only on the wire format and the response shapes.
 *
 * Which is why those are not merely believed. `tests/conformance/bee-wire.test.ts`
 * reads this server's literal socket bytes and parses them with `parseSSEBuffer`
 * copied verbatim out of `@beeai/cli`, so the format is checked against Bee's
 * own code rather than against a careful reading of the documentation. That test
 * has already caught two defects here that every other test agreed with: frames
 * written with no `event:` line, which Bee's parser silently discards, and the
 * `all` wildcard treated as a literal event name.
 *
 * Point BEE_PROXY_URL at a real `bee proxy` instead and every code path is the
 * same one.
 *
 * The controls under /_sim exist for the parts that are otherwise untestable:
 *
 *   POST /_sim/play      replay a conversation into the live stream, paced
 *   POST /_sim/network   cut the stream while leaving the changefeed intact,
 *                        which is exactly Bee's documented at-most-once failure
 *   POST /_sim/append    add an utterance, optionally without streaming it
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface SimUtterance {
  speaker?: string;
  text: string;
  created_at?: string;
}

interface SimConversation {
  id: number | string;
  uuid?: string;
  short_summary?: string;
  state?: string;
  start_time?: string;
  end_time?: string;
  created_at?: string;
  utterances: SimUtterance[];
  /** How many utterances currently exist as far as any API is concerned. */
  revealed: number;
  changedAt: number;
}

interface SimFact {
  id: number | string;
  text: string;
  confirmed?: boolean;
  created_at?: string;
}

export interface BeeSimOptions {
  port?: number;
  fixtureDir?: string;
  /** Conversations that start empty and are revealed by /_sim/play. */
  liveConversationIds?: (string | number)[];
  token?: string;
  log?: (line: string) => void;
}

export class BeeSim {
  private conversations = new Map<string, SimConversation>();
  private facts: SimFact[] = [];
  private clients = new Set<ServerResponse>();
  private networkUp = true;
  private nextFactId = 9000;
  private server?: Server;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: BeeSimOptions = {}) {
    this.log = opts.log ?? ((l) => console.log(l));
    this.load();
  }

  private load(): void {
    const dir = this.opts.fixtureDir ?? join(process.cwd(), 'demo', 'conversations');
    const live = new Set((this.opts.liveConversationIds ?? []).map(String));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown;
      if (file === 'demo-facts.json') {
        this.facts = raw as SimFact[];
        continue;
      }
      const c = raw as SimConversation;
      const isLive = live.has(String(c.id));
      this.conversations.set(String(c.id), {
        ...c,
        revealed: isLive ? 0 : c.utterances.length,
        changedAt: Date.parse(c.created_at ?? c.start_time ?? '') || Date.now(),
      });
    }
  }

  // ------------------------------------------------------------------ server

  /** Resolves the port actually bound, which is not the requested one when 0
   *  was asked for -- the golden scenarios rely on that to run in parallel. */
  listen(): Promise<number> {
    const requested = this.opts.port ?? 8787;
    this.server = createServer((req, res) => {
      void this.route(req, res).catch((err: Error) => {
        json(res, 500, { error: err.message });
      });
    });
    return new Promise((resolve) => {
      this.server!.listen(requested, '127.0.0.1', () => {
        const address = this.server!.address();
        resolve(typeof address === 'object' && address ? address.port : requested);
      });
    });
  }

  async close(): Promise<void> {
    for (const c of this.clients) c.end();
    this.clients.clear();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (this.opts.token) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${this.opts.token}` && !path.startsWith('/_sim')) {
        return json(res, 401, { error: 'unauthorized' });
      }
    }

    if (path === '/v1/me') return json(res, 200, this.me());
    if (path === '/v1/changes') return json(res, 200, this.changes(url.searchParams.get('cursor')));
    if (path === '/v1/conversations' && method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      return json(res, 200, { conversations: this.listConversations().slice(0, limit).map((c) => publicConversation(c)) });
    }
    const convoMatch = /^\/v1\/conversations\/([^/]+)$/.exec(path);
    if (convoMatch && method === 'GET') {
      const c = this.conversations.get(convoMatch[1]!);
      if (!c || c.revealed === 0) return json(res, 404, { error: 'not found' });
      return json(res, 200, publicConversation(c, true));
    }
    // Reachable through `bee proxy` as well as through `bee conversations
    // related`: the proxy forwards every /v1 path rather than exposing a route
    // list, so the endpoint behind the subcommand is the endpoint here.
    const relatedMatch = /^\/v1\/conversations\/([^/]+)\/related$/.exec(path);
    if (relatedMatch && method === 'GET') {
      const c = this.conversations.get(relatedMatch[1]!);
      if (!c || c.revealed === 0) return json(res, 404, { error: 'not found' });
      return json(res, 200, { conversations: this.relatedTo(c) });
    }
    if (path === '/v1/search/conversations' && method === 'POST') {
      const body = await readJson<{ query: string; limit?: number; since?: number }>(req);
      return json(res, 200, { results: this.search(body.query, body.limit ?? 20, false, body.since) });
    }
    if (path === '/v1/search/conversations/neural' && method === 'POST') {
      const body = await readJson<{ query: string; limit?: number }>(req);
      return json(res, 200, { results: this.search(body.query, body.limit ?? 20, true) });
    }
    if (path === '/v1/facts' && method === 'GET') return json(res, 200, { facts: this.facts });
    if (path === '/v1/facts' && method === 'POST') {
      const body = await readJson<{ text: string }>(req);
      const fact: SimFact = { id: this.nextFactId++, text: body.text, confirmed: false, created_at: new Date().toISOString() };
      this.facts.push(fact);
      this.log(`[bee-sim] fact created: ${body.text}`);
      return json(res, 201, { fact });
    }
    const factMatch = /^\/v1\/facts\/([^/]+)$/.exec(path);
    if (factMatch && method === 'PUT') {
      const body = await readJson<{ text?: string; confirmed?: boolean }>(req);
      const fact = this.facts.find((f) => String(f.id) === factMatch[1]);
      if (!fact) return json(res, 404, { error: 'not found' });
      if (body.text !== undefined) fact.text = body.text;
      if (body.confirmed !== undefined) fact.confirmed = body.confirmed;
      this.log(`[bee-sim] fact ${fact.id} updated (confirmed=${fact.confirmed})`);
      return json(res, 200, { fact });
    }
    if (path === '/v1/stream') return this.stream(req, res, (url.searchParams.get('types') ?? '').split(',').filter(Boolean));

    // ------------------------------------------------------------ simulator
    if (path === '/_sim/state') {
      return json(res, 200, {
        networkUp: this.networkUp,
        subscribers: this.clients.size,
        conversations: [...this.conversations.values()].map((c) => ({
          id: c.id, revealed: c.revealed, total: c.utterances.length, changedAt: new Date(c.changedAt).toISOString(),
        })),
        facts: this.facts.length,
      });
    }
    if (path === '/_sim/network' && method === 'POST') {
      const body = await readJson<{ up: boolean }>(req);
      this.networkUp = body.up;
      if (!this.networkUp) {
        for (const c of this.clients) c.end();
        this.clients.clear();
      }
      this.log(`[bee-sim] stream ${this.networkUp ? 'restored' : 'cut'}`);
      return json(res, 200, { networkUp: this.networkUp });
    }
    if (path === '/_sim/play' && method === 'POST') {
      const body = await readJson<{ conversationId: string; speedMs?: number; count?: number }>(req);
      const played = await this.play(body.conversationId, body.speedMs ?? 1200, body.count);
      return json(res, 200, { played });
    }
    if (path === '/_sim/append' && method === 'POST') {
      const body = await readJson<{ conversationId: string; text: string; speaker?: string; stream?: boolean }>(req);
      const ok = this.append(body.conversationId, body.text, body.speaker ?? 'speaker_1', body.stream ?? true);
      return json(res, ok ? 200 : 404, { ok });
    }

    return json(res, 404, { error: `no route for ${method} ${path}` });
  }

  // -------------------------------------------------------------------- data

  private me() {
    return { id: 1, name: 'Bee owner (simulated)', email: 'owner@example.invalid', timezone: 'Europe/Paris' };
  }

  private listConversations(): SimConversation[] {
    return [...this.conversations.values()]
      .filter((c) => c.revealed > 0)
      .sort((a, b) => b.changedAt - a.changedAt);
  }

  /**
   * `GET /v1/changes` -- the reliable path.
   *
   * Note what this deliberately does *not* consult: whether the stream was up.
   * The changefeed is the source of record and returns everything that changed
   * in the window regardless of what any subscriber saw, which is the property
   * the reconciliation worker depends on.
   */
  private changes(cursor: string | null) {
    const now = Date.now();
    const since = cursor ? Number(cursor.replace(/^v1-/, '')) : now - 24 * 3600 * 1000;
    const changed = [...this.conversations.values()].filter((c) => c.revealed > 0 && c.changedAt > since);
    return {
      meta: {
        next_cursor: `v1-${now}`,
        since,
        until: now,
        updated: changed.length > 0,
        timezone: 'Europe/Paris',
      },
      facts: [],
      todos: [],
      dailies: [],
      journals: [],
      conversations: changed.map((c) => publicConversation(c, true)),
    };
  }

  /**
   * Search.
   *
   * `neural: true` here is IDF-weighted token overlap, not an embedding model.
   * It is enough to exercise the caller's behaviour -- a query built from
   * registry vocabulary finds conversations phrased differently -- and it is
   * named honestly rather than dressed up.
   */
  private search(query: string, limit: number, neural: boolean, since?: number) {
    const convos = this.listConversations().filter((c) => (since ? c.changedAt >= since : true));
    const qTokens = tokens(query);
    if (qTokens.length === 0) return [];

    const df = new Map<string, number>();
    for (const c of convos) {
      for (const t of new Set(tokens(conversationText(c)))) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const n = Math.max(1, convos.length);

    const scored = convos.map((c) => {
      const docTokens = new Set(tokens(conversationText(c)));
      let score = 0;
      for (const t of new Set(qTokens)) {
        if (!docTokens.has(t)) continue;
        score += neural ? Math.log(1 + n / (1 + (df.get(t) ?? 0))) : 1;
      }
      return { c, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ c, score }) => ({
        id: c.id,
        type: 'conversation',
        score: Number(score.toFixed(3)),
        short_summary: c.short_summary,
        created_at: c.created_at,
        start_time: c.start_time,
      }));
  }

  /**
   * `GET /v1/conversations/:id/related`.
   *
   * Bee computes these server-side from AI-extracted keywords and persists
   * them; this ranks other conversations by IDF-weighted overlap with the
   * subject's own text, which produces the same *shape* of answer -- a ranked
   * `conversations` array -- from the same input. Note it returns conversation
   * records, not the `{id, score}` hits `/v1/search/*` returns; that difference
   * is real and the client has to handle both.
   */
  private relatedTo(subject: SimConversation) {
    const others = this.listConversations().filter((c) => String(c.id) !== String(subject.id));
    const seed = new Set(tokens(conversationText(subject)));
    if (seed.size === 0) return [];

    const df = new Map<string, number>();
    for (const c of others) {
      for (const t of new Set(tokens(conversationText(c)))) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const n = Math.max(1, others.length);

    return others
      .map((c) => {
        const docTokens = new Set(tokens(conversationText(c)));
        let score = 0;
        for (const t of seed) {
          if (docTokens.has(t)) score += Math.log(1 + n / (1 + (df.get(t) ?? 0)));
        }
        return { c, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(({ c }) => publicConversation(c));
  }

  // ------------------------------------------------------------------ stream

  private stream(req: IncomingMessage, res: ServerResponse, types: string[]): void {
    if (!this.networkUp) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'stream unavailable' }));
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    (res as ServerResponse & { simTypes?: string[] }).simTypes = types;
    this.emitTo(res, { connected: true, types }, 'connected');
    this.clients.add(res);
    this.log(`[bee-sim] subscriber connected (${this.clients.size} total)`);
    req.on('close', () => {
      this.clients.delete(res);
      this.log(`[bee-sim] subscriber disconnected (${this.clients.size} left)`);
    });
  }

  /**
   * Write one frame in Bee's wire format.
   *
   * The `event:` line is the frame's type and is not optional: `bee stream`'s
   * SSE parser only emits an event once it has seen both an `event` field and a
   * `data` field, so a frame written as `data:` alone is silently dropped by
   * Bee's own client. Emitting it here is what lets `tests/conformance` run
   * this simulator's bytes through that parser and get the frames back.
   */
  private emitTo(client: ServerResponse, frame: unknown, type: string): void {
    client.write(`event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`);
  }

  private emit(frame: unknown, type: string): void {
    if (!this.networkUp) return;
    for (const client of this.clients) {
      const wanted = (client as ServerResponse & { simTypes?: string[] }).simTypes;
      // `all` is Bee's wildcard, not an event name: `bee stream --types all`
      // omits the query parameter entirely and subscribes to everything.
      const filtered = wanted && wanted.length > 0 && !wanted.includes('all');
      if (filtered && !wanted!.includes(type)) continue;
      this.emitTo(client, frame, type);
    }
  }

  private append(conversationId: string, text: string, speaker: string, stream: boolean): boolean {
    const c = this.conversations.get(conversationId);
    if (!c) return false;
    c.utterances.splice(c.revealed, 0, { speaker, text, created_at: new Date().toISOString() });
    c.revealed++;
    c.changedAt = Date.now();
    if (stream) this.emitUtterance(c, { speaker, text });
    return true;
  }

  private emitUtterance(c: SimConversation, u: SimUtterance): void {
    // The payload `bee stream` reads for this event type: an `utterance` object
    // carrying `text` and `speaker`, and a top-level `conversation_uuid`.
    this.emit(
      { utterance: { text: u.text, speaker: u.speaker ?? 'speaker_1' }, conversation_uuid: c.uuid ?? String(c.id) },
      'new-utterance',
    );
  }

  /**
   * The other event types, in the shapes `bee stream`'s formatter reads them.
   *
   * Nothing in the product subscribes to these -- it asks for `new-utterance`
   * and nothing else -- but the simulator emits them on demand so the
   * conformance tests can prove the client classifies the whole documented
   * event set, including the three types whose payloads a structural reader
   * gets wrong.
   */
  emitEvent(type: string, frame: unknown): void {
    this.emit(frame, type);
  }

  /** Speak one utterance into a conversation, as `POST /_sim/append` does. */
  appendUtterance(conversationId: string, text: string, speaker = 'speaker_1'): boolean {
    return this.append(conversationId, text, speaker, true);
  }

  private async play(conversationId: string, speedMs: number, count?: number): Promise<number> {
    const c = this.conversations.get(conversationId);
    if (!c) return 0;
    const target = count === undefined ? c.utterances.length : Math.min(c.utterances.length, c.revealed + count);
    let played = 0;
    while (c.revealed < target) {
      const u = c.utterances[c.revealed]!;
      c.revealed++;
      c.changedAt = Date.now();
      this.emitUtterance(c, u);
      this.log(`[bee-sim] ${this.networkUp ? 'streamed' : 'recorded (stream down)'}: ${u.text}`);
      played++;
      if (c.revealed < target) await sleep(speedMs);
    }
    return played;
  }
}

// -------------------------------------------------------------------- helpers

function publicConversation(c: SimConversation, withUtterances = false) {
  const base = {
    id: c.id,
    uuid: c.uuid,
    short_summary: c.short_summary,
    state: c.state,
    start_time: c.start_time,
    end_time: c.end_time,
    created_at: c.created_at,
  };
  return withUtterances ? { ...base, utterances: c.utterances.slice(0, c.revealed) } : base;
}

function conversationText(c: SimConversation): string {
  return [c.short_summary ?? '', ...c.utterances.slice(0, c.revealed).map((u) => u.text)].join(' ');
}

const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'it', 'to', 'of', 'and', 'in', 'on', 'for', 'that', 'this', 'we', 'i', 'so', 'was', 'are']);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
