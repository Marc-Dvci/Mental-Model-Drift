/**
 * The three Lambda handlers, over the same engine the local server runs.
 *
 * Nothing in `packages/` knows it is in a Lambda. The store is chosen by
 * MMD_DYNAMO_TABLE, the adapters by MMD_MODE, and the Bee client by
 * BEE_PROXY_URL -- so what is deployed here and what runs on a laptop are the
 * same code paths, and the golden scenarios exercise both.
 *
 *   ingest   authenticate, redact, enqueue. Nothing that can be slow.
 *   worker   extract, gate, verify, adjudicate, explain. Everything that can.
 *   api      the dashboard's projections.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { classifyEvent, type BeeStreamFrame } from '#bee';
import { buildEngine, redact, Reconciler } from '#engine';

interface HttpEvent {
  rawPath?: string;
  requestContext?: { http?: { method?: string; path?: string } };
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

interface SqsEvent {
  Records: { messageId: string; body: string }[];
}

const sqs = new SQSClient({});
const cloudwatch = new CloudWatchClient({});
const QUEUE_URL = process.env.MMD_QUEUE_URL!;

/**
 * Built once per container, not per invocation: the registry parse and the
 * adapter clients are the expensive part, and they are identical across
 * invocations for one wearer.
 */
let engine: ReturnType<typeof buildEngine> | undefined;
function built() {
  engine ??= buildEngine({ root: process.env.LAMBDA_TASK_ROOT ?? process.cwd() });
  return engine;
}

/**
 * Ingest.
 *
 * Redaction happens here, before the utterance is written anywhere -- including
 * before it reaches the queue, which is the first place it would persist.
 */
export async function ingest(event: HttpEvent) {
  if (!authorised(event)) return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };

  const frame = parseBody<BeeStreamFrame>(event);
  const classified = classifyEvent(frame);
  if (classified.kind !== 'new-utterance') {
    return { statusCode: 202, body: JSON.stringify({ ignored: classified.kind }) };
  }

  const { text, hits } = redact(classified.utterance.text);
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({
        text,
        conversationId: classified.conversationId ?? classified.conversationUuid,
        conversationUuid: classified.conversationUuid,
        speaker: classified.utterance.speaker,
        receivedAt: new Date().toISOString(),
      }),
    }),
  );
  if (hits.length) await count('SecretsRedacted', hits.length);
  await count('BeeEventsReceived');
  return { statusCode: 202, body: JSON.stringify({ queued: true, redacted: hits.length }) };
}

/**
 * Worker.
 *
 * Partial batch failure is reported rather than swallowed: one utterance whose
 * source timed out must be retried without replaying the four beside it, and
 * the content-key dedupe makes that replay harmless.
 */
export async function worker(event: SqsEvent) {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const msg = JSON.parse(record.body) as {
        text: string;
        conversationId: string;
        conversationUuid?: string;
        speaker?: string;
        receivedAt?: string;
      };
      const outcome = await built().engine.ingestUtterance({
        text: msg.text,
        conversationId: msg.conversationId,
        ...(msg.conversationUuid ? { conversationUuid: msg.conversationUuid } : {}),
        ...(msg.speaker ? { speaker: msg.speaker } : {}),
        ...(msg.receivedAt ? { capturedAt: msg.receivedAt } : {}),
        origin: 'realtime',
      });
      await publishMetrics(outcome.claims.length, outcome.claims.filter((c) => c.driftId).length);
    } catch (err) {
      console.error(`[worker] ${record.messageId}: ${(err as Error).message}`);
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}

/** The dashboard's read API, plus the manual reconcile trigger. */
export async function api(event: HttpEvent) {
  if (!authorised(event)) return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };

  const path = event.rawPath ?? event.requestContext?.http?.path ?? '/';
  const method = event.requestContext?.http?.method ?? 'GET';
  const b = built();

  const json = (status: number, body: unknown) => ({
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (path.endsWith('/api/drifts') && method === 'GET') return json(200, await b.store.listDrifts({ limit: 100 }));
  if (path.endsWith('/api/claims') && method === 'GET') return json(200, await b.store.listClaims({ limit: 200 }));
  if (path.endsWith('/api/status') && method === 'GET') {
    return json(200, { ...b.describe(), metrics: await b.store.getMetrics() });
  }
  if (path.endsWith('/api/reconcile') && method === 'POST') {
    const report = await new Reconciler(b.bee, b.engine, b.store).runOnce();
    return json(200, report);
  }
  return json(404, { error: `no route for ${method} ${path}` });
}

// ------------------------------------------------------------------ plumbing

/**
 * One wearer, one shared secret, presented by the relay on the laptop.
 *
 * Deliberately not a public sign-up: this endpoint receives fragments of
 * owner-encrypted conversation data, and the smallest safe surface is one
 * caller that has to be configured by hand.
 */
function authorised(event: HttpEvent): boolean {
  const expected = process.env.MMD_INGEST_TOKEN;
  if (!expected) return true; // no token configured: local and sandbox use
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  return header === `Bearer ${expected}`;
}

function parseBody<T>(event: HttpEvent): T {
  const raw = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : event.body ?? '{}';
  return JSON.parse(raw) as T;
}

async function publishMetrics(claims: number, drifts: number): Promise<void> {
  if (claims) await count('ClaimsDetected', claims);
  if (drifts) await count('DriftsDetected', drifts);
}

async function count(metricName: string, value = 1): Promise<void> {
  try {
    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: 'MentalModelDrift',
        MetricData: [{ MetricName: metricName, Value: value, Unit: 'Count', Timestamp: new Date() }],
      }),
    );
  } catch (err) {
    // Losing a metric must never lose an utterance.
    console.warn(`[metrics] ${metricName}: ${(err as Error).message}`);
  }
}
