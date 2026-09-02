/**
 * BeeClient -- the only place in Mental Model Drift that talks to Bee.
 *
 * Bee exposes three equivalent doors onto the same owner-encrypted data:
 *
 *   `bee proxy`       a localhost HTTP API on /v1/*, including the SSE stream
 *   `@beeai/cli`      the `bee` binary, every command with --json
 *   `bee mcp serve`   the same tools over MCP
 *
 * This client prefers the proxy where the proxy has an endpoint, and shells out
 * to the CLI for the reads the proxy does not expose (`conversations related`,
 * `conversations transcript --since`, `now`, `today --context`). That split is
 * not an accident of implementation: it is the smallest set of calls that gets
 * all four of the capabilities this product needs out of Bee.
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
  BeeChangeFeed,
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
import { classifyEvent } from './events.ts';

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
      const who = me.name ?? me.email ?? (me.id !== undefined ? `id ${me.id}` : 'authenticated owner');
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
          await this.consumeStream(types, controller.signal, (frame) => {
            backoff = 500;
            return handlers.onEvent(classifyEvent(frame));
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
    onFrame: (frame: BeeStreamFrame) => void | Promise<void>,
    onConnect?: () => void,
  ): Promise<void> {
    if (this.proxyUrl) return this.consumeSse(types, signal, onFrame, onConnect);
    return this.consumeCliStream(types, signal, onFrame, onConnect);
  }

  /** `GET /v1/stream` -- server-sent events from `bee proxy`. */
  private async consumeSse(
    types: string[],
    signal: AbortSignal,
    onFrame: (frame: BeeStreamFrame) => void | Promise<void>,
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
        const data = rawFrame
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') continue;
        try {
          await onFrame(JSON.parse(data) as BeeStreamFrame);
        } catch {
          /* a malformed frame must not tear down a live capture session */
        }
      }
    }
  }

  /** `bee stream --json` -- one JSON object per line on stdout. */
  private async consumeCliStream(
    types: string[],
    signal: AbortSignal,
    onFrame: (frame: BeeStreamFrame) => void | Promise<void>,
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
   * `bee changed --cursor` -- the cursor-based changefeed.
   *
   * This is the reliability half of the capture design. The stream is
   * at-most-once; this is not. Persist `meta.next_cursor` only after the batch
   * has been processed successfully, never on receipt.
   */
  async changed(cursor?: string): Promise<BeeChangeFeed> {
    if (this.proxyUrl) {
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      return this.http<BeeChangeFeed>('GET', `/v1/changes${qs}`);
    }
    return this.cli<BeeChangeFeed>(['changed', ...(cursor ? ['--cursor', cursor] : []), '--json']);
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
   * Resolve whatever reference a caller has into an id the read endpoints accept.
   *
   * Realtime frames carry `conversation_uuid`; the read endpoints are keyed by
   * id. Rather than assume the two are interchangeable, try the reference
   * directly and fall back to a lookup by uuid over recent conversations. The
   * mapping is cached because a live conversation produces many utterances and
   * this would otherwise be a list call per sentence.
   */
  private conversationIdCache = new Map<string, string>();

  async resolveConversationId(ref: string): Promise<string> {
    const cached = this.conversationIdCache.get(ref);
    if (cached) return cached;
    try {
      const convo = await this.getConversation(ref);
      if (convo && convo.id !== undefined) {
        const id = String(convo.id);
        this.conversationIdCache.set(ref, id);
        if (convo.uuid) this.conversationIdCache.set(convo.uuid, id);
        return id;
      }
    } catch {
      /* not an id, or not readable by that key */
    }
    const recent = await this.listConversations({ limit: 50 }).catch(() => []);
    const match = recent.find((c) => c.uuid === ref || String(c.id) === ref);
    const id = match ? String(match.id) : ref;
    this.conversationIdCache.set(ref, id);
    return id;
  }

  /** Verbatim utterances. Preferred over summaries: summaries are generated. */
  async transcript(id: string, sinceEpochMs?: number): Promise<BeeUtterance[]> {
    if (this.allowCli) {
      try {
        const body = await this.cli<unknown>([
          'conversations', 'transcript', id,
          ...(sinceEpochMs ? ['--since', String(sinceEpochMs)] : []),
          '--json',
        ]);
        const arr = asArray<BeeUtterance>(body, 'utterances');
        if (arr.length) return arr;
      } catch {
        /* fall through to the conversation read */
      }
    }
    const convo = await this.getConversation(id);
    return convo.utterances ?? [];
  }

  /** `bee conversations related` -- Bee's own notion of adjacent discussions. */
  async related(id: string, limit = 5): Promise<BeeConversation[]> {
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
      if (!opts.neural) {
        if (opts.since) payload.since = opts.since;
        if (opts.until) payload.until = opts.until;
        if (opts.sort) payload.sort = opts.sort;
      }
      const body = await this.http<unknown>('POST', path, payload);
      return asArray<BeeSearchHit>(body, 'results', 'hits', 'conversations');
    }
    const args = ['search', '--query', query, '--limit', String(opts.limit ?? 20)];
    if (opts.neural) args.push('--neural');
    if (opts.filter) args.push('--filter', opts.filter);
    if (opts.sort) args.push('--sort', opts.sort);
    if (opts.since) args.push('--since', String(opts.since));
    if (opts.until) args.push('--until', String(opts.until));
    args.push('--json');
    const body = await this.cli<unknown>(args);
    return asArray<BeeSearchHit>(body, 'results', 'hits', 'conversations');
  }

  // ----------------------------------------------------------------- correct

  async listFacts(opts: { limit?: number; unconfirmed?: boolean } = {}): Promise<BeeFact[]> {
    if (this.proxyUrl) {
      const qs = new URLSearchParams();
      if (opts.limit) qs.set('limit', String(opts.limit));
      if (opts.unconfirmed) qs.set('unconfirmed', 'true');
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
