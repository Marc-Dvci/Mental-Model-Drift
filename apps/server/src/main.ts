/**
 * The Mental Model Drift server: HTTP API, live event stream, and the dashboard.
 *
 * It binds to loopback by default. Bee data is owner-encrypted and this process
 * holds derived fragments of it, so exposing it on a network interface has to be
 * a deliberate act (MMD_HOST) rather than the default anyone inherits.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { BeeStreamFrame } from '#bee';
import { startCapture } from '#engine';
import {
  checkStatement,
  confirmDrift,
  createContext,
  getCoverage,
  getDrift,
  getStatus,
  getTimeline,
  ingestBeeFrame,
  listClaims,
  listDrifts,
  openDocsPullRequest,
  prepareDocsPatch,
  type ServerEvent,
} from './api.ts';

const PORT = Number(process.env.PORT ?? 4310);
const HOST = process.env.MMD_HOST ?? '127.0.0.1';
const STATIC_ROOT = resolve(process.env.MMD_STATIC ?? join(process.cwd(), 'apps', 'dashboard', 'dist'));
/** Set only for a demonstration run against the emulator; never against a device. */
const TOUR_TARGET = process.env.MMD_TOUR === '1' ? (process.env.BEE_PROXY_URL ?? '').replace(/\/$/, '') : '';

const ctx = createContext();

