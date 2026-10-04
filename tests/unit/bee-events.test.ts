/**
 * A realtime frame's type is the SSE `event:` name, and Bee carries no global
 * event id. Both facts are load-bearing -- one decides how a frame is read, the
 * other forces derived fingerprints -- so both are pinned here rather than
 * assumed at three call sites.
 */
import { describe, expect, it } from 'vitest';
import {
  BEE_STREAM_EVENTS,
  classifyEvent,
  contentKey,
  normaliseText,
  realtimeFingerprint,
  reconciledFingerprint,
} from '#bee';

describe('classifyEvent', () => {
  it('reads a new utterance named by the stream', () => {
    const e = classifyEvent(
      {
        utterance: { text: 'the checkout worker retries three times', speaker: 'speaker_1' },
        conversation_uuid: '9a41c2fe-52b8-4d77-b0e3-6f18cd4a2b55',
      },
      'new-utterance',
    );
    expect(e.kind).toBe('new-utterance');
    if (e.kind !== 'new-utterance') throw new Error('unreachable');
    expect(e.conversationUuid).toBe('9a41c2fe-52b8-4d77-b0e3-6f18cd4a2b55');
    expect(e.utterance.text).toMatch(/retries three times/);
    expect(e.nameWasInferred).toBeUndefined();
  });

  it('accepts every event name `bee stream` documents', () => {
    for (const name of BEE_STREAM_EVENTS) {
      expect(classifyEvent({}, name).kind).toBe(name);
    }
    expect(classifyEvent({ connected: true }, 'connected').kind).toBe('connected');
  });

  /**
   * The three payloads a shape-based reader gets wrong. Each is the reason the
   * name is read rather than the body:
   *
   *   - the summary update is flat, with no `conversation` key at all
   *   - a delete is byte-identical in shape to a new conversation
   *   - a journal delete carries `journalId`, not `journal`
   */
  it('reads the payloads whose shapes are not disjoint', () => {
    expect(classifyEvent({ conversation_id: 1, short_summary: 'Debugging the queue' }, 'update-conversation-summary').kind)
      .toBe('update-conversation-summary');

    const deleted = { conversation: { id: 1, title: 'Standup' } };
    expect(classifyEvent(deleted, 'delete-conversation').kind).toBe('delete-conversation');
    expect(classifyEvent(deleted, 'new-conversation').kind).toBe('new-conversation');

    expect(classifyEvent({ journalId: 7, reason: 'user' }, 'journal-deleted').kind).toBe('journal-deleted');
    expect(classifyEvent({ todo: { id: 1 } }, 'todo-created').kind).toBe('todo-created');
  });

  it('falls back to the payload shape only when the transport dropped the name', () => {
    // `bee stream --json` prints the data payload alone. Capture still has to
    // work, so shape reading survives -- but every result it produces is
    // marked, because a guess must not be mistaken for something Bee said.
    const e = classifyEvent({ utterance: { text: 'it retries three times' }, conversation_uuid: 'u1' });
    expect(e.kind).toBe('new-utterance');
    expect(e.nameWasInferred).toBe(true);

    expect(classifyEvent({ conversation_id: 1, short_summary: 'x' }).kind).toBe('update-conversation-summary');
    expect(classifyEvent({ journalId: 7 }).kind).toBe('journal-deleted');
    expect(classifyEvent({ location: { lat: 0, lng: 0 } }).kind).toBe('update-location');
  });

  it('returns `unknown` rather than throwing on a frame it has never seen', () => {
    // A new Bee event type must degrade capture, never crash the subscriber.
    expect(classifyEvent({ somethingNew: {} }).kind).toBe('unknown');
    expect(classifyEvent(null as never).kind).toBe('unknown');
  });

  it('trusts an unrecognised name over a shape that looks familiar', () => {
    // Bee adding `archive-conversation` must not be silently processed as a new
    // conversation just because the payload happens to match.
    const e = classifyEvent({ conversation: { id: 1 } }, 'archive-conversation');
    expect(e.kind).toBe('unknown');
    expect(e.name).toBe('archive-conversation');
  });
});

describe('fingerprints', () => {
  it('collapses the same live utterance arriving twice within a bucket', () => {
    const base = { conversationUuid: 'u1', speaker: 'speaker_1', text: 'it retries three times', receivedAt: 1_760_000_000_000 };
    expect(realtimeFingerprint(base)).toBe(realtimeFingerprint({ ...base, receivedAt: base.receivedAt + 900 }));
  });

  it('keeps two genuinely repeated sentences minutes apart distinct', () => {
    const base = { conversationUuid: 'u1', speaker: 'speaker_1', text: 'it retries three times', receivedAt: 1_760_000_000_000 };
    expect(realtimeFingerprint(base)).not.toBe(realtimeFingerprint({ ...base, receivedAt: base.receivedAt + 120_000 }));
  });

  it('gives a reconciled read a stable id from its utterance index', () => {
    const a = reconciledFingerprint({ conversationId: '10743', utteranceIndex: 2, text: 'it retries three times' });
    const b = reconciledFingerprint({ conversationId: '10743', utteranceIndex: 2, text: 'It retries three times!' });
    expect(a).toBe(b);
  });

  it('keys cross-path dedupe on content, which is what the two paths share', () => {
    // The live frame has an arrival time and no index; the reconciled read has
    // an index and no arrival time. Only content plus conversation is common to
    // both, and it is what stops one utterance producing two cards.
    expect(contentKey('10743', 'It retries three times.')).toBe(contentKey('10743', 'it  retries   three times'));
    expect(contentKey('10743', 'It retries three times.')).not.toBe(contentKey('10744', 'It retries three times.'));
  });

  it('normalises punctuation and case but keeps decimal points', () => {
    expect(normaliseText('Still running 4.12, I think!')).toBe('still running 4.12 i think');
  });
});
