/**
 * bee-relay -- the local process that sits next to Bee.
 *
 * Bee's own MCP/proxy surface is localhost-only by design, and the sensible
 * deployment shape keeps it that way: the relay is the only thing that talks to
 * Bee, and it makes outbound calls to the backend. Nothing inbound, nothing
 * exposed.
 *
 *     bee proxy            (or the bee CLI)
 *         |  localhost
 *     bee-relay
 *         |  outbound HTTPS
 *     ingest API
 *
 * The relay forwards frames verbatim and interprets nothing. Two things it does
 * do, because only it can:
 *
 *  - it treats every disconnect *and every reconnect* as a gap, and asks the
 *    backend to reconcile;
 *  - it retries a failed forward with backoff and a bounded buffer, so a backend
 *    restart does not become the same data loss the stream already has.
 *
 * There is a second, zero-code path for the same job, and it is in the README:
 *
 *     bee stream --types new-utterance \
 *       --webhook-endpoint http://127.0.0.1:4310/api/ingest \
 *       --webhook-body '{{raw}}'
 */
import { BeeClient, type BeeStreamFrame } from '#bee';
import { startCapture, type ReconcileReport } from '#engine';

const INGEST = process.env.MMD_INGEST_URL ?? 'http://127.0.0.1:4310/api/ingest';
const RECONCILE = process.env.MMD_RECONCILE_URL ?? INGEST.replace(/\/api\/ingest$/, '/api/reconcile');
const MAX_BUFFER = Number(process.env.MMD_RELAY_BUFFER ?? 200);

const bee = BeeClient.fromEnv();
const pending: BeeStreamFrame[] = [];
let flushing = false;

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
}

/**
 * Forward with retry.
 *
 * The buffer is bounded and drops the *oldest* frame when full: in a backlog,
 * the newest utterances are the ones a person is about to act on, and the
 * reconciliation pass will recover anything dropped here anyway.
 */
async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    let backoff = 500;
    while (pending.length) {
      const frame = pending[0]!;
      try {
        await post(INGEST, frame);
        pending.shift();
        backoff = 500;
      } catch (err) {
        console.warn(`[relay] forward failed (${(err as Error).message}); ${pending.length} queued`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  } finally {
    flushing = false;
  }
}

async function askBackendToReconcile(): Promise<ReconcileReport> {
  try {
    await post(RECONCILE, {});
  } catch (err) {
    console.warn(`[relay] reconcile request failed: ${(err as Error).message}`);
  }
  // The backend owns the cursor and the counts; the relay only asks.
  return { ran: true, conversationsChanged: 0, utterancesSeen: 0, utterancesNew: 0, claimsFound: 0, driftsFound: 0 };
}

const health = await bee.health();
console.log(`bee-relay`);
console.log(`  bee      ${health.transport} ${health.ok ? `(${health.detail})` : `UNAVAILABLE: ${health.detail}`}`);
console.log(`  ingest   ${INGEST}`);
if (!health.ok) {
  console.log(`  hint     start \`bee proxy\` and set BEE_PROXY_URL, or run \`bee login\` for the CLI path`);
}

startCapture({
  bee,
  // The relay does not own a store, so reconciliation is a request to the
  // backend rather than a pass it runs itself.
  reconciler: { start: () => ({ stop: () => {}, runNow: askBackendToReconcile }) },
  onConnect: (isReconnect) => console.log(`[relay] stream ${isReconnect ? 'restored' : 'connected'}`),
  onDisconnect: (reason) => console.log(`[relay] stream down (${reason}); requesting reconciliation`),
  onUtterance: (event) => {
    console.log(`[relay] ${event.utterance.speaker ?? 'speaker'}: ${event.utterance.text}`);
    pending.push(event.raw);
    while (pending.length > MAX_BUFFER) pending.shift();
    void flush();
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => process.exit(0));
}
