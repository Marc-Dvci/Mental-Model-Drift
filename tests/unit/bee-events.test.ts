/**
 * A live frame names its type twice -- the SSE `event:` line and its own
 * `type` field -- and carries the utterance's id and `spoken_at`. The
 * documentation's example payloads show none of the three. What a frame is,
 * and what it is keyed on, are load-bearing, so both are pinned here rather
 * than assumed at three call sites.
 */
import { describe, expect, it } from 'vitest';
import {
  BEE_STREAM_EVENTS,
  classifyEvent,
  contentKey,
  labelledSpeakerCount,
  normaliseText,
  pickTranscript,
  realtimeFingerprint,
  reconciledFingerprint,
} from '#bee';

/** A `new-utterance` frame as it arrives live. */
const LIVE = {
  type: 'new-utterance',
  conversation_uuid: '3f0c9a52-8e1d-4b7a-9c21-6d54e0b8a1f3',
  utterance: {
    id: 3676590930,
    sample_id: '0b6e2f41-7a3c-4d58-8e91-25c4f7a3d0e6',
    start: 12.47,
    end: 16.27,
    text: "It's probably fine. Checkout retries failed jobs three times anyway.",
    spoken_at: '2026-09-01T09:02:13.000Z',
  },
};

describe('classifyEvent', () => {
  it('reads a live new-utterance frame: the conversation uuid, the utterance id, and when it was spoken', () => {
    const e = classifyEvent(LIVE, 'new-utterance');
    expect(e.kind).toBe('new-utterance');
    if (e.kind !== 'new-utterance') throw new Error('unreachable');
    expect(e.conversationUuid).toBe('3f0c9a52-8e1d-4b7a-9c21-6d54e0b8a1f3');
    expect(e.utteranceId).toBe('3676590930');
    expect(e.spokenAt).toBe('2026-09-01T09:02:13.000Z');
    expect(e.utterance.text).toMatch(/three times anyway/);
    expect(e.utterance.speaker).toBeUndefined();
    expect(e.nameWasInferred).toBeUndefined();
  });

  it("reads the frame's own `type` when the transport dropped the SSE line", () => {
    // `bee stream --json` prints the data line alone. The type is still there.
    const e = classifyEvent(LIVE);
    expect(e.kind).toBe('new-utterance');
    expect(e.name).toBe('new-utterance');
    expect(e.nameWasInferred).toBeUndefined();
  });

  it('accepts every event name `bee stream` documents', () => {
    for (const name of BEE_STREAM_EVENTS) {
      expect(classifyEvent({}, name).kind).toBe(name);
      expect(classifyEvent({ type: name }).kind).toBe(name);
    }
    expect(classifyEvent({ timestamp: 1_760_000_000_000 }, 'connected').kind).toBe('connected');
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

  it('falls back to the payload shape only for a frame with no name and no type', () => {
    // A relay that rewrites frames could strip both. Capture still has to work,
    // so shape reading survives -- but every result it produces is marked,
    // because a guess must not be mistaken for something Bee said.
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
    expect(classifyEvent({ type: 'archive-conversation', conversation: { id: 1 } }).kind).toBe('unknown');
  });
});

describe('reading a conversation', () => {
  const conversation = {
    id: 10695705,
    state: 'PROCESSING',
    transcriptions: [
      {
        id: 14653536,
        realtime: true,
        utterances: [{ id: 3676588101, realtime: true, start: 3.4, end: 6.2, spoken_at: 1788253324000, text: 'Right, the checkout worker', speaker: 'Unknown' }],
      },
      {
        id: 14653537,
        realtime: false,
        utterances: [
          // Out of spoken order, as the API can return them.
          { id: 3676590930, realtime: false, start: 12.47, end: 16.27, spoken_at: 1788253333000, text: "It's probably fine.", speaker: 'Unknown' },
          { id: 3676590929, realtime: false, start: 3.47, end: 6.25, spoken_at: 1788253324000, text: 'Right, the checkout worker is throwing again.', speaker: 'Unknown' },
        ],
      },
    ],
  };

  it('takes the final transcription over the realtime one, in spoken order', () => {
    expect(pickTranscript(conversation).map((u) => u.id)).toEqual([3676590929, 3676590930]);
  });

  it('falls back to the realtime transcription while there is no final one', () => {
    const capturing = { ...conversation, state: 'CAPTURING', transcriptions: [conversation.transcriptions[0]!] };
    expect(pickTranscript(capturing).map((u) => u.text)).toEqual(['Right, the checkout worker']);
  });

  it('finds nothing in a flat utterances list, because Bee does not send one', () => {
    expect(pickTranscript({ id: 1, utterances: [{ text: 'x' }] } as never)).toEqual([]);
  });
});

describe('labelledSpeakerCount', () => {
  it('counts nothing when every speaker is "Unknown", which is what Bee returns', () => {
    expect(labelledSpeakerCount([{ text: 'a', speaker: 'Unknown' }, { text: 'b', speaker: 'Unknown' }])).toBeUndefined();
    expect(labelledSpeakerCount([{ text: 'a' }])).toBeUndefined();
  });

  it('counts real labels, and an unknown voice beside them as one more', () => {
    expect(labelledSpeakerCount([{ text: 'a', speaker: 'speaker_1' }])).toBe(1);
    expect(labelledSpeakerCount([{ text: 'a', speaker: 'speaker_1' }, { text: 'b', speaker: 'speaker_2' }])).toBe(2);
    expect(labelledSpeakerCount([{ text: 'a', speaker: 'speaker_1' }, { text: 'b', speaker: 'Unknown' }])).toBe(2);
  });
});

describe('fingerprints', () => {
  it('keys a live frame on the utterance id it carries', () => {
    const a = realtimeFingerprint({ utteranceId: '3676590930', text: 'it retries three times', receivedAt: 1_760_000_000_000 });
    const b = realtimeFingerprint({ utteranceId: '3676590930', text: 'It retries three times.', receivedAt: 1_760_000_300_000 });
    expect(a).toBe(b);
    expect(a).not.toBe(realtimeFingerprint({ utteranceId: '3676590931', text: 'it retries three times' }));
  });

  it('collapses an id-less frame arriving twice within a bucket', () => {
    const base = { conversationUuid: 'u1', text: 'it retries three times', receivedAt: 1_760_000_000_000 };
    expect(realtimeFingerprint(base)).toBe(realtimeFingerprint({ ...base, receivedAt: base.receivedAt + 900 }));
  });

  it('keeps two id-less sentences minutes apart distinct', () => {
    const base = { conversationUuid: 'u1', text: 'it retries three times', receivedAt: 1_760_000_000_000 };
    expect(realtimeFingerprint(base)).not.toBe(realtimeFingerprint({ ...base, receivedAt: base.receivedAt + 120_000 }));
  });

  it('gives a reconciled read a stable id from its utterance index', () => {
    const a = reconciledFingerprint({ conversationId: '10695705', utteranceIndex: 2, text: 'it retries three times' });
    const b = reconciledFingerprint({ conversationId: '10695705', utteranceIndex: 2, text: 'It retries three times!' });
    expect(a).toBe(b);
  });

  it('keys cross-path dedupe on content, which is what the two paths share', () => {
    // The live frame carries a realtime utterance id; the reconciled read, once
    // Bee has processed the conversation, carries a final one. Only content plus
    // conversation is common to both, and it is what stops one utterance
    // producing two cards.
    expect(contentKey('10695705', 'It retries three times.')).toBe(contentKey('10695705', 'it  retries   three times'));
    expect(contentKey('10695705', 'It retries three times.')).not.toBe(contentKey('10697402', 'It retries three times.'));
  });

  it('normalises punctuation and case but keeps decimal points', () => {
    expect(normaliseText('Still running 4.12, I think!')).toBe('still running 4.12 i think');
  });
});
