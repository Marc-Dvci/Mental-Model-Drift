/**
 * `pnpm doctor` -- exercise every Bee capability this product depends on, once,
 * against whatever Bee is configured, and say plainly which ones answered.
 *
 * The point is that "switching to a real device is one environment variable" is
 * a claim, and a claim about someone else's service is worth exactly as much as
 * the check that backs it. This is that check. It runs the same client the
 * product runs, over the same four capabilities, and prints a table:
 *
 *     pnpm doctor                                     # against tools/bee-sim
 *     BEE_PROXY_URL=http://127.0.0.1:8787 pnpm doctor # against `bee proxy`
 *     BEE_ALLOW_CLI=1 pnpm doctor                     # against the `bee` CLI
 *
 * Two things it deliberately checks that a simpler health check would not:
 *
 *   - whether the realtime stream delivered a frame carrying its SSE `event:`
 *     name. That name is the frame's type, and a transport that drops it
 *     downgrades the product to guessing from the payload's shape. It is
 *     invisible in every other symptom, so it is asserted here by name.
 *   - whether `conversations related` is reachable over the configured
 *     transport, since the endpoint behind it is a `/v1` path the proxy
 *     forwards, not a CLI-only feature.
 *
 * Nothing here writes to Bee unless `--write` is passed, and the write is a
 * fact clearly marked as a diagnostic.
 */
import { BeeClient, type BeeEvent } from '#bee';

interface Check {
  capability: 'IDENTITY' | 'CAPTURE' | 'RECALL' | 'RECONCILE' | 'CORRECT';
  name: string;
  detail: string;
  status: 'ok' | 'fail' | 'skip';
  required: boolean;
}

const STREAM_WAIT_MS = Number(process.env.MMD_DOCTOR_STREAM_MS ?? 12_000);

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const client = BeeClient.fromEnv();
  const checks: Check[] = [];

  const line = (c: Check) => {
    checks.push(c);
    const mark = c.status === 'ok' ? 'ok  ' : c.status === 'skip' ? 'skip' : 'FAIL';
    console.log(`  ${mark}  ${c.capability.padEnd(10)} ${c.name.padEnd(38)} ${c.detail}`);
  };

  console.log('\nMental Model Drift -- Bee preflight');
  console.log(`transport: ${client.describeTransport()}\n`);

  // ---------------------------------------------------------------- identity
  let owner = '';
  try {
    const me = await client.me();
    owner = String(me.name ?? me.email ?? me.id ?? 'authenticated owner');
    line({ capability: 'IDENTITY', name: 'GET /v1/me', detail: owner, status: 'ok', required: true });
  } catch (err) {
    line({ capability: 'IDENTITY', name: 'GET /v1/me', detail: msg(err), status: 'fail', required: true });
    // Everything below needs an authenticated Bee. Report and stop rather than
    // printing five more failures that all say the same thing.
    return report(checks, 'not authenticated -- run `bee login`, then `bee proxy`');
  }

  // ----------------------------------------------------------------- capture
  const heard = await listenOnce(client, STREAM_WAIT_MS);
  if (heard.error) {
    line({ capability: 'CAPTURE', name: 'GET /v1/stream', detail: heard.error, status: 'fail', required: true });
  } else if (!heard.connected) {
    line({ capability: 'CAPTURE', name: 'GET /v1/stream', detail: 'no connection within the window', status: 'fail', required: true });
  } else {
    line({ capability: 'CAPTURE', name: 'GET /v1/stream', detail: 'connected', status: 'ok', required: true });

    if (!heard.event) {
      // Not a failure: on a real device this only means nobody spoke during the
      // window. It does mean the check below could not be made.
      line({
        capability: 'CAPTURE',
        name: 'new-utterance frame',
        detail: `silence for ${STREAM_WAIT_MS / 1000}s -- speak near the device and re-run`,
        status: 'skip',
        required: false,
      });
    } else if (heard.event.nameWasInferred) {
      line({
        capability: 'CAPTURE',
        name: 'SSE event name',
        detail: 'frame arrived WITHOUT an event name; type was guessed from the payload',
        status: 'fail',
        required: false,
      });
    } else {
      line({
        capability: 'CAPTURE',
        name: 'SSE event name',
        detail: `${heard.event.name} (authoritative, not inferred)`,
        status: 'ok',
        required: true,
      });
    }
  }

  // --------------------------------------------------------------- reconcile
  let conversationId: string | undefined;
  try {
    const feed = await client.changed();
    const n = feed.conversations?.length ?? 0;
    conversationId = n ? String(feed.conversations![0]!.id) : undefined;
    line({
      capability: 'RECONCILE',
      name: 'GET /v1/changes (cursor)',
      detail: `${n} conversation(s), next_cursor ${feed.meta.next_cursor ? 'present' : 'MISSING'}`,
      status: feed.meta.next_cursor ? 'ok' : 'fail',
      required: true,
    });
  } catch (err) {
    line({ capability: 'RECONCILE', name: 'GET /v1/changes (cursor)', detail: msg(err), status: 'fail', required: true });
  }

  if (!conversationId) {
    try {
      const list = await client.listConversations({ limit: 1 });
      conversationId = list[0] ? String(list[0].id) : undefined;
    } catch {
      /* reported by the check above */
    }
  }

  // ------------------------------------------------------------------ recall
  try {
    const hits = await client.search('retries', { neural: true, limit: 5 });
    line({
      capability: 'RECALL',
      name: 'POST /v1/search/conversations/neural',
      detail: `${hits.length} hit(s)`,
      status: 'ok',
      required: true,
    });
  } catch (err) {
    line({ capability: 'RECALL', name: 'POST /v1/search/conversations/neural', detail: msg(err), status: 'fail', required: true });
  }

  if (conversationId) {
    const related = await client.related(conversationId, 5);
    line({
      capability: 'RECALL',
      name: 'GET /v1/conversations/:id/related',
      detail: `${related.length} related to conversation ${conversationId}`,
      status: 'ok',
      required: false,
    });
    try {
      const utterances = await client.transcript(conversationId);
      line({
        capability: 'RECALL',
        name: 'transcript (verbatim utterances)',
        detail: `${utterances.length} utterance(s)`,
        status: utterances.length ? 'ok' : 'fail',
        required: true,
      });
    } catch (err) {
      line({ capability: 'RECALL', name: 'transcript (verbatim utterances)', detail: msg(err), status: 'fail', required: true });
    }
  } else {
    line({ capability: 'RECALL', name: 'conversation reads', detail: 'no conversation recorded yet', status: 'skip', required: false });
  }

  // ----------------------------------------------------------------- correct
  try {
    const facts = await client.listFacts({ limit: 5 });
    line({ capability: 'CORRECT', name: 'GET /v1/facts', detail: `${facts.length} fact(s) readable`, status: 'ok', required: true });
  } catch (err) {
    line({ capability: 'CORRECT', name: 'GET /v1/facts', detail: msg(err), status: 'fail', required: true });
  }

  if (write) {
    try {
      const fact = await client.createFact('Mental Model Drift preflight check -- safe to delete.');
      await client.updateFact(String(fact.id), { confirmed: true });
      line({ capability: 'CORRECT', name: 'POST /v1/facts + confirm', detail: `wrote fact ${fact.id} (delete it in the app)`, status: 'ok', required: false });
    } catch (err) {
      line({ capability: 'CORRECT', name: 'POST /v1/facts + confirm', detail: msg(err), status: 'fail', required: false });
    }
  } else {
    line({ capability: 'CORRECT', name: 'POST /v1/facts', detail: 'not attempted; pass --write to test it', status: 'skip', required: false });
  }

  report(checks, owner ? `owner: ${owner}` : '');
}

