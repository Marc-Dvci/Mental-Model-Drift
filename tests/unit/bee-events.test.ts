/**
 * Bee's realtime frames carry no top-level event discriminator and no global
 * event id. Both facts are load-bearing for this product -- one forces
 * structural classification, the other forces derived fingerprints -- so both
 * are pinned here rather than assumed at three call sites.
 */
import { describe, expect, it } from 'vitest';
import { classifyEvent, contentKey, normaliseText, realtimeFingerprint, reconciledFingerprint } from '#bee';

describe('classifyEvent', () => {
  it('recognises a new utterance by structure, not by a type field', () => {
    const e = classifyEvent({
      utterance: { text: 'the checkout worker retries three times', speaker: 'speaker_1' },
      conversation_uuid: '9a41c2fe-52b8-4d77-b0e3-6f18cd4a2b55',
    });
    expect(e.kind).toBe('new-utterance');
    if (e.kind !== 'new-utterance') throw new Error('unreachable');
    expect(e.conversationUuid).toBe('9a41c2fe-52b8-4d77-b0e3-6f18cd4a2b55');
    expect(e.utterance.text).toMatch(/retries three times/);
  });

  it('separates a summary update from a new conversation', () => {
    expect(classifyEvent({ conversation: { id: 1, short_summary: 'Debugging the queue' } }).kind).toBe('update-conversation-summary');
    expect(classifyEvent({ conversation: { id: 1 } }).kind).toBe('new-conversation');
  });

  it('classifies the other documented frames', () => {
    expect(classifyEvent({ connected: true }).kind).toBe('connected');
    expect(classifyEvent({ todo: { id: 1 } }).kind).toBe('todo');
    expect(classifyEvent({ journal: { id: 1 } }).kind).toBe('journal');
    expect(classifyEvent({ location: { lat: 0, lng: 0 } }).kind).toBe('update-location');
  });

  it('returns `unknown` rather than throwing on a frame it has never seen', () => {
    // A new Bee event type must degrade capture, never crash the subscriber.
    expect(classifyEvent({ somethingNew: {} }).kind).toBe('unknown');
    expect(classifyEvent(null as never).kind).toBe('unknown');
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
