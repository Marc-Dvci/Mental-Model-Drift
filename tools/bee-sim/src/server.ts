/**
 * bee-sim -- protocol test proxy for `bee proxy`.
 *
 * Mental Model Drift talks to Bee through one client, over `/v1/*` on the
 * proxy: the SSE stream, the cursor changefeed, conversation reads, neural
 * search and facts. This test proxy implements that same surface over the
 * conversations in `demo/conversations`, so the test suite can run
 * deterministically on any machine with nothing else up -- and so the
 * reliability behaviour that matters can be tested on demand rather than
 * waited for.
 *
 * It is not a reimplementation of Bee. It has no transcription, no diarisation,
 * no fact extraction, and its "neural" search is token overlap with IDF
 * weighting rather than an embedding model. Nothing in the product depends on
 * any of that; it depends only on the wire format and the response shapes,
 * and those are Bee's:
 *
 *   - every time is epoch milliseconds, except a live frame's `spoken_at`;
 *   - a conversation's words sit under `transcriptions[]`, a realtime one while
 *     it is being captured and a final one once it is processed, each with its
 *     own utterance ids, and every speaker is "Unknown";
 *   - a conversation record has a numeric id and no uuid; the uuid exists only
 *     on the stream, and the utterance id is what joins the two;
 *   - `/v1/changes` returns bare ids with `next_cursor` at the top level;
 *   - a live frame names its type twice, in the SSE `event:` line and in its
 *     own `type` field, and carries the utterance's id and `spoken_at`.
 *
 * `tests/conformance/bee-wire.test.ts` reads this server's literal socket bytes
 * and parses them with `parseSSEBuffer` copied verbatim out of `@beeai/cli`, so
 * the framing is checked against Bee's own code rather than against a careful
 * reading of the documentation.
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
 *   POST /_sim/complete  finish processing: the final transcription replaces
 *                        the realtime one
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface SimUtterance {
  text: string;
  speaker: string;
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  /** Epoch ms. */
  spokenAt: number;
  /** Its id in the realtime transcription, the one a live frame carries. */
  realtimeId?: number;
  /** Its id in the final transcription, once the conversation is processed. */
  finalId?: number;
  createdAt: number;
}

/** A conversation as `GET /v1/conversations/:id` returns it, before transcriptions are attached. */
interface ConversationRecord {
  id: number;
  start_time: number;
  end_time: number | null;
  summary: string | null;
  short_summary: string | null;
  state: string;
  created_at: number;
  updated_at: number;
  suggested_links: unknown[];
  primary_location: unknown;
}

interface SimConversation {
  record: ConversationRecord;
  /** Known only to the stream, never to a read endpoint. */
  uuid: string;
  utterances: SimUtterance[];
  realtimeTranscriptionId: number;
  finalTranscriptionId: number;
  /** How many utterances currently exist as far as any API is concerned. */
  revealed: number;
  /** Played into the stream rather than loaded as history. */
  live: boolean;
  changedAt: number;
}

interface SimFact {
  id: number;
  text: string;
  tags: string[];
  created_at: number;
  confirmed: boolean;
}

/** What a demo conversation file holds: a `GET /v1/conversations/:id` body. */
interface FixtureFile {
  conversation: ConversationRecord & {
    transcriptions: { id: number; realtime: boolean; utterances: { id: number; start: number; end: number; spoken_at: number; text: string; speaker: string; created_at: number }[] }[];
  };
  timezone: string;
}

export interface BeeSimOptions {
  port?: number;
  fixtureDir?: string;
  /** Conversations that start empty and are revealed by /_sim/play. */
  liveConversationIds?: (string | number)[];
  token?: string;
  log?: (line: string) => void;
}

const TIMEZONE = 'Europe/Paris';

/**
 * The uuid a live frame carries for a conversation. Derived from the id, so a
 * test can name it without asking the server; nothing else can learn it,
 * because no read endpoint returns it.
 */
export function streamUuid(conversationId: string | number): string {
  return uuidFrom(`conversation:${conversationId}`);
}

