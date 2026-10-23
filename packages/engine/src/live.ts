/**
 * One live `new-utterance` frame, turned into the pipeline's input.
 *
 * A live frame is one sentence with almost no context attached: the
 * conversation's uuid, the utterance's id and text, and when it was spoken.
 * Everything else the pipeline wants is read back from Bee:
 *
 *   the conversation id   the read endpoints and the reconciler know a
 *                         conversation only by its numeric id, and the
 *                         content-key dedupe has to see the same name from
 *                         both paths, so the uuid is resolved first;
 *   the window            the three sentences before this one, so a subject
 *                         the speaker has stopped naming can be resolved;
 *   the speaker count     from the transcript's labels, when they say anything.
 *
 * If Bee cannot be read at that instant the utterance is still processed, with
 * no window and an unknown speaker count, which makes the claim
 * UNKNOWN-ownership rather than dropping it. One function, so the server, the
 * relay's backend and the tests all take the same path.
 */
import { labelledSpeakerCount, normaliseText, type BeeClient, type BeeNewUtteranceEvent } from '#bee';
import type { UtteranceInput } from './pipeline.ts';

export async function liveUtteranceInput(
  bee: BeeClient,
  event: BeeNewUtteranceEvent,
  origin: UtteranceInput['origin'] = 'realtime',
): Promise<UtteranceInput> {
  const text = event.utterance.text ?? '';
  const resolved = await bee
    .resolveConversationId({
      ...(event.conversationId ? { id: event.conversationId } : {}),
      ...(event.conversationUuid ? { uuid: event.conversationUuid } : {}),
      ...(event.utteranceId ? { utteranceId: event.utteranceId } : {}),
      text,
    })
    .catch(() => undefined);
  // Unresolved, the uuid is the only name there is. The claim still stands; it
  // just cannot be matched with the same sentence read back later.
  const conversationId = resolved ?? event.conversationUuid ?? 'unknown';

  let window: string[] = [];
  let speakerCount: number | undefined;
  if (resolved) {
    try {
      const utterances = await bee.transcript(resolved);
      const needle = normaliseText(text);
      let idx = event.utteranceId ? utterances.findIndex((u) => String(u.id) === event.utteranceId) : -1;
      if (idx === -1) idx = utterances.findIndex((u) => normaliseText(u.text ?? '') === needle);
      const upto = idx === -1 ? utterances.length : idx;
      window = utterances.slice(Math.max(0, upto - 3), upto).map((u) => u.text ?? '');
      speakerCount = labelledSpeakerCount(utterances);
    } catch {
      /* the window is an optimisation, not a requirement */
    }
  }

  return {
    text,
    conversationId,
    ...(event.conversationUuid ? { conversationUuid: event.conversationUuid } : {}),
    ...(event.utterance.speaker ? { speaker: event.utterance.speaker } : {}),
    window,
    ...(speakerCount !== undefined ? { speakerCount } : {}),
    ...(event.spokenAt ? { capturedAt: event.spokenAt } : {}),
    origin,
  };
}