const server = createServer((req, res) => {
  void handle(req, res).catch((err: Error) => {
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  res.setHeader('x-content-type-options', 'nosniff');

  if (method === 'OPTIONS') {
    res.writeHead(204, { allow: 'GET, POST, OPTIONS' });
    res.end();
    return;
  }

  // ------------------------------------------------------------------ events
  if (path === '/api/events') return sse(req, res);

  // -------------------------------------------------------------------- read
  if (path === '/api/status') return json(res, 200, await getStatus(ctx));
  if (path === '/api/drifts' && method === 'GET') return json(res, 200, await listDrifts(ctx));
  if (path === '/api/claims' && method === 'GET') return json(res, 200, await listClaims(ctx));
  if (path === '/api/coverage' && method === 'GET') {
    return json(res, 200, await getCoverage(ctx, { force: url.searchParams.has('force') }));
  }

  const driftMatch = /^\/api\/drifts\/([^/]+)$/.exec(path);
  if (driftMatch && method === 'GET') {
    const card = await getDrift(ctx, driftMatch[1]!);
    return card ? json(res, 200, card) : json(res, 404, { error: 'no such drift' });
  }

  if (path === '/api/timeline' && method === 'GET') {
    const subject = url.searchParams.get('subject');
    const property = url.searchParams.get('property');
    if (!subject || !property) return json(res, 400, { error: 'subject and property are required' });
    return json(res, 200, await getTimeline(ctx, subject, property));
  }

  const patchMatch = /^\/api\/drifts\/([^/]+)\/docs-patch$/.exec(path);
  if (patchMatch && method === 'GET') {
    const prepared = await prepareDocsPatch(ctx, patchMatch[1]!);
    return prepared ? json(res, 200, prepared) : json(res, 404, { error: 'no such drift' });
  }

  // ------------------------------------------------------------------- write
  if (path === '/api/ingest' && method === 'POST') {
    // Accepts a raw Bee stream frame, so `bee stream --webhook-endpoint` can
    // point straight at it. Prefer the envelope form, which preserves the event
    // name the SSE frame carried and is the frame's authoritative type:
    //   --webhook-body '{"event":"{{event}}","data":{{{raw}}}}'
    // A bare '{{raw}}' body still works, and falls back to shape inference.
    const body = await readJson<BeeStreamFrame>(req);
    const enveloped = typeof body.event === 'string' && typeof body.data === 'object' && body.data !== null;
    const frame = enveloped ? (body.data as BeeStreamFrame) : body;
    const name = enveloped ? (body.event as string) : undefined;
    return json(res, 200, await ingestBeeFrame(ctx, frame, 'realtime', name));
  }

  // The Assumption Firewall over HTTP: the same check the MCP tool and `mmd`
  // make. Read-only by construction -- it records no claim and opens no card,
  // because a question an agent asked is not something the wearer said.
  if (path === '/api/check' && method === 'POST') {
    const body = await readJson<{ statement?: string; context?: string[] }>(req);
    if (!body.statement) return json(res, 400, { error: 'statement is required' });
    return json(res, 200, await checkStatement(ctx, body.statement, body.context ?? []));
  }

  if (path === '/api/reconcile' && method === 'POST') {
    const report = await ctx.reconciler.runOnce();
    publish({ type: 'reconcile', at: new Date().toISOString(), report });
    return json(res, 200, report);
  }

  const resolveMatch = /^\/api\/drifts\/([^/]+)\/resolve$/.exec(path);
  if (resolveMatch && method === 'POST') {
    const body = await readJson<{ resolution: string }>(req);
    const updated = await ctx.built.engine.resolveDrift(resolveMatch[1]!, body.resolution as never);
    return updated ? json(res, 200, updated) : json(res, 404, { error: 'no such drift' });
  }

  const confirmMatch = /^\/api\/drifts\/([^/]+)\/confirm$/.exec(path);
  if (confirmMatch && method === 'POST') {
    const updated = await confirmDrift(ctx, confirmMatch[1]!);
    return updated ? json(res, 200, updated) : json(res, 404, { error: 'no such drift' });
  }

  const understandMatch = /^\/api\/drifts\/([^/]+)\/update-understanding$/.exec(path);
  if (understandMatch && method === 'POST') {
    return json(res, 200, await ctx.built.engine.updateUnderstanding(understandMatch[1]!));
  }

  const prMatch = /^\/api\/drifts\/([^/]+)\/docs-pr$/.exec(path);
  if (prMatch && method === 'POST') {
    try {
      return json(res, 200, await openDocsPullRequest(ctx, prMatch[1]!));
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  }

  // ------------------------------------------------------------- guided tour
  // The dashboard's guided tour (`/?tour=1`) drives the real pipeline rather
  // than a script of pretend data: it plays recorded conversations into Bee and
  // reads the same event stream a person reads. It needs two controls that the
  // Bee emulator exposes and a real device does not, so they are proxied here,
  // only when the server was started for a demonstration, and only ever to the
  // emulator the server is already pointed at.
  const tourMatch = /^\/api\/tour\/(play|network)$/.exec(path);
  if (tourMatch && method === 'POST') {
    if (!TOUR_TARGET) return json(res, 403, { error: 'the guided tour is off (start with MMD_TOUR=1 against the emulator)' });
    const body = await readJson<Record<string, unknown>>(req);
    const upstream = await fetch(`${TOUR_TARGET}/_sim/${tourMatch[1]}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return json(res, upstream.status, await upstream.json());
  }

  if (path.startsWith('/api/')) return json(res, 404, { error: `no route for ${method} ${path}` });

  return serveStatic(path, res);
}

// --------------------------------------------------------------------- events

const clients = new Set<ServerResponse>();

/**
 * The last events, kept so a dashboard opened after the fact is not blank.
 *
 * Without it a reviewer who runs the demo and then opens the browser sees three
 * drift cards and an empty capture panel -- and the capture panel is the one
 * that shows the reasoning those cards came from, including the six sentences
 * out of eight that were deliberately dropped. Replayed events are marked, so
 * the client can render them without pretending they just arrived.
 */
const BACKLOG_LIMIT = 250;
const backlog: ServerEvent[] = [];

function publish(event: ServerEvent): void {
  backlog.push(event);
  if (backlog.length > BACKLOG_LIMIT) backlog.splice(0, backlog.length - BACKLOG_LIMIT);
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(payload);
}
ctx.subscribers.add(publish);

function sse(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const event of backlog) res.write(`data: ${JSON.stringify({ ...event, replay: true })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'hello', at: new Date().toISOString(), backlog: backlog.length })}\n\n`);
  clients.add(res);
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
}

// --------------------------------------------------------------------- static

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

function serveStatic(path: string, res: ServerResponse): void {
  if (!existsSync(STATIC_ROOT)) {
    return json(res, 503, {
      error: 'the dashboard has not been built',
      hint: 'run `pnpm dashboard:build`, or `pnpm dashboard:dev` for the Vite dev server',
    });
  }
  // normalize() before join() so "/../.." cannot escape the static root.
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^([/\\])+/, '');
  let file = join(STATIC_ROOT, rel);
  if (!file.startsWith(STATIC_ROOT)) return json(res, 403, { error: 'forbidden' });
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(STATIC_ROOT, 'index.html');
  if (!existsSync(file)) return json(res, 404, { error: 'not found' });

  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

// -------------------------------------------------------------------- helpers

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

// ----------------------------------------------------------------- lifecycle

server.listen(PORT, HOST, () => {
  const d = ctx.built.describe();
  console.log(`mental-model-drift  http://${HOST}:${PORT}`);
  console.log(`  mode       ${d.mode}`);
  console.log(`  registry   ${d.registry}`);
  console.log(`  bee        ${d.bee}`);
  console.log(`  proposers  ${d.proposers}`);
  console.log(`  sources    appconfig, github (${d.github}), sentry`);
});

/**
 * Optional in-process capture.
 *
 * The deployed topology puts a separate relay next to Bee (see apps/relay), but
 * for a single-machine run it is simpler and less to explain if the server can
 * subscribe itself. Both use the same `startCapture`, so the gap handling that
 * makes Bee's at-most-once stream safe is written once and tested once.
 */
if (process.env.MMD_STREAM === '1') {
  startCapture({
    bee: ctx.built.bee,
    reconciler: ctx.reconciler,
    intervalMs: Number(process.env.MMD_RECONCILE_MS ?? 120_000),
    onConnect: (isReconnect) => console.log(`  bee stream ${isReconnect ? 'restored' : 'connected'}`),
    onDisconnect: (reason) => console.log(`  bee stream lost (${reason}); reconciling`),
    onUtterance: async (event) => {
      await ingestBeeFrame(ctx, event.raw);
    },
    onReconciled: (report, why) => {
      if (report.utterancesNew > 0) {
        console.log(`  recovered ${report.utterancesNew} utterance(s) the stream never delivered (${why})`);
      }
      publish({ type: 'reconcile', at: new Date().toISOString(), report });
    },
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
