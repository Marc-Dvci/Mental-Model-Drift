/**
 * Reading what Bee returns, in one place.
 *
 * A conversation's words are not a flat list. They sit under
 * `transcriptions[]`, and a conversation can hold two: the realtime pass while
 * it is being captured, and the final pass Bee writes once it has processed
 * the recording. A reader looking for `conversation.utterances` finds nothing
 * and reports an empty transcript, which is the failure this module exists to
 * make impossible.
 */
import { toIso } from './events.ts';
import type { BeeConversation, BeeUtterance } from './types.ts';

/**
 * The transcript Bee itself would show: the final transcription when there is
 * one, otherwise the realtime one, in spoken order.
 *
 * This is the rule `bee conversations get` applies. The order is imposed here
 * because the API does not guarantee it: utterances come back out of spoken
 * order, so they are sorted by `spoken_at`, then by recording offset, then by
 * id, which increases with time.
 */
export function pickTranscript(conversation: BeeConversation | undefined): BeeUtterance[] {
  const transcriptions = conversation?.transcriptions ?? [];
  const chosen = transcriptions.find((t) => t.realtime === false) ?? transcriptions[0];
  return [...(chosen?.utterances ?? [])].sort(spokenOrder);
}

/** Every utterance id in any of a conversation's transcriptions. */
export function utteranceIds(conversation: BeeConversation): Set<string> {
  const ids = new Set<string>();
  for (const t of conversation.transcriptions ?? []) {
    for (const u of t.utterances ?? []) if (u.id !== undefined) ids.add(String(u.id));
  }
  return ids;
}

function spokenOrder(a: BeeUtterance, b: BeeUtterance): number {
  const ta = spokenMs(a);
  const tb = spokenMs(b);
  if (ta !== undefined && tb !== undefined && ta !== tb) return ta - tb;
  if (typeof a.start === 'number' && typeof b.start === 'number' && a.start !== b.start) return a.start - b.start;
  return (a.id ?? 0) - (b.id ?? 0);
}

function spokenMs(u: BeeUtterance): number | undefined {
  const iso = toIso(u.spoken_at);
  return iso ? Date.parse(iso) : undefined;
}

/**
 * How many people a transcript's labels tell apart, or undefined when they
 * tell nothing.
 *
 * Bee labels every utterance "Unknown" (bee-cli issue #19), so a set of labels
 * is not a speaker count: one distinct label is the absence of diarisation,
 * not a monologue. Only real labels count, and an utterance still marked
 * unknown beside them counts as one more possible voice. Undefined is the
 * honest answer for a Bee transcript today, and it makes the wearer confirm a
 * belief before anything acts on it.
 */
export function labelledSpeakerCount(utterances: BeeUtterance[]): number | undefined {
  const labels = new Set<string>();
  let unlabelled = false;
  for (const u of utterances) {
    const label = typeof u.speaker === 'string' ? u.speaker.trim() : '';
    if (!label || label.toLowerCase() === 'unknown') unlabelled = true;
    else labels.add(label);
  }
  if (labels.size === 0) return undefined;
  return labels.size + (unlabelled ? 1 : 0);
}
