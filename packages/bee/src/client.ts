/**
 * BeeClient -- the only place in Mental Model Drift that talks to Bee.
 *
 * Bee exposes three equivalent doors onto the same owner-encrypted data:
 *
 *   `bee proxy`       a localhost HTTP API on /v1/*, including the SSE stream
 *   `@beeai/cli`      the `bee` binary, every command with --json
 *   `bee mcp serve`   the same tools over MCP
 *
 * The proxy is not a subset of the CLI. It forwards *every* path under `/v1`
 * upstream rather than exposing a hand-written route list, so anything the CLI
 * can read the proxy can read -- including `/v1/conversations/:id/related`,
 * which only the `conversations related` subcommand advertises. This client
 * therefore runs proxy-only when a proxy is configured, and shells out to the
 * `bee` binary solely when there is no proxy at all. One transport, one code
 * path, no capability that quietly disappears depending on how it was started.
 *
 * Four capabilities are what this product needs out of Bee:
 *
 *   CAPTURE    stream(new-utterance)      ambient assertions, as spoken
 *   RECALL     search --neural --since    has this belief been held before
 *   RECONCILE  changed --cursor           recover what the at-most-once stream dropped
 *   CORRECT    facts create/update        write the verified value back into memory
 *
 * Nothing here interprets an utterance. Interpretation is the engine's job.
 */
import { spawn } from 'node:child_process';
import type {
  BeeChangeBatch,
  BeeConversation,
  BeeEvent,
  BeeFact,
  BeeSearchHit,
  BeeSearchOptions,
  BeeStreamFrame,
  BeeUser,
  BeeUtterance,
} from './types.ts';
import { launch } from './bin.ts';
import { classifyEvent, normaliseText } from './events.ts';
import { pickTranscript, utteranceIds } from './read.ts';

export interface BeeClientConfig {
  /** e.g. http://127.0.0.1:8787 -- the address `bee proxy` is listening on. */
  proxyUrl?: string;
  /** Bearer token, when the proxy or a remote deployment requires one. */
  token?: string;
  /** Path to the `bee` binary. Defaults to `bee` on PATH. */
  cliBin?: string;
  /** Set false to refuse to shell out (containers without the CLI installed). */
  allowCli?: boolean;
  timeoutMs?: number;
}

export class BeeUnavailableError extends Error {
  constructor(message: string, public readonly hint?: string) {
    super(message);
    this.name = 'BeeUnavailableError';
  }
}

/**
 * A parsed frame and, when the transport carried it, its SSE `event:` name.
 * The name is the frame's authoritative type; see `events.ts`.
 */
export type BeeFrameSink = (frame: BeeStreamFrame, name?: string) => void | Promise<void>;

export interface StreamHandlers {
  onEvent: (event: BeeEvent) => void | Promise<void>;
  /** Fired on every disconnect. The stream is at-most-once: this is the signal
   *  that a reconciliation pass is now owed. */
  onDisconnect?: (info: { reason: string; downSince: number }) => void;
  onConnect?: () => void;
}

export class BeeClient {
  readonly proxyUrl?: string;
  private readonly token?: string;
  private readonly cliBin: string;
  private readonly allowCli: boolean;
  private readonly timeoutMs: number;

  constructor(cfg: BeeClientConfig = {}) {
    this.proxyUrl = cfg.proxyUrl?.replace(/\/$/, '');
    this.token = cfg.token;
    this.cliBin = cfg.cliBin ?? 'bee';
    this.allowCli = cfg.allowCli ?? true;
    this.timeoutMs = cfg.timeoutMs ?? 20_000;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): BeeClient {
    return new BeeClient({
      proxyUrl: env.BEE_PROXY_URL,
      token: env.BEE_TOKEN,
      cliBin: env.BEE_CLI_BIN,
      allowCli: env.BEE_ALLOW_CLI !== '0',
    });
  }

