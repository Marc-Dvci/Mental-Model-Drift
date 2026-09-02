/**
 * Bee realtime event identity.
 *
 * THE DISCRIMINATOR IS THE SSE EVENT NAME.
 *
 * Bee's realtime transport is Server-Sent Events, and every frame carries its
 * type in the SSE `event:` line rather than inside the JSON payload:
 *
 *     event: new-utterance
 *     data: {"utterance":{"text":"…","speaker":"speaker_1"},"conversation_uuid":"…"}
 *
 * That name is authoritative, and it is what `bee stream` itself keys on: its
 * SSE parser drops any frame arriving without an `event:` line, and formats the
 * payload by switching on the name. A client that reads only `data:` throws the
 * discriminator away and then has to guess the type from the payload's shape.
 *
 * Guessing is not merely inelegant, it is wrong on real event types, because
 * the payloads are not disjoint:
 *
 *   - `update-conversation-summary` is flat -- `conversation_id` and
 *     `short_summary` at the top level, no `conversation` key at all -- so a
 *     structural reader looking inside `conversation` misses it entirely.
 *   - `new-conversation` and `delete-conversation` are both `{conversation:{…}}`
 *     and are structurally indistinguishable.
 *   - `journal-deleted` carries `journalId`, not `journal`, so it does not look
 *     like the other three journal events.
 *
 * So the name is used whenever it is present, and the structural reader is kept
 * only for transports that lose it -- which `bee stream --json` does: it prints
 * `event.data` alone, so a client piping the CLI's JSON mode sees strictly less
 * than one reading the SSE stream directly. Both transports exist in
 * `BeeClient`, and this is the single place that reconciles them.
 */
import { createHash } from 'node:crypto';
import type { BeeEvent, BeeEventKind, BeeStreamFrame, BeeUtterance } from './types.ts';

/**
 * The event names Bee's stream emits, as enumerated by `bee stream`'s own
 * `SUPPORTED_EVENT_TYPES`. `bee stream --types <list>` and `GET /v1/stream?types=`
 * filter on exactly these strings, so they are also what this product subscribes
 * with.
 */
export const BEE_STREAM_EVENTS = [
  // conversations
  'new-conversation',
  'update-conversation',
  'update-conversation-summary',
  'delete-conversation',
  'update-location',
  // transcription
  'new-utterance',
  // todos
  'todo-created',
  'todo-updated',
  'todo-deleted',
  // journals
  'journal-created',
  'journal-updated',
  'journal-deleted',
  'journal-text',
] as const;

export type BeeStreamEventName = (typeof BEE_STREAM_EVENTS)[number];

const KNOWN_NAMES = new Set<string>([...BEE_STREAM_EVENTS, 'connected']);

export function isBeeStreamEvent(name: string): name is BeeStreamEventName {
  return (BEE_STREAM_EVENTS as readonly string[]).includes(name);
}

/**
 * Classify one realtime frame.
 *
 * `name` is the SSE `event:` value, when the transport preserved it. Present
 * and recognised, it wins outright: the payload is then read as that type
 * rather than sniffed. Absent -- the CLI's `--json` mode, or a frame from a
 * future event type this build predates -- the structural reader makes the best
 * guess it can and marks the result `nameWasInferred`, so a guess is never
 * mistaken downstream for something Bee actually said.
 */
export function classifyEvent(frame: BeeStreamFrame, name?: string): BeeEvent {
  if (name && KNOWN_NAMES.has(name)) return byName(frame, name as BeeEventKind);
  const guessed = byShape(frame);
  // An unrecognised name is still better provenance than a shape guess: keep it
  // visible as unknown rather than mapping it onto whichever type this build
  // happens to recognise the shape of.
  if (name && guessed.kind !== 'unknown') return { kind: 'unknown', name, raw: frame };
  return guessed;
}

function byName(frame: BeeStreamFrame, kind: BeeEventKind): BeeEvent {
  if (kind === 'new-utterance') {
    return {
      kind: 'new-utterance',
      name: 'new-utterance',
      utterance: (frame?.utterance ?? { text: '' }) as BeeUtterance,
      conversationUuid: str(frame?.conversation_uuid),
      conversationId: str(frame?.conversation_id ?? frame?.conversationId),
      raw: frame,
    };
  }
  return { kind, name: kind, raw: frame };
}

/**
 * Fallback for transports that dropped the event name.
 *
 * Deliberately conservative, and honest about what it cannot know:
 * `{conversation:{…}}` is emitted by both `new-conversation` and
 * `delete-conversation` and genuinely cannot be told apart from the payload, so
 * it resolves to the commoner of the two and the ambiguity is recorded rather
 * than hidden.
 */
function byShape(frame: BeeStreamFrame): BeeEvent {
  if (!frame || typeof frame !== 'object') return { kind: 'unknown', raw: frame };

  if ('utterance' in frame && frame.utterance && typeof frame.utterance === 'object') {
    return {
      kind: 'new-utterance',
      name: 'new-utterance',
      nameWasInferred: true,
      utterance: frame.utterance as BeeUtterance,
      conversationUuid: str(frame.conversation_uuid),
      conversationId: str(frame.conversation_id ?? frame.conversationId),
      raw: frame,
    };
  }
  if ('connected' in frame || frame.type === 'connected') return inferred('connected', frame);
  // `update-conversation-summary` is flat: {conversation_id, short_summary}.
  if ('short_summary' in frame && ('conversation_id' in frame || 'conversationId' in frame)) {
    return inferred('update-conversation-summary', frame);
  }
  if ('todo' in frame) return inferred('todo-updated', frame);
  if ('journalId' in frame) return inferred('text' in frame ? 'journal-text' : 'journal-deleted', frame);
  if ('journal' in frame) return inferred('journal-updated', frame);
  if ('location' in frame) return inferred('update-location', frame);
  if ('conversation' in frame) return inferred('new-conversation', frame);
  return { kind: 'unknown', raw: frame };
}

function inferred(kind: BeeEventKind, frame: BeeStreamFrame): BeeEvent {
  return { kind, name: kind, nameWasInferred: true, raw: frame } as BeeEvent;
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