export class BeeSim {
  private conversations = new Map<string, SimConversation>();
  private facts: SimFact[] = [];
  private clients = new Set<ServerResponse>();
  private networkUp = true;
  private nextFactId = 1_841_200;
  // Utterance ids are global and grow with time; this starts where a live id
  // would be now (3766760407 was live at 2026-10-16T18:05:13Z).
  private nextUtteranceId = Math.round(3_766_760_407 + ((Date.now() - Date.parse('2026-10-16T18:05:13Z')) / 1000) * 23);
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
      const { conversation: c } = raw as FixtureFile;
      const final = c.transcriptions.find((t) => !t.realtime) ?? c.transcriptions[0]!;
      const { transcriptions: _omit, ...record } = c;
      const isLive = live.has(String(c.id));
      this.conversations.set(String(c.id), {
        record: { ...record },
        uuid: streamUuid(c.id),
        utterances: final.utterances.map((u) => ({
          text: u.text,
          speaker: u.speaker,
          start: u.start,
          end: u.end,
          spokenAt: u.spoken_at,
          ...(isLive ? {} : { finalId: u.id }),
          createdAt: u.created_at,
        })),
        realtimeTranscriptionId: final.id - 1,
        finalTranscriptionId: final.id,
        revealed: isLive ? 0 : final.utterances.length,
        live: isLive,
        changedAt: c.updated_at,
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

    if (path === '/v1/me') return json(res, 200, { id: 48211, first_name: 'Bee', last_name: 'Owner', timezone: TIMEZONE });
    if (path === '/v1/changes') return json(res, 200, this.changes(url.searchParams.get('cursor')));
    if (path === '/v1/conversations' && method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? 20);
      return json(res, 200, {
        conversations: this.listConversations().slice(0, limit).map((c) => listRecord(c)),
        next_cursor: null,
        timezone: TIMEZONE,
      });
    }
    const convoMatch = /^\/v1\/conversations\/([^/]+)$/.exec(path);
    if (convoMatch && method === 'GET') {
      const c = this.conversations.get(convoMatch[1]!);
      if (!c || c.revealed === 0) return json(res, 404, { error: 'not found' });
      return json(res, 200, { conversation: this.fullRecord(c), timezone: TIMEZONE });
    }
    // Reachable through `bee proxy` as well as through `bee conversations
    // related`: the proxy forwards every /v1 path rather than exposing a route
    // list, so the endpoint behind the subcommand is the endpoint here.
    const relatedMatch = /^\/v1\/conversations\/([^/]+)\/related$/.exec(path);
    if (relatedMatch && method === 'GET') {
      const c = this.conversations.get(relatedMatch[1]!);
      if (!c || c.revealed === 0) return json(res, 404, { error: 'not found' });
      return json(res, 200, { conversations: this.relatedTo(c), timezone: TIMEZONE });
    }
    if (path === '/v1/search/conversations' && method === 'POST') {
      const body = await readJson<{ query: string; limit?: number; since?: number; until?: number }>(req);
      return json(res, 200, this.keywordSearch(body.query, body.limit ?? 20, body.since, body.until));
    }
    if (path === '/v1/search/conversations/neural' && method === 'POST') {
      const body = await readJson<{ query: string; limit?: number; since?: number; until?: number }>(req);
      return json(res, 200, this.neuralSearch(body.query, body.limit ?? 20, body.since, body.until));
    }
    if (path === '/v1/facts' && method === 'GET') {
      // `confirmed=true|false` filters; omitted, both kinds come back.
      const confirmed = url.searchParams.get('confirmed');
      const facts = confirmed === null ? this.facts : this.facts.filter((f) => f.confirmed === (confirmed === 'true'));
      return json(res, 200, { facts, next_cursor: null, timezone: TIMEZONE });
    }
    if (path === '/v1/facts' && method === 'POST') {
      const body = await readJson<{ text: string }>(req);
      const fact: SimFact = { id: this.nextFactId++, text: body.text, tags: [], created_at: Date.now(), confirmed: false };
      this.facts.push(fact);
      this.log(`[bee-sim] fact created: ${body.text}`);
      return json(res, 200, fact);
    }
    const factMatch = /^\/v1\/facts\/([^/]+)$/.exec(path);
    if (factMatch && method === 'PUT') {
      const body = await readJson<{ text?: string; confirmed?: boolean }>(req);
      const fact = this.facts.find((f) => String(f.id) === factMatch[1]);
      if (!fact) return json(res, 404, { error: 'not found' });
      if (body.text !== undefined) fact.text = body.text;
      if (body.confirmed !== undefined) fact.confirmed = body.confirmed;
      this.log(`[bee-sim] fact ${fact.id} updated (confirmed=${fact.confirmed})`);
      return json(res, 200, fact);
    }
    if (path === '/v1/stream') return this.stream(req, res, (url.searchParams.get('types') ?? '').split(',').filter(Boolean));

    // ------------------------------------------------------------ local controls
    if (path === '/_sim/state') {
      return json(res, 200, {
        networkUp: this.networkUp,
        subscribers: this.clients.size,
        conversations: [...this.conversations.values()].map((c) => ({
          id: c.record.id, state: c.record.state, revealed: c.revealed, total: c.utterances.length, changedAt: new Date(c.changedAt).toISOString(),
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
      const body = await readJson<{ conversationId: string; text: string; stream?: boolean }>(req);
      const ok = this.append(body.conversationId, body.text, body.stream ?? true);
      return json(res, ok ? 200 : 404, { ok });
    }
    if (path === '/_sim/complete' && method === 'POST') {
      const body = await readJson<{ conversationId: string }>(req);
      const ok = this.complete(body.conversationId);
      return json(res, ok ? 200 : 404, { ok });
    }

    return json(res, 404, { error: `no route for ${method} ${path}` });
  }

  // -------------------------------------------------------------------- data

  /** Newest first, by start time, as the API lists them. */
  private listConversations(): SimConversation[] {
    return [...this.conversations.values()]
      .filter((c) => c.revealed > 0)
      .sort((a, b) => b.record.start_time - a.record.start_time);
  }

  /**
   * The record with its transcription: the realtime one while the
   * conversation is being captured, the final one once it is processed.
   */
  private fullRecord(c: SimConversation) {
    const capturing = c.record.state !== 'COMPLETED';
    const utterances = c.utterances.slice(0, c.revealed).map((u) => ({
      id: (capturing ? u.realtimeId : u.finalId)!,
      realtime: capturing,
      start: u.start,
      end: u.end,
      spoken_at: u.spokenAt,
      text: u.text,
      speaker: u.speaker,
      created_at: u.createdAt,
    }));
    return {
      ...c.record,
      transcriptions: [
        { id: capturing ? c.realtimeTranscriptionId : c.finalTranscriptionId, realtime: capturing, utterances },
      ],
    };
  }

  /**
   * `GET /v1/changes` -- the reliable path.
   *
   * Note what this deliberately does *not* consult: whether the stream was up.
   * The changefeed is the source of record and returns everything that changed
   * in the window regardless of what any subscriber saw, which is the property
   * the reconciliation worker depends on. With no cursor it opens a 24-hour
   * window, and the next cursor is the end of this one.
   */
  private changes(cursor: string | null) {
    const until = Date.now();
    const since = cursor ? Number(cursor.replace(/^v1-/, '')) : until - 24 * 3600 * 1000;
    const changed = [...this.conversations.values()].filter((c) => c.revealed > 0 && c.changedAt > since);
    return {
      facts: [],
      conversations: changed.map((c) => c.record.id),
      dailies: [],
      journals: [],
      todos: [],
      next_cursor: `v1-${until}`,
      since,
      until,
      updated: changed.length > 0,
      timezone: TIMEZONE,
    };
  }

  /**
   * Neural search: conversations only, ranked by IDF-weighted token overlap
   * rather than an embedding model. It is enough to exercise the caller's
   * behaviour -- a query built from registry vocabulary finds conversations
   * phrased differently -- and it is named honestly rather than dressed up.
   */
  private neuralSearch(query: string, limit: number, since?: number, until?: number) {
    const results = this.rank(query, true, since, until)
      .slice(0, limit)
      .map(({ c }) => ({
        id: c.record.id,
        started_at: c.record.start_time,
        stopped_at: c.record.end_time,
        locations: [],
        short_summary: c.record.short_summary,
        detailed_summary: c.record.summary,
      }));
    return { results, total: results.length, timezone: TIMEZONE };
  }

  /** Keyword search: string ids, a `type` per hit, and `created_at`. */
  private keywordSearch(query: string, limit: number, since?: number, until?: number) {
    const results = this.rank(query, false, since, until)
      .slice(0, limit)
      .map(({ c, score }) => ({
        id: String(c.record.id),
        type: 'conversation',
        score: Number(score.toFixed(3)),
        summary: c.record.summary,
        snippet: c.record.short_summary,
        title_snippet: c.record.short_summary,
        created_at: c.record.created_at,
        corrections: [],
      }));
    return { results, next_cursor: null, timezone: TIMEZONE };
  }

  private rank(query: string, weighted: boolean, since?: number, until?: number): { c: SimConversation; score: number }[] {
    const convos = this.listConversations().filter(
      (c) => (since ? c.record.start_time >= since : true) && (until ? c.record.start_time <= until : true),
    );
    const qTokens = tokens(query);
    if (qTokens.length === 0) return [];

    const df = new Map<string, number>();
    for (const c of convos) {
      for (const t of new Set(tokens(conversationText(c)))) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const n = Math.max(1, convos.length);

    return convos
      .map((c) => {
        const docTokens = new Set(tokens(conversationText(c)));
        let score = 0;
        for (const t of new Set(qTokens)) {
          if (!docTokens.has(t)) continue;
          score += weighted ? Math.log(1 + n / (1 + (df.get(t) ?? 0))) : 1;
        }
        return { c, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  /**
   * `GET /v1/conversations/:id/related`.
   *
   * Bee computes these server-side from AI-extracted keywords and persists
   * them; this ranks other conversations by IDF-weighted overlap with the
   * subject's own text, which produces the same *shape* of answer -- a ranked
   * `conversations` array -- from the same input. Note it returns conversation
   * records, not the hits `/v1/search/*` returns; that difference is real and
   * the client has to handle both.
   */
  private relatedTo(subject: SimConversation) {
    const others = this.listConversations().filter((c) => c !== subject);
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
      .map(({ c }) => listRecord(c));
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
    this.emitTo(res, { timestamp: Date.now() }, 'connected');
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
   * The `event:` line is not optional: `bee stream`'s SSE parser only emits an
   * event once it has seen both an `event` field and a `data` field, so a frame
   * written as `data:` alone is silently dropped by Bee's own client. Emitting
   * it here is what lets `tests/conformance` run this server's bytes through
   * that parser and get the frames back.
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

  /**
   * The conversation starts (or resumes) being captured: it is listed as
   * CAPTURING, its words are served from a realtime transcription, and every
   * utterance in it has a realtime id. A conversation played into the stream
   * is happening now, so its clock starts now.
   */
  private beginCapture(c: SimConversation): void {
    const now = Date.now();
    if (c.live && c.revealed === 0) {
      const startTime = now - 1200;
      c.record = { ...c.record, start_time: startTime, created_at: startTime + 180 };
    }
    for (const u of c.utterances) u.realtimeId ??= this.utteranceId();
    c.record = { ...c.record, state: 'CAPTURING', end_time: null, updated_at: now };
  }

  /** Reveal the next utterance, as spoken now, and stream it. */
  private speak(c: SimConversation, u: SimUtterance, stream: boolean): void {
    this.beginCapture(c);
    if (c.live) {
      const spokenAt = Math.floor(Date.now() / 1000) * 1000;
      const length = u.end - u.start;
      u.start = Number(Math.max(0, (spokenAt - c.record.start_time) / 1000).toFixed(2));
      u.end = Number((u.start + length).toFixed(2));
      u.spokenAt = spokenAt;
      u.createdAt = spokenAt + 1400;
    }
    c.revealed++;
    c.changedAt = Date.now();
    if (stream) this.emitUtterance(c, u);
  }

  private append(conversationId: string, text: string, stream: boolean): boolean {
    const c = this.conversations.get(conversationId);
    if (!c) return false;
    const spokenAt = Math.floor(Date.now() / 1000) * 1000;
    const start = Number(Math.max(0, (spokenAt - c.record.start_time) / 1000).toFixed(2));
    const u: SimUtterance = {
      text,
      speaker: 'Unknown',
      start,
      end: Number((start + text.split(/\s+/).length * 0.34 + 0.4).toFixed(2)),
      spokenAt,
      createdAt: spokenAt + 1400,
    };
    c.utterances.splice(c.revealed, 0, u);
    this.speak(c, u, stream);
    return true;
  }

  /**
   * Bee has processed the conversation: the final transcription replaces the
   * realtime one, with ids of its own, and the record is COMPLETED.
   */
  private complete(conversationId: string): boolean {
    const c = this.conversations.get(conversationId);
    if (!c || c.revealed === 0) return false;
    const now = Date.now();
    for (const u of c.utterances.slice(0, c.revealed)) {
      u.finalId = this.utteranceId();
      u.createdAt = now;
    }
    const last = c.utterances[c.revealed - 1]!;
    c.record = {
      ...c.record,
      state: 'COMPLETED',
      end_time: c.record.start_time + Math.round(last.end * 1000) + 1800,
      updated_at: now,
    };
    c.changedAt = now;
    return true;
  }

  private utteranceId(): number {
    this.nextUtteranceId += 1 + Math.floor(Math.random() * 40);
    return this.nextUtteranceId;
  }

  /**
   * A live `new-utterance` frame. Its type is in the frame as well as on the
   * SSE line, the utterance carries its realtime id and `spoken_at` as ISO
   * 8601, and there is no speaker.
   */
  private emitUtterance(c: SimConversation, u: SimUtterance): void {
    this.emit(
      {
        type: 'new-utterance',
        conversation_uuid: c.uuid,
        utterance: {
          id: u.realtimeId,
          sample_id: uuidFrom(`sample:${u.realtimeId}`),
          start: u.start,
          end: u.end,
          text: u.text,
          spoken_at: new Date(u.spokenAt).toISOString(),
        },
      },
      'new-utterance',
    );
  }

  /**
   * The other event types, written exactly as given.
   *
   * Nothing in the product subscribes to these -- it asks for `new-utterance`
   * and nothing else -- but this server emits them on demand so the
   * conformance tests can prove the client classifies the whole documented
   * event set, including the three types whose payloads a structural reader
   * gets wrong.
   */
  emitEvent(type: string, frame: unknown): void {
    this.emit(frame, type);
  }

  /** Speak one utterance into a conversation, as `POST /_sim/append` does. */
  appendUtterance(conversationId: string, text: string): boolean {
    return this.append(conversationId, text, true);
  }

  /** Finish processing a conversation, as `POST /_sim/complete` does. */
  completeConversation(conversationId: string): boolean {
    return this.complete(conversationId);
  }

  private async play(conversationId: string, speedMs: number, count?: number): Promise<number> {
    const c = this.conversations.get(conversationId);
    if (!c) return 0;
    const target = count === undefined ? c.utterances.length : Math.min(c.utterances.length, c.revealed + count);
    let played = 0;
    while (c.revealed < target) {
      const u = c.utterances[c.revealed]!;
      this.speak(c, u, true);
      this.log(`[bee-sim] ${this.networkUp ? 'streamed' : 'recorded (stream down)'}: ${u.text}`);
      played++;
      if (c.revealed < target) await sleep(speedMs);
    }
    return played;
  }
}

// -------------------------------------------------------------------- helpers

/** The fields `GET /v1/conversations` lists: no transcriptions, no short summary. */
function listRecord(c: SimConversation) {
  const { id, start_time, end_time, created_at, summary, state } = c.record;
  return { id, start_time, end_time, created_at, summary, state };
}

function conversationText(c: SimConversation): string {
  return [c.record.short_summary ?? '', ...c.utterances.slice(0, c.revealed).map((u) => u.text)].join(' ');
}

function uuidFrom(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16]!, 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
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
