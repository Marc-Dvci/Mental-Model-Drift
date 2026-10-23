/**
 * Types mirroring the Bee developer surface: the API behind `bee proxy`, the CLI
 * (`@beeai/cli`), and the realtime SSE stream (`bee stream`).
 *
 * The documentation gives example payloads but no response schemas, so these
 * follow what the API returns: the response types `@beeai/cli` declares for
 * itself, and the live frames the stream sends. Where the two disagree with the
 * documentation's examples, the API wins, and the difference is noted on the
 * field.
 *
 * Fields are optional wherever Bee does not guarantee them; Bee is a live
 * product and this client is written to tolerate additive change rather than to
 * assume a frozen contract.
 */

/** Bee times are epoch milliseconds, except the stream's `spoken_at`, which is ISO 8601. */
export type BeeTime = number | string;

export interface BeeUser {
  id?: number;
  first_name?: string;
  last_name?: string;
  timezone?: string;
  [k: string]: unknown;
}

export interface BeeUtterance {
  /** The same id the realtime frame carried, while the utterance is in a realtime transcription. */
  id?: number;
  realtime?: boolean;
  text: string;
  /**
   * Diarisation label. Bee returns "Unknown" for every utterance (bee-cli issue
   * #19), and the realtime frame carries no speaker at all. NOT an identity.
   */
  speaker?: string;
  /** Seconds from the start of the recording, not wall-clock times. */
  start?: number | null;
  end?: number | null;
  /** Wall-clock time the words were spoken: epoch ms on reads, ISO 8601 on the stream. */
  spoken_at?: BeeTime | null;
  created_at?: BeeTime;
  [k: string]: unknown;
}

/**
 * One pass of transcription over a conversation. While a conversation is being
 * captured it has a `realtime: true` transcription; once Bee has processed it,
 * the final `realtime: false` one replaces it, with its own utterance ids and
 * punctuation.
 */
export interface BeeTranscription {
  id?: number;
  realtime?: boolean;
  utterances?: BeeUtterance[];
  [k: string]: unknown;
}

/**
 * `GET /v1/conversations/:id` returns `{ conversation, timezone }`; the list
 * endpoint returns the same records without `transcriptions`.
 *
 * There is no `uuid` here. The realtime stream names a conversation by uuid
 * and every read endpoint by this numeric `id`; see `resolveConversationId`.
 */
export interface BeeConversation {
  id: number | string;
  start_time?: BeeTime;
  end_time?: BeeTime | null;
  summary?: string | null;
  short_summary?: string | null;
  /** `CAPTURING`, `PROCESSING` or `COMPLETED` on reads; the stream uses lowercase words of its own. */
  state?: string;
  created_at?: BeeTime;
  updated_at?: BeeTime;
  transcriptions?: BeeTranscription[];
  [k: string]: unknown;
}

export interface BeeFact {
  id: number | string;
  text: string;
  tags?: string[];
  confirmed?: boolean;
  created_at?: BeeTime;
  [k: string]: unknown;
}

/**
 * One reconciliation batch, whichever door it came through.
 *
 * The two doors disagree. `GET /v1/changes` returns bare ids with the cursor at
 * the top level; `bee changed --json` fetches each id itself and moves the
 * cursor into a `meta` object. `BeeClient.changed()` reads both into this.
 */
export interface BeeChangeBatch {
  /** Persist only after the batch has been processed. Absent when Bee sent none. */
  nextCursor?: string;
  since?: number;
  until?: number;
  /** Every conversation that changed after the cursor, as an id the read endpoints accept. */
  conversationIds: string[];
  /** Full records, when the transport already fetched them (the CLI does). */
  conversations: BeeConversation[];
}

/**
 * The JSON body of a realtime frame -- the SSE `data:` line, parsed. A live
 * frame repeats its type in a `type` field; the SSE `event:` line beside it
 * carries the same name. `events.ts` is the only place allowed to decide what
 * a frame is.
 */
export type BeeStreamFrame = Record<string, unknown>;

/**
 * Every event type Bee's stream emits, plus the transport's own `connected`
 * handshake and the `unknown` this build reports rather than guessing.
 */
export type BeeEventKind =
  | 'connected'
  | 'new-conversation'
  | 'update-conversation'
  | 'update-conversation-summary'
  | 'delete-conversation'
  | 'update-location'
  | 'new-utterance'
  | 'todo-created'
  | 'todo-updated'
  | 'todo-deleted'
  | 'journal-created'
  | 'journal-updated'
  | 'journal-deleted'
  | 'journal-text'
  | 'unknown';

interface BeeEventBase {
  /** The event name, from the SSE `event:` line or the frame's own `type`. */
  name?: string;
  /**
   * True when `kind` was deduced from the payload's shape because neither the
   * transport nor the frame named it. Anything that acts rather than displays
   * should treat an inferred kind as lower confidence.
   */
  nameWasInferred?: boolean;
  raw: BeeStreamFrame;
}

export interface BeeNewUtteranceEvent extends BeeEventBase {
  kind: 'new-utterance';
  utterance: BeeUtterance;
  conversationUuid?: string;
  conversationId?: string;
  /** The utterance's id, which is also its id in the conversation's realtime transcription. */
  utteranceId?: string;
  /** ISO 8601, when the frame carried `spoken_at`. */
  spokenAt?: string;
}

export interface BeeOtherEvent extends BeeEventBase {
  kind: Exclude<BeeEventKind, 'new-utterance'>;
}

export type BeeEvent = BeeNewUtteranceEvent | BeeOtherEvent;

export interface BeeSearchOptions {
  limit?: number;
  filter?: 'conversations' | 'daily' | 'facts' | 'all';
  sortBy?: 'relevance' | 'mostRecent';
  neural?: boolean;
  /** Epoch ms. Both modes accept a time bound. */
  since?: number;
  until?: number;
}

/**
 * A search result. The two modes answer differently: neural hits are
 * conversations, `id` a number, with `started_at`/`stopped_at`; keyword hits
 * carry a string `id`, a `type` and `created_at`.
 */
export interface BeeSearchHit {
  id: string | number;
  type?: string;
  score?: number;
  short_summary?: string | null;
  detailed_summary?: string | null;
  summary?: string | null;
  snippet?: string | null;
  started_at?: BeeTime | null;
  stopped_at?: BeeTime | null;
  created_at?: BeeTime | null;
  [k: string]: unknown;
}
