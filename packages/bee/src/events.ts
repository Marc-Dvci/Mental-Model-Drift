/**
 * Bee realtime frames carry no `event` field. The documented contract is that
 * clients discriminate on structural keys, so that discrimination lives in one
 * place and is tested rather than being repeated inline at three call sites.
 */
import { createHash } from 'node:crypto';
import type { BeeEvent, BeeStreamFrame, BeeUtterance } from './types.ts';

export function classifyEvent(frame: BeeStreamFrame): BeeEvent {
  if (frame && typeof frame === 'object') {
    if ('utterance' in frame && frame.utterance && typeof frame.utterance === 'object') {
      const u = frame.utterance as BeeUtterance;
      return {
        kind: 'new-utterance',
        utterance: u,
        conversationUuid: str(frame.conversation_uuid),
        conversationId: str(frame.conversation_id ?? frame.conversationId),
        raw: frame,
      };
    }
    if ('connected' in frame || frame.type === 'connected') return { kind: 'connected', raw: frame };
    if ('todo' in frame) return { kind: 'todo', raw: frame };
    if ('journal' in frame) return { kind: 'journal', raw: frame };
    if ('location' in frame) return { kind: 'update-location', raw: frame };
    if ('conversation' in frame) {
      const c = frame.conversation as Record<string, unknown> | undefined;
      if (c && ('short_summary' in c || 'summary' in c)) {
        return { kind: 'update-conversation-summary', raw: frame };
      }
      return { kind: 'new-conversation', raw: frame };
    }
  }
  return { kind: 'unknown', raw: frame };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined;
}

/**
 * Realtime Bee frames carry no global event id, so one is derived.
 *
 * The time bucket is coarse (10s) on purpose: it lets the same physical
 * utterance arriving twice -- once live, once through cursor reconciliation --
 * collapse to one id, while two genuinely repeated sentences minutes apart stay
 * distinct. Reconciled reads use `reconciledFingerprint` instead, because a
 * transcript read has a stable utterance index and no arrival time at all.
 */
export function realtimeFingerprint(ev: {
  conversationUuid?: string;
  conversationId?: string;
  speaker?: string;
  text: string;
  receivedAt?: number;
}): string {
  const bucket = Math.floor((ev.receivedAt ?? Date.now()) / 10_000);
  return sha256([
    'rt',
    ev.conversationUuid ?? ev.conversationId ?? 'unknown',
    ev.speaker ?? '',
    normaliseText(ev.text),
    String(bucket),
  ].join(' '));
}

export function reconciledFingerprint(ev: {
  conversationId: string;
  utteranceIndex: number;
  text: string;
}): string {
  return sha256(['rc', ev.conversationId, String(ev.utteranceIndex), normaliseText(ev.text)].join(' '));
}

/**
 * Content key shared by both paths. The two fingerprints differ by design (one
 * carries arrival time, one carries an index), so deduplication *across* the
 * live and reconciled paths keys on content plus conversation instead. This is
 * what makes an utterance that was streamed live and then re-read during
 * reconciliation get processed exactly once.
 */
export function contentKey(conversationRef: string, text: string): string {
  return sha256(['ck', conversationRef, normaliseText(text)].join(' '));
}

/**
 * Text normalisation for identity, not for display.
 *
 * A period between digits is part of a value ("4.12") and must survive.
 * Anywhere else it is sentence punctuation, and the live frame and the stored
 * transcript do not agree about sentence punctuation -- Bee re-punctuates when
 * it finalises a conversation. Keeping a trailing full stop here would let the
 * same utterance produce two content keys, and so two identical drift cards.
 */
export function normaliseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/(?<!\d)\.(?!\d)/g, ' ')
    .replace(/[^a-z0-9'.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 32);
}
