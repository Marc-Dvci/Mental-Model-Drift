import type { Claim, DriftEvent, Evidence, HistoricalChange } from '#spec';

/**
 * What the product remembers.
 *
 * Two things are stored that ordinary observability does not keep: what a person
 * said they believed, and when the system stopped agreeing. Both are needed to
 * draw a timeline, and neither can be recovered later from the sources.
 *
 * What is deliberately *not* stored: transcripts. A claim keeps the one sentence
 * it came from and the Bee conversation id. Everything else stays in Bee, owner-
 * encrypted, and is fetched when a card is opened.
 */
export interface Store {
  putClaim(claim: Claim): Promise<void>;
  getClaim(id: string): Promise<Claim | undefined>;
  listClaims(opts?: { limit?: number }): Promise<Claim[]>;

  /** Evidence is append-only. An earlier reading is never overwritten. */
  putEvidence(evidence: Evidence): Promise<void>;
  listEvidence(claimId: string): Promise<Evidence[]>;

  putDrift(drift: DriftEvent): Promise<void>;
  getDrift(id: string): Promise<DriftEvent | undefined>;
  listDrifts(opts?: { limit?: number }): Promise<DriftEvent[]>;

  putHistory(subject: string, property: string, changes: HistoricalChange[]): Promise<void>;
  getHistory(subject: string, property: string): Promise<HistoricalChange[]>;

  /**
   * Idempotency for Bee ingestion.
   *
   * Returns true if this content key had already been recorded. The live stream
   * and the reconciliation pass will legitimately deliver the same utterance
   * twice, and the user must not see the same card twice because of it.
   */
  markProcessed(contentKey: string, meta: Record<string, unknown>): Promise<boolean>;
  wasProcessed(contentKey: string): Promise<boolean>;

  getCursor(name: string): Promise<string | undefined>;
  setCursor(name: string, cursor: string): Promise<void>;

  incrementMetric(name: string, by?: number): Promise<void>;
  getMetrics(): Promise<Record<string, number>>;
}