/**
 * Connect to the realtime stream and wait for one utterance, or the timeout.
 *
 * Silence is a legitimate outcome on a real device -- it means nobody spoke --
 * so the caller distinguishes "did not connect" from "connected and heard
 * nothing", and only the first is a failure.
 */
function listenOnce(
  client: BeeClient,
  waitMs: number,
): Promise<{ connected: boolean; event?: BeeEvent; error?: string }> {
  return new Promise((resolve) => {
    let connected = false;
    let settled = false;
    const finish = (r: { connected: boolean; event?: BeeEvent; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ connected }), waitMs);
    const stop = client.streamEvents({
      onConnect: () => {
        connected = true;
      },
      onEvent: (event) => {
        if (event.kind === 'new-utterance') finish({ connected: true, event });
      },
      onDisconnect: ({ reason }) => {
        if (!connected) finish({ connected: false, error: reason });
      },
    });
  });
}

function report(checks: Check[], footer: string): void {
  const failed = checks.filter((c) => c.status === 'fail');
  const blocking = failed.filter((c) => c.required);
  console.log('');
  if (footer) console.log(`  ${footer}`);
  if (blocking.length === 0 && failed.length === 0) {
    console.log('  every capability this product needs answered.\n');
  } else if (blocking.length === 0) {
    console.log(`  ${failed.length} non-blocking check(s) failed; capture and verification will still run.\n`);
  } else {
    console.log(`  ${blocking.length} required capability/capabilities did not answer:`);
    for (const c of blocking) console.log(`    - ${c.name}: ${c.detail}`);
    console.log('');
  }
  process.exitCode = blocking.length ? 1 : 0;
}

function msg(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 90 ? `${m.slice(0, 87)}...` : m;
}

void main().catch((err: Error) => {
  console.error(`doctor failed: ${err.message}`);
  process.exitCode = 1;
});