  describeTransport(): string {
    const parts: string[] = [];
    if (this.proxyUrl) parts.push(`proxy ${this.proxyUrl}`);
    if (this.allowCli) parts.push(`cli ${this.cliBin}`);
    return parts.join(' + ') || 'none configured';
  }

  // ---------------------------------------------------------------- identity

  async me(): Promise<BeeUser> {
    if (this.proxyUrl) return this.http<BeeUser>('GET', '/v1/me');
    return this.cli<BeeUser>(['me', '--json']);
  }

  /** True when Bee answers and the answer looks like an authenticated owner. */
  async health(): Promise<{ ok: boolean; transport: string; detail: string }> {
    try {
      const me = await this.me();
      const name = [me.first_name, me.last_name].filter(Boolean).join(' ');
      const who = name || (me.id !== undefined ? `id ${me.id}` : 'authenticated owner');
      return { ok: true, transport: this.describeTransport(), detail: String(who) };
    } catch (err) {
      return { ok: false, transport: this.describeTransport(), detail: (err as Error).message };
    }
  }

  // ----------------------------------------------------------------- capture

  /**
   * Subscribe to the realtime stream, reconnecting with capped backoff.
   *
   * Returns a stop function. Every disconnect is surfaced rather than swallowed,
   * because the documented delivery semantics are at-most-once and the caller
   * needs to know a gap exists before it can close it with `changed()`.
   */
  streamEvents(
    handlers: StreamHandlers,
    opts: { types?: string[]; signal?: AbortSignal } = {},
  ): () => void {
    const types = opts.types ?? ['new-utterance'];
    let stopped = false;
    let controller: AbortController | null = null;
    let backoff = 500;

    const stop = () => {
      stopped = true;
      controller?.abort();
    };
    opts.signal?.addEventListener('abort', stop, { once: true });

    const loop = async () => {
      while (!stopped) {
        const downSince = Date.now();
        try {
          controller = new AbortController();
          await this.consumeStream(types, controller.signal, (frame, name) => {
            backoff = 500;
            return handlers.onEvent(classifyEvent(frame, name));
          }, handlers.onConnect);
          if (stopped) return;
          handlers.onDisconnect?.({ reason: 'stream closed by peer', downSince });
        } catch (err) {
          if (stopped) return;
          handlers.onDisconnect?.({ reason: (err as Error).message, downSince });
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 15_000);
      }
    };
    void loop();
    return stop;
  }

  private async consumeStream(
    types: string[],
    signal: AbortSignal,
    onFrame: BeeFrameSink,
    onConnect?: () => void,
  ): Promise<void> {
    if (this.proxyUrl) return this.consumeSse(types, signal, onFrame, onConnect);
    return this.consumeCliStream(types, signal, onFrame, onConnect);
  }

