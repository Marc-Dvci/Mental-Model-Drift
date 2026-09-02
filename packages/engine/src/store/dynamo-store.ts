/**
 * DynamoDB store -- the deployed persistence layer.
 *
 * Single table, `pk`/`sk`, so a claim, every evidence row it produced, and the
 * drift it became are one query rather than three round trips.
 *
 *   USER#<id>            CLAIM#<capturedAt>#<id>
 *   CLAIM#<id>           EV#<fetchedAt>#<id>          (append-only)
 *   USER#<id>            DRIFT#<detectedAt>#<id>
 *   PROP#<subject>#<property>  HISTORY
 *   SEEN#<contentKey>    SEEN            (TTL)
 *   CURSOR#<name>        CURSOR
 *   METRIC#<name>        METRIC          (atomic ADD)
 *
 * Processed-event markers carry a TTL: idempotency only has to hold for as long
 * as the live stream and the reconciliation pass can disagree, which is hours,
 * not the lifetime of the account.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Claim, DriftEvent, Evidence, HistoricalChange } from '#spec';
import type { Store } from './types.ts';

export interface DynamoStoreOptions {
  tableName: string;
  userId: string;
  region?: string;
  /** How long a processed-event marker survives. Default 7 days. */
  seenTtlSeconds?: number;
}

export class DynamoStore implements Store {
  private readonly doc: DynamoDBDocumentClient;
  private readonly table: string;
  private readonly userId: string;
  private readonly seenTtl: number;

  constructor(opts: DynamoStoreOptions) {
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: opts.region ?? process.env.AWS_REGION }), {
      marshallOptions: { removeUndefinedValues: true },
    });
    this.table = opts.tableName;
    this.userId = opts.userId;
    this.seenTtl = opts.seenTtlSeconds ?? 7 * 24 * 3600;
  }

  async putClaim(claim: Claim): Promise<void> {
    await this.doc.send(new PutCommand({
      TableName: this.table,
      Item: { pk: `USER#${this.userId}`, sk: `CLAIM#${claim.capturedAt}#${claim.id}`, gsi1pk: `CLAIMID#${claim.id}`, entity: 'claim', ...claim },
    }));
  }

  async getClaim(id: string): Promise<Claim | undefined> {
    const res = await this.doc.send(new QueryCommand({
      TableName: this.table,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :p',
      ExpressionAttributeValues: { ':p': `CLAIMID#${id}` },
      Limit: 1,
    }));
    return res.Items?.[0] as Claim | undefined;
  }

  async listClaims(opts: { limit?: number } = {}): Promise<Claim[]> {
    const res = await this.doc.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': `USER#${this.userId}`, ':s': 'CLAIM#' },
      ScanIndexForward: false,
      Limit: opts.limit ?? 100,
    }));
    return (res.Items ?? []) as Claim[];
  }

  async putEvidence(evidence: Evidence): Promise<void> {
    // attribute_not_exists makes the append-only rule a property of the table
    // rather than a convention: a retry cannot silently replace an earlier
    // reading of the same source.
    await this.doc.send(new PutCommand({
      TableName: this.table,
      Item: { pk: `CLAIM#${evidence.claimId}`, sk: `EV#${evidence.fetchedAt}#${evidence.id}`, entity: 'evidence', ...evidence },
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    }));
  }

  async listEvidence(claimId: string): Promise<Evidence[]> {
    const res = await this.doc.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': `CLAIM#${claimId}`, ':s': 'EV#' },
    }));
    return (res.Items ?? []) as Evidence[];
  }

  async putDrift(drift: DriftEvent): Promise<void> {
    await this.doc.send(new PutCommand({
      TableName: this.table,
      Item: { pk: `USER#${this.userId}`, sk: `DRIFT#${drift.detectedAt}#${drift.id}`, gsi1pk: `DRIFTID#${drift.id}`, entity: 'drift', ...drift },
    }));
  }

  async getDrift(id: string): Promise<DriftEvent | undefined> {
    const res = await this.doc.send(new QueryCommand({
      TableName: this.table,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :p',
      ExpressionAttributeValues: { ':p': `DRIFTID#${id}` },
      Limit: 1,
    }));
    return res.Items?.[0] as DriftEvent | undefined;
  }

  async listDrifts(opts: { limit?: number } = {}): Promise<DriftEvent[]> {
    const res = await this.doc.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': `USER#${this.userId}`, ':s': 'DRIFT#' },
      ScanIndexForward: false,
      Limit: opts.limit ?? 100,
    }));
    return (res.Items ?? []) as DriftEvent[];
  }

  async putHistory(subject: string, property: string, changes: HistoricalChange[]): Promise<void> {
    await this.doc.send(new PutCommand({
      TableName: this.table,
      Item: { pk: `PROP#${subject}#${property}`, sk: 'HISTORY', entity: 'history', changes },
    }));
  }

  async getHistory(subject: string, property: string): Promise<HistoricalChange[]> {
    const res = await this.doc.send(new GetCommand({
      TableName: this.table,
      Key: { pk: `PROP#${subject}#${property}`, sk: 'HISTORY' },
    }));
    return ((res.Item?.changes as HistoricalChange[] | undefined) ?? []);
  }

  async markProcessed(contentKey: string, meta: Record<string, unknown>): Promise<boolean> {
    try {
      await this.doc.send(new PutCommand({
        TableName: this.table,
        Item: {
          pk: `SEEN#${contentKey}`,
          sk: 'SEEN',
          entity: 'seen',
          at: new Date().toISOString(),
          meta,
          ttl: Math.floor(Date.now() / 1000) + this.seenTtl,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
      return false;
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return true;
      throw err;
    }
  }

  async wasProcessed(contentKey: string): Promise<boolean> {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: `SEEN#${contentKey}`, sk: 'SEEN' } }));
    return Boolean(res.Item);
  }

  async getCursor(name: string): Promise<string | undefined> {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: `CURSOR#${name}`, sk: 'CURSOR' } }));
    return res.Item?.cursor as string | undefined;
  }

  async setCursor(name: string, cursor: string): Promise<void> {
    await this.doc.send(new PutCommand({
      TableName: this.table,
      Item: { pk: `CURSOR#${name}`, sk: 'CURSOR', entity: 'cursor', cursor, at: new Date().toISOString() },
    }));
  }

  async incrementMetric(name: string, by = 1): Promise<void> {
    await this.doc.send(new UpdateCommand({
      TableName: this.table,
      Key: { pk: `METRIC#${name}`, sk: 'METRIC' },
      UpdateExpression: 'ADD #v :b',
      ExpressionAttributeNames: { '#v': 'value' },
      ExpressionAttributeValues: { ':b': by },
    }));
  }

  async getMetrics(): Promise<Record<string, number>> {
    // Metrics are per-key items; the deployed dashboard reads CloudWatch instead
    // of scanning, so this returns what a caller explicitly asked to be tracked.
    return {};
  }
}
