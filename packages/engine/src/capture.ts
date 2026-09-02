/**
 * Capture: the two-path subscription to Bee, in one place.
 *
 * Bee documents realtime delivery as at-most-once -- events that occur while a
 * client is disconnected are not replayed. Every correct client therefore has
 * the same shape, and it is worth stating once rather than three times:
 *
 *   the stream          is the fast path. It is how a claim is checked while
 *                       the conversation is still happening.
 *   the changefeed      is the record. `changed --cursor` returns what changed
 *                       regardless of who was listening.
 *
 * A gap is closed from both ends. On disconnect, because everything Bee already
 * held should be pulled through before the outage widens. And on *reconnect*,
 * because what was recorded during the outage did not exist yet when the stream
 * dropped -- which is exactly the conversation that happened while the laptop
 * was shut, and the only one that actually matters.
 *
 * Reconciling only on disconnect looks correct and recovers nothing.
 */
import type { BeeClient, BeeEvent } from '#bee';
import type { ReconcileReport } from './reconcile.ts';

/**
 * Whatever closes a gap. The server passes a `Reconciler`, which reads the
 * changefeed itself; the relay passes a shim that asks the backend to do it,
 * because the relay owns no store and no cursor.
 */
export interface GapCloser {
  start(intervalMs?: number): { stop(): void; runNow(): Promise<ReconcileReport> };
}

export interface CaptureOptions {
  bee: BeeClient;
  reconciler: GapCloser;
  /** Called for every utterance the live stream delivers. */
  onUtterance: (event: Extract<BeeEvent, { kind: 'new-utterance' }>) => void | Promise<void>;
  /** Called after each reconciliation pass, whatever it found. */
  onReconciled?: (report: ReconcileReport, why: GapReason) => void;
  onConnect?: (isReconnect: boolean) => void;
  onDisconnect?: (reason: string) => void;
  /** Periodic sweep, for the gaps nothing signalled. Default 120s. */
  intervalMs?: number;
  types?: string[];
}

export type GapReason = 'stream lost' | 'stream restored';

export interface Capture {
  stop: () => void;
  /** Run a reconciliation pass now. Exposed for the manual endpoint. */
  reconcileNow: () => Promise<ReconcileReport>;
}

export function startCapture(opts: CaptureOptions): Capture {
  const polling = opts.reconciler.start(opts.intervalMs ?? 120_000);
  let connectedBefore = false;

  const closeTheGap = (why: GapReason): void => {
    void polling.runNow().then((report) => opts.onReconciled?.(report, why));
  };

  const stopStream = opts.bee.streamEvents(
    {
      onConnect: () => {
        const isReconnect = connectedBefore;
        connectedBefore = true;
        opts.onConnect?.(isReconnect);
        if (isReconnect) closeTheGap('stream restored');
      },
      onEvent: async (event) => {
        if (event.kind !== 'new-utterance') return;
        await opts.onUtterance(event);
      },
      onDisconnect: ({ reason }) => {
        opts.onDisconnect?.(reason);
        closeTheGap('stream lost');
      },
    },
    { types: opts.types ?? ['new-utterance'] },
  );

  return {
    stop: () => {
      stopStream();
      polling.stop();
    },
    reconcileNow: polling.runNow,
  };
}
