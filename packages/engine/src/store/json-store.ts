/**
 * A single-file JSON store.
 *
 * This is the default for local runs and for every test, and it exists so the
 * whole product can be exercised end to end with no cloud account. It shares an
 * interface with the DynamoDB store, and the golden scenarios run against both.
 *
 * Writes are serialised through one promise chain and land via a temp file and
 * rename, so an interrupted run leaves the previous state intact rather than a
 * truncated file.
 */
import { mkdirSync, readFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Claim, DriftEvent, Evidence, HistoricalChange } from '#spec';
import type { Store } from './types.ts';

interface Snapshot {
  claims: Record<string, Claim>;
  evidence: Record<string, Evidence[]>;
  drifts: Record<string, DriftEvent>;
  history: Record<string, HistoricalChange[]>;
  processed: Record<string, { at: string; meta: Record<string, unknown> }>;
  cursors: Record<string, string>;
  metrics: Record<string, number>;
}

const EMPTY: Snapshot = {
  claims: {}, evidence: {}, drifts: {}, history: {}, processed: {}, cursors: {}, metrics: {},
};

export class JsonStore implements Store {
  private data: Snapshot;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {
    this.data = existsSync(path)
      ? { ...structuredClone(EMPTY), ...(JSON.parse(readFileSync(path, 'utf8')) as Snapshot) }
      : structuredClone(EMPTY);
  }

  private flush(): Promise<void> {
    this.queue = this.queue.then(() => {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      renameSync(tmp, this.path);
    });
    return this.queue;
  }

  async putClaim(claim: Claim): Promise<void> {
    this.data.claims[claim.id] = claim;
    await this.flush();
  }
  async getClaim(id: string): Promise<Claim | undefined> {
    return this.data.claims[id];
  }
  async listClaims(opts: { limit?: number } = {}): Promise<Claim[]> {
    const all = Object.values(this.data.claims).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    return opts.limit ? all.slice(0, opts.limit) : all;
  }

  async putEvidence(evidence: Evidence): Promise<void> {
    (this.data.evidence[evidence.claimId] ??= []).push(evidence);
    await this.flush();
  }
  async listEvidence(claimId: string): Promise<Evidence[]> {
    return this.data.evidence[claimId] ?? [];
  }

  async putDrift(drift: DriftEvent): Promise<void> {
    this.data.drifts[drift.id] = drift;
    await this.flush();
  }
  async getDrift(id: string): Promise<DriftEvent | undefined> {
    return this.data.drifts[id];
  }
  async listDrifts(opts: { limit?: number } = {}): Promise<DriftEvent[]> {
    const all = Object.values(this.data.drifts).sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
    return opts.limit ? all.slice(0, opts.limit) : all;
  }

  async putHistory(subject: string, property: string, changes: HistoricalChange[]): Promise<void> {
    this.data.history[`${subject}#${property}`] = changes;
    await this.flush();
  }
  async getHistory(subject: string, property: string): Promise<HistoricalChange[]> {
    return this.data.history[`${subject}#${property}`] ?? [];
  }

  async markProcessed(contentKey: string, meta: Record<string, unknown>): Promise<boolean> {
    if (this.data.processed[contentKey]) return true;
    this.data.processed[contentKey] = { at: new Date().toISOString(), meta };
    await this.flush();
    return false;
  }
  async wasProcessed(contentKey: string): Promise<boolean> {
    return Boolean(this.data.processed[contentKey]);
  }

  async getCursor(name: string): Promise<string | undefined> {
    return this.data.cursors[name];
  }
  async setCursor(name: string, cursor: string): Promise<void> {
    this.data.cursors[name] = cursor;
    await this.flush();
  }

  async incrementMetric(name: string, by = 1): Promise<void> {
    this.data.metrics[name] = (this.data.metrics[name] ?? 0) + by;
    await this.flush();
  }
  async getMetrics(): Promise<Record<string, number>> {
    return { ...this.data.metrics };
  }
}