  /**
   * `GET /v1/stream` -- server-sent events from `bee proxy`.
   *
   * The `event:` line is the frame's type and is passed through to the caller.
   * A live frame repeats it in its own `type` field, so either is enough; the
   * line is kept because it is what `bee stream`'s own parser keys on, and a
   * frame without either is read by shape, which misreads event types whose
   * payloads are not disjoint; see `events.ts`.
   */
  private async consumeSse(
    types: string[],
    signal: AbortSignal,
    onFrame: BeeFrameSink,
    onConnect?: () => void,
  ): Promise<void> {
    const url = `${this.proxyUrl}/v1/stream?types=${encodeURIComponent(types.join(','))}`;
    const res = await fetch(url, { headers: this.headers({ Accept: 'text/event-stream' }), signal });
    if (!res.ok || !res.body) {
      throw new BeeUnavailableError(`bee stream returned HTTP ${res.status}`, 'is `bee proxy` running?');
    }
    onConnect?.();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; a frame may span several
      // `data:` lines and must be rejoined before parsing.
      let sep: number;
      while ((sep = indexOfFrameEnd(buffer)) !== -1) {
        const rawFrame = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, '');
        let name: string | undefined;
        const data: string[] = [];
        for (const line of rawFrame.split(/\r?\n/)) {
          // A line opening with ':' is a comment -- servers send them as
          // keep-alive pings. It is not a field and carries no colon-separated
          // value, so it has to be skipped before the field split below.
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          if (colon === -1) continue;
          const field = line.slice(0, colon);
          const value = line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') name = value;
          else if (field === 'data') data.push(value);
        }
        const body = data.join('\n');
        if (!body || body === '[DONE]') continue;
        try {
          await onFrame(JSON.parse(body) as BeeStreamFrame, name);
        } catch {
          /* a malformed frame must not tear down a live capture session */
        }
      }
    }
  }

  /**
   * `bee stream --json` -- one JSON object per line on stdout.
   *
   * `--json` prints the SSE frame's `data:` line alone and drops the `event:`
   * line. Nothing is lost by that: a live frame carries its type in its own
   * `type` field, and `classifyEvent` reads it from there. A frame with no
   * `type` would be classified by shape and marked as inferred.
   * `describeTransport()` reports which path is live.
   */
  private async consumeCliStream(
    types: string[],
    signal: AbortSignal,
    onFrame: BeeFrameSink,
    onConnect?: () => void,
  ): Promise<void> {
    if (!this.allowCli) throw new BeeUnavailableError('no Bee transport configured');
    await new Promise<void>((resolve, reject) => {
      const cli = launch(this.cliBin);
      const child = spawn(cli.command, ['stream', '--json', '--types', types.join(',')], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: cli.shell,
      });
      let buffer = '';
      let stderr = '';
      const kill = () => child.kill();
      signal.addEventListener('abort', kill, { once: true });
      onConnect?.();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            void onFrame(JSON.parse(line) as BeeStreamFrame);
          } catch {
            /* ignore non-JSON banner lines */
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c: string) => (stderr += c));
      child.on('error', (e) => reject(new BeeUnavailableError(`could not run \`${this.cliBin} stream\`: ${e.message}`, 'npm install -g @beeai/cli')));
      child.on('close', () => {
        signal.removeEventListener('abort', kill);
        if (signal.aborted) resolve();
        else if (stderr.trim()) reject(new BeeUnavailableError(stderr.trim().split('\n')[0]!));
        else resolve();
      });
    });
  }

  // --------------------------------------------------------------- reconcile

  /**
   * `GET /v1/changes` / `bee changed --cursor` -- the cursor-based changefeed.
   *
   * This is the reliability half of the capture design. The stream is
   * at-most-once; this is not. Persist `nextCursor` only after the batch has
   * been processed successfully, never on receipt.
   *
   * The two doors answer in different shapes. The API returns bare ids and puts
   * `next_cursor` at the top level; the CLI fetches every id itself and moves
   * the cursor into `meta`. A reader that looks for `meta.next_cursor` on the
   * API never advances its cursor, and re-reads the same window forever.
   */
  async changed(cursor?: string): Promise<BeeChangeBatch> {
    if (this.proxyUrl) {
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      return readChangeBatch(await this.http<unknown>('GET', `/v1/changes${qs}`));
    }
    return readChangeBatch(await this.cli<unknown>(['changed', ...(cursor ? ['--cursor', cursor] : []), '--json']));
  }

  async listConversations(opts: { limit?: number; cursor?: string } = {}): Promise<BeeConversation[]> {
    if (this.proxyUrl) {
      const qs = new URLSearchParams();
      if (opts.limit) qs.set('limit', String(opts.limit));
      if (opts.cursor) qs.set('cursor', opts.cursor);
      const body = await this.http<unknown>('GET', `/v1/conversations${qs.size ? `?${qs}` : ''}`);
      return asArray<BeeConversation>(body, 'conversations');
    }
    const body = await this.cli<unknown>([
      'conversations', 'list',
      ...(opts.limit ? ['--limit', String(opts.limit)] : []),
      ...(opts.cursor ? ['--cursor', opts.cursor] : []),
      '--json',
    ]);
    return asArray<BeeConversation>(body, 'conversations');
  }

  async getConversation(id: string): Promise<BeeConversation> {
    if (this.proxyUrl) {
      const body = await this.http<unknown>('GET', `/v1/conversations/${encodeURIComponent(id)}`);
      return unwrap<BeeConversation>(body, 'conversation');
    }
    const body = await this.cli<unknown>(['conversations', 'get', id, '--json']);
    return unwrap<BeeConversation>(body, 'conversation');
  }

  /**
   * Find the numeric id of the conversation a live frame belongs to.
   *
   * A realtime frame names its conversation by `conversation_uuid`. The read
   * endpoints are keyed by numeric id, and a conversation record carries no
   * uuid at all, so the two cannot be joined on the conversation. They can be
   * joined on the utterance: the id a live frame gives its utterance is the id
   * of the same utterance in the capturing conversation's realtime
   * transcription. So the conversations still being captured are read, and the
   * one holding that utterance id is the one.
   *
   * A frame without an utterance id falls back to its text, matched against
   * the newest conversations' transcripts. The mapping is cached by uuid: a
   * live conversation produces many utterances, and this would otherwise be
   * several reads per sentence. Undefined means not found, and the caller says
   * so rather than inventing an id.
   */
  private conversationIdCache = new Map<string, string>();

  async resolveConversationId(ref: { uuid?: string; id?: string; utteranceId?: string; text?: string }): Promise<string | undefined> {
    if (ref.id) return ref.id;
    const cached = ref.uuid ? this.conversationIdCache.get(ref.uuid) : undefined;
    if (cached) return cached;

    const recent = await this.listConversations({ limit: 10 }).catch(() => [] as BeeConversation[]);
    const remember = (id: string): string => {
      if (ref.uuid) this.conversationIdCache.set(ref.uuid, id);
      return id;
    };

    if (ref.utteranceId) {
      for (const c of recent.filter((x) => String(x.state ?? '').toUpperCase() !== 'COMPLETED')) {
        const full = await this.getConversation(String(c.id)).catch(() => undefined);
        if (full && utteranceIds(full).has(ref.utteranceId)) return remember(String(c.id));
      }
    }
    if (ref.text) {
      const needle = normaliseText(ref.text);
      for (const c of recent) {
        const words = await this.transcript(String(c.id)).catch(() => [] as BeeUtterance[]);
        if (words.some((u) => normaliseText(u.text ?? '') === needle)) return remember(String(c.id));
      }
    }
    return undefined;
  }

  /**
   * Verbatim utterances, in spoken order. Preferred over summaries: summaries
   * are generated.
   *
   * Read from the conversation record and not from `bee conversations
   * transcript`, because that command flattens every transcription into one
   * list: a conversation still being processed would come back with each
   * sentence twice. `pickTranscript` chooses the final transcription, or the
   * realtime one while there is no final one yet, as `bee conversations get`
   * does.
   */
  async transcript(id: string): Promise<BeeUtterance[]> {
    return pickTranscript(await this.getConversation(id));
  }

  /**
   * Bee's own notion of adjacent discussions -- server-side, precomputed from
   * AI-extracted keywords, and the reason a "related" list is worth asking for
   * rather than recomputing locally.
   *
   * Reachable over both transports. `bee proxy` forwards every `/v1` path
   * upstream rather than exposing a fixed route list, so the endpoint the
   * `conversations related` subcommand reads -- `/v1/conversations/:id/related`
   * -- is reachable through the proxy too, and no CLI process is needed.
   */
  async related(id: string, limit = 5): Promise<BeeConversation[]> {
    if (this.proxyUrl) {
      try {
        const body = await this.http<unknown>('GET', `/v1/conversations/${encodeURIComponent(id)}/related`);
        return asArray<BeeConversation>(body, 'conversations').slice(0, limit);
      } catch {
        return [];
      }
    }
    if (!this.allowCli) return [];
    try {
      const body = await this.cli<unknown>(['conversations', 'related', id, '--limit', String(limit), '--json']);
      return asArray<BeeConversation>(body, 'conversations');
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------ recall

  /**
   * Semantic recall over past conversations.
   *
   * `--neural` is what makes longitudinal drift possible: the wearer said "it
   * retries three times" in August and "three retries anyway" in September, and
   * only a vector search relates those to a query about retry behaviour.
   */
  async search(query: string, opts: BeeSearchOptions = {}): Promise<BeeSearchHit[]> {
    if (this.proxyUrl) {
      const path = opts.neural ? '/v1/search/conversations/neural' : '/v1/search/conversations';
      const payload: Record<string, unknown> = { query, limit: opts.limit ?? 20 };
      if (opts.since) payload.since = opts.since;
      if (opts.until) payload.until = opts.until;
      // `filter` and `sortBy` are keyword-only; neural search is conversations only.
      if (!opts.neural) {
        if (opts.filter) payload.filter = opts.filter;
        if (opts.sortBy) payload.sortBy = opts.sortBy;
      }
      const body = await this.http<unknown>('POST', path, payload);
      return asArray<BeeSearchHit>(body, 'results');
    }
    const args = ['search', '--query', query, '--limit', String(opts.limit ?? 20)];
    if (opts.neural) args.push('--neural');
    if (!opts.neural && opts.filter) args.push('--filter', opts.filter);
    if (!opts.neural && opts.sortBy) args.push('--sortBy', opts.sortBy);
    if (opts.since) args.push('--since', String(opts.since));
    if (opts.until) args.push('--until', String(opts.until));
    args.push('--json');
    const body = await this.cli<unknown>(args);
    return asArray<BeeSearchHit>(body, 'results');
  }

  // ----------------------------------------------------------------- correct

  async listFacts(opts: { limit?: number; unconfirmed?: boolean } = {}): Promise<BeeFact[]> {
    if (this.proxyUrl) {
      const qs = new URLSearchParams();
      if (opts.limit) qs.set('limit', String(opts.limit));
      // The API filters on `confirmed`; omitted, it returns both kinds.
      if (opts.unconfirmed) qs.set('confirmed', 'false');
      const body = await this.http<unknown>('GET', `/v1/facts${qs.size ? `?${qs}` : ''}`);
      return asArray<BeeFact>(body, 'facts');
    }
    const body = await this.cli<unknown>([
      'facts', 'list',
      ...(opts.limit ? ['--limit', String(opts.limit)] : []),
      ...(opts.unconfirmed ? ['--unconfirmed'] : []),
      '--json',
    ]);
    return asArray<BeeFact>(body, 'facts');
  }

  async searchFacts(query: string, limit = 10): Promise<BeeFact[]> {
    if (this.allowCli) {
      try {
        const body = await this.cli<unknown>(['facts', 'search', '--query', query, '--limit', String(limit), '--json']);
        return asArray<BeeFact>(body, 'facts');
      } catch {
        /* fall through */
      }
    }
    const all = await this.listFacts({ limit: 200 });
    const needle = query.toLowerCase();
    return all.filter((f) => f.text?.toLowerCase().includes(needle)).slice(0, limit);
  }

  /**
   * Write a verified value back into Bee's own memory.
   *
   * This is the step that closes the loop: the correction does not live in this
   * product's database, it lives where the wearer's assistant will read it next
   * time they ask about the system.
   */
  async createFact(text: string): Promise<BeeFact> {
    if (this.proxyUrl) {
      const body = await this.http<unknown>('POST', '/v1/facts', { text });
      return unwrap<BeeFact>(body, 'fact');
    }
    const body = await this.cli<unknown>(['facts', 'create', '--text', text, '--json']);
    return unwrap<BeeFact>(body, 'fact');
  }

  async updateFact(id: string, patch: { text?: string; confirmed?: boolean }): Promise<BeeFact> {
    if (this.proxyUrl) {
      const body = await this.http<unknown>('PUT', `/v1/facts/${encodeURIComponent(id)}`, patch);
      return unwrap<BeeFact>(body, 'fact');
    }
    const args = ['facts', 'update', id];
    if (patch.text !== undefined) args.push('--text', patch.text);
    if (patch.confirmed !== undefined) args.push('--confirmed', String(patch.confirmed));
    args.push('--json');
    const body = await this.cli<unknown>(args);
    return unwrap<BeeFact>(body, 'fact');
  }

  // ------------------------------------------------------------------ plumbing

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private async http<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.proxyUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: this.headers(body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((e: Error) => {
      throw new BeeUnavailableError(`${method} ${path} failed: ${e.message}`, 'is `bee proxy` running?');
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new BeeUnavailableError(`${method} ${path} returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    return (await res.json()) as T;
  }

  private cli<T>(args: string[]): Promise<T> {
    if (!this.allowCli) return Promise.reject(new BeeUnavailableError('CLI transport disabled and no proxy configured'));
    return new Promise<T>((resolve, reject) => {
      const cli = launch(this.cliBin);
      const child = spawn(cli.command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: cli.shell,
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill(), this.timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c: string) => (out += c));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c: string) => (err += c));
      child.on('error', (e) =>
        reject(new BeeUnavailableError(`could not run \`${this.cliBin} ${args[0]}\`: ${e.message}`, 'npm install -g @beeai/cli && bee login')),
      );
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          return reject(new BeeUnavailableError(`\`bee ${args.slice(0, 2).join(' ')}\` exited ${code}: ${err.trim().split('\n')[0] ?? ''}`));
        }
        try {
          resolve(JSON.parse(out) as T);
        } catch {
          reject(new BeeUnavailableError(`\`bee ${args.slice(0, 2).join(' ')}\` returned non-JSON output`));
        }
      });
    });
  }
}

