/**
 * Bee realtime event identity.
 *
 * A live frame names itself twice. The SSE `event:` line carries the type, and
 * the JSON on the `data:` line repeats it in a `type` field, beside the
 * utterance's own id and the time it was spoken:
 *
 *     event: new-utterance
 *     data: {"type":"new-utterance","conversation_uuid":"…","utterance":{"id":3766760407,
 *            "sample_id":"…","start":680.16,"end":691.36,"text":"…","spoken_at":"2026-10-16T18:05:13.000Z"}}
 *
 * The documentation's example payloads leave out `type`, the utterance `id` and
 * `spoken_at`, and show a `speaker` that live frames do not carry. A client
 * written to those examples concludes there is no discriminator in the payload
 * and no id to key on; both are there.
 *
 * So a frame's name is read from the `event:` line when the transport kept it
 * (`bee proxy`), from the frame's own `type` when it did not (`bee stream
 * --json` prints the `data:` line alone), and from the payload's shape only for
 * a frame that has neither. Shape is a poor last resort, because the payloads
 * are not disjoint:
 *
 *   - `update-conversation-summary` is flat -- `conversation_id` and
 *     `short_summary` at the top level, no `conversation` key at all -- so a
 *     structural reader looking inside `conversation` misses it entirely.
 *   - `new-conversation` and `delete-conversation` are both `{conversation:{…}}`
 *     and are structurally indistinguishable.
 *   - `journal-deleted` carries `journalId`, not `journal`, so it does not look
 *     like the other three journal events.
 *
 * Both transports exist in `BeeClient`, and this is the single place that
 * reconciles them.
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
 * `name` is the SSE `event:` value, when the transport preserved it; failing
 * that, the frame's own `type`. Present and recognised, it wins outright: the
 * payload is then read as that type rather than sniffed. Absent -- a frame
 * from a relay that stripped both -- the structural reader makes the best guess
 * it can and marks the result `nameWasInferred`, so a guess is never mistaken
 * downstream for something Bee actually said.
 */
export function classifyEvent(frame: BeeStreamFrame, name?: string): BeeEvent {
  const named = name ?? (typeof frame?.type === 'string' ? frame.type : undefined);
  if (named && KNOWN_NAMES.has(named)) return byName(frame, named as BeeEventKind);
  const guessed = byShape(frame);
  // An unrecognised name is still better provenance than a shape guess: keep it
  // visible as unknown rather than mapping it onto whichever type this build
  // happens to recognise the shape of.
  if (named && guessed.kind !== 'unknown') return { kind: 'unknown', name: named, raw: frame };
  return guessed;
}

function byName(frame: BeeStreamFrame, kind: BeeEventKind): BeeEvent {
  if (kind === 'new-utterance') return utteranceEvent(frame);
  return { kind, name: kind, raw: frame };
}

function utteranceEvent(frame: BeeStreamFrame, inferred = false): BeeEvent {
  const utterance = (frame?.utterance && typeof frame.utterance === 'object' ? frame.utterance : { text: '' }) as BeeUtterance;
  const spokenAt = toIso(utterance.spoken_at);
  const utteranceId = str(utterance.id);
  return {
    kind: 'new-utterance',
    name: 'new-utterance',
    ...(inferred ? { nameWasInferred: true } : {}),
    utterance,
    conversationUuid: str(frame?.conversation_uuid),
    conversationId: str(frame?.conversation_id ?? frame?.conversationId),
    ...(utteranceId ? { utteranceId } : {}),
    ...(spokenAt ? { spokenAt } : {}),
    raw: frame,
  };
}

/**
 * Fallback for a frame that arrived with no name at all.
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
    return utteranceEvent(frame, true);
  }
  if ('connected' in frame) return inferred('connected', frame);
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

/** A Bee time -- epoch ms or ISO 8601 -- as ISO 8601, or undefined. */
export function toIso(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === 'string' && v) {
    const t = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  return undefined;
}

/**
 * Identity for one live frame.
 *
 * A live utterance carries its own id, and that is the identity. The derived
 * form -- conversation + normalised text + a coarse 10-second bucket -- exists
 * for a frame that arrives without one, so the same utterance arriving twice
 * collapses while two genuinely repeated sentences minutes apart stay distinct.
 */
export function realtimeFingerprint(ev: {
  conversationUuid?: string;
  conversationId?: string;
  utteranceId?: string;
  text: string;
  receivedAt?: number;
}): string {
  if (ev.utteranceId) return sha256(['rt', 'id', ev.utteranceId].join(' '));
  const bucket = Math.floor((ev.receivedAt ?? Date.now()) / 10_000);
  return sha256([
    'rt',
    ev.conversationUuid ?? ev.conversationId ?? 'unknown',
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
 * Content key shared by both paths.
 *
 * Utterance ids do not survive from one path to the other: the live frame
 * carries the id from the realtime transcription, and once Bee has processed
 * the conversation the final transcription replaces it with new ids. So
 * deduplication *across* the live and reconciled paths keys on content plus
 * the conversation's numeric id instead. This is what makes an utterance that
 * was streamed live and then re-read during reconciliation get processed
 * exactly once.
 */
export function contentKey(conversationRef: string, text: string): string {
  return sha256(['ck', conversationRef, normaliseText(text)].join(' '));
}

/**
 * Text normalisation for identity, not for display.
 *
 * A period between digits is part of a value ("4.12") and must survive.
 * Anywhere else it is sentence punctuation, and the realtime and the final
 * transcription do not agree about sentence punctuation. Keeping a trailing
 * full stop here would let the same utterance produce two content keys, and so
 * two identical drift cards.
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
