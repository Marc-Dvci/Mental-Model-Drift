/**
 * Reconciliation -- the reliability half of Bee ingestion.
 *
 * Bee's realtime stream is documented as at-most-once: "events that occur while
 * disconnected will not be received". A product that treats it as a queue will
 * silently miss exactly the conversations that happened while the laptop was
 * shut, which is most of them.
 *
 * So the stream is the fast path and `bee changed --cursor` is the correct one.
 * The cursor is persisted only after a batch has been fully processed, so a
 * crash mid-batch replays rather than skips, and the content-key dedupe in the
 * pipeline makes that replay harmless.
 */
import type { BeeClient } from '#bee';
import type { DriftEngine } from './pipeline.ts';
import type { Store } from './store/types.ts';

export interface ReconcileReport {
  ran: boolean;
  cursorBefore?: string;
  cursorAfter?: string;
  conversationsChanged: number;
  utterancesSeen: number;
  utterancesNew: number;
  claimsFound: number;
  driftsFound: number;
  error?: string;
}

export class Reconciler {
  constructor(
    private readonly bee: BeeClient,
    private readonly engine: DriftEngine,
    private readonly store: Store,
    private readonly cursorName = 'bee',
  ) {}

  async runOnce(): Promise<ReconcileReport> {
    const cursorBefore = await this.store.getCursor(this.cursorName);
    const report: ReconcileReport = {
      ran: true,
      ...(cursorBefore ? { cursorBefore } : {}),
      conversationsChanged: 0,
      utterancesSeen: 0,
      utterancesNew: 0,
      claimsFound: 0,
      driftsFound: 0,
    };

    let feed;
    try {
      feed = await this.bee.changed(cursorBefore);
    } catch (err) {
      return { ...report, ran: false, error: (err as Error).message };
    }

    const conversations = feed.conversations ?? [];
    report.conversationsChanged = conversations.length;

    for (const convo of conversations) {
      const id = String(convo.id);
      let utterances = convo.utterances ?? [];
      if (utterances.length === 0) {
        try {
          utterances = await this.bee.transcript(id);
        } catch {
          continue;
        }
      }
      const texts = utterances.map((u) => u.text ?? '');
      const speakers = new Set(utterances.map((u) => u.speaker ?? 'unknown'));

      for (let i = 0; i < utterances.length; i++) {
        const text = texts[i]!;
        if (!text.trim()) continue;
        report.utterancesSeen++;
        const outcome = await this.engine.ingestUtterance({
          text,
          conversationId: id,
          ...(convo.uuid ? { conversationUuid: convo.uuid } : {}),
          utteranceIndex: i,
          ...(utterances[i]?.speaker ? { speaker: utterances[i]!.speaker! } : {}),
          window: texts.slice(Math.max(0, i - 3), i),
          speakerCount: speakers.size,
          ...(convo.start_time || convo.created_at ? { capturedAt: normalise(convo.start_time ?? convo.created_at) } : {}),
          origin: 'reconciled',
        });
        if (outcome.duplicate) continue;
        report.utterancesNew++;
        report.claimsFound += outcome.claims.length;
        report.driftsFound += outcome.claims.filter((c) => c.driftId).length;
      }
    }

    // Only now, after every conversation in the batch has been processed.
    if (feed.meta?.next_cursor) {
      await this.store.setCursor(this.cursorName, feed.meta.next_cursor);
      report.cursorAfter = feed.meta.next_cursor;
    }
    return report;
  }

  /** Poll on an interval, and immediately whenever the caller reports a gap. */
  start(intervalMs = 120_000): { stop: () => void; runNow: () => Promise<ReconcileReport> } {
    let stopped = false;
    let inFlight: Promise<ReconcileReport> | null = null;

    const runNow = async (): Promise<ReconcileReport> => {
      if (inFlight) return inFlight;
      inFlight = this.runOnce().finally(() => {
        inFlight = null;
      });
      return inFlight;
    };

    const loop = async () => {
      while (!stopped) {
        await new Promise((r) => setTimeout(r, intervalMs));
        if (stopped) return;
        await runNow().catch(() => undefined);
      }
    };
    void loop();
    return { stop: () => { stopped = true; }, runNow };
  }
}

function normalise(v: unknown): string {
  if (typeof v === 'number') return new Date(v).toISOString();
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
}