// ------------------------------------------------------------------ helpers

/**
 * Bee endpoints return either a bare array or an envelope, and which one is not
 * uniform across commands. Rather than hard-code a guess per call site, unwrap
 * the first array found under any of the plausible keys.
 */
function asArray<T>(body: unknown, ...keys: string[]): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === 'object') {
    for (const key of [...keys, 'data', 'items', 'results']) {
      const v = (body as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

/**
 * Either shape of the changefeed, as one batch.
 *
 * `GET /v1/changes`: `{ conversations: [11331219], …, next_cursor, since, until }`.
 * `bee changed --json`: `{ meta: { next_cursor, since, until }, conversations: [{ id, … }] }`.
 * Ids may be numbers or strings; objects are kept whole so the reconciler does
 * not read them a second time.
 */
export function readChangeBatch(body: unknown): BeeChangeBatch {
  const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const meta = (record.meta && typeof record.meta === 'object' ? record.meta : record) as Record<string, unknown>;
  const conversationIds: string[] = [];
  const conversations: BeeConversation[] = [];
  for (const item of Array.isArray(record.conversations) ? record.conversations : []) {
    if (typeof item === 'number' || typeof item === 'string') conversationIds.push(String(item));
    else if (item && typeof item === 'object' && 'id' in item) {
      conversationIds.push(String((item as BeeConversation).id));
      conversations.push(item as BeeConversation);
    }
  }
  return {
    ...(typeof meta.next_cursor === 'string' && meta.next_cursor ? { nextCursor: meta.next_cursor } : {}),
    ...(typeof meta.since === 'number' ? { since: meta.since } : {}),
    ...(typeof meta.until === 'number' ? { until: meta.until } : {}),
    conversationIds,
    conversations,
  };
}

function unwrap<T>(body: unknown, ...keys: string[]): T {
  if (body && typeof body === 'object') {
    for (const key of [...keys, 'data']) {
      const v = (body as Record<string, unknown>)[key];
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as T;
    }
  }
  return body as T;
}

function indexOfFrameEnd(buffer: string): number {
  const a = buffer.indexOf('\n\n');
  const b = buffer.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
