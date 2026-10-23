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
import { labelledSpeakerCount, pickTranscript, toIso, type BeeClient, type BeeConversation, type BeeUtterance } from '#bee';
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

    report.conversationsChanged = feed.conversationIds.length;
    const fetched = new Map(feed.conversations.map((c) => [String(c.id), c]));
    let unread = 0;

    for (const id of feed.conversationIds) {
      let utterances: BeeUtterance[];
      let convo: BeeConversation | undefined = fetched.get(id);
      try {
        convo ??= await this.bee.getConversation(id);
        utterances = pickTranscript(convo);
      } catch {
        // The cursor is held back below, so the next pass reads it again.
        unread++;
        continue;
      }
      const texts = utterances.map((u) => u.text ?? '');
      const speakerCount = labelledSpeakerCount(utterances);
      const startedAt = toIso(convo.start_time ?? convo.created_at);

      for (let i = 0; i < utterances.length; i++) {
        const text = texts[i]!;
        if (!text.trim()) continue;
        report.utterancesSeen++;
        const u = utterances[i]!;
        const capturedAt = toIso(u.spoken_at) ?? startedAt;
        const outcome = await this.engine.ingestUtterance({
          text,
          conversationId: id,
          utteranceIndex: i,
          ...(u.speaker ? { speaker: u.speaker } : {}),
          window: texts.slice(Math.max(0, i - 3), i),
          ...(speakerCount !== undefined ? { speakerCount } : {}),
          ...(capturedAt ? { capturedAt } : {}),
          origin: 'reconciled',
        });
        if (outcome.duplicate) continue;
        report.utterancesNew++;
        report.claimsFound += outcome.claims.length;
        report.driftsFound += outcome.claims.filter((c) => c.driftId).length;
      }
    }

    // Only now, after every conversation in the batch has been processed. A
    // conversation that could not be read keeps the cursor where it was; the
    // replay is harmless, because the content-key dedupe skips what was done.
    if (unread > 0) {
      report.error = `${unread} changed conversation(s) could not be read; the cursor was not advanced`;
    } else if (feed.nextCursor) {
      await this.store.setCursor(this.cursorName, feed.nextCursor);
      report.cursorAfter = feed.nextCursor;
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
