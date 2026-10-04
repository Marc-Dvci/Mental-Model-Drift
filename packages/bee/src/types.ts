/**
 * Types mirroring the Bee developer surface as documented at
 * https://docs.bee.computer/docs — the local API (`bee proxy`), the CLI
 * (`@beeai/cli`), and the realtime SSE stream (`bee stream`).
 *
 * Fields are optional wherever the docs do not guarantee them; Bee is a live
 * product and this client is written to tolerate additive change rather than to
 * assume a frozen contract.
 */

export interface BeeUser {
  id?: string | number;
  name?: string;
  email?: string;
  timezone?: string;
  [k: string]: unknown;
}

export interface BeeUtterance {
  text: string;
  /** Diarisation label, e.g. "speaker_1". NOT an identity. */
  speaker?: string;
  /** Present on transcript reads; absent on the realtime payload. */
  start?: number;
  end?: number;
  created_at?: string;
  [k: string]: unknown;
}

export interface BeeConversation {
  id: string | number;
  uuid?: string;
  short_summary?: string;
  summary?: string;
  state?: string;
  start_time?: string;
  end_time?: string;
  created_at?: string;
  utterances?: BeeUtterance[];
  [k: string]: unknown;
}

export interface BeeFact {
  id: string | number;
  text: string;
  confirmed?: boolean;
  created_at?: string;
  timezone?: string;
  [k: string]: unknown;
}

/** Shape of `bee changed --json` / `GET /v1/changes`. */
export interface BeeChangeFeed {
  meta: {
    next_cursor: string;
    since?: number;
    until?: number;
    updated?: boolean;
    timezone?: string;
  };
  facts?: BeeFact[];
  todos?: unknown[];
  dailies?: unknown[];
  conversations?: BeeConversation[];
  journals?: unknown[];
}

/**
 * The JSON body of a realtime frame -- the SSE `data:` line, parsed.
 *
 * The frame's *type* is not in here: it travels in the SSE `event:` line beside
 * it. `events.ts` is the only place allowed to decide what a frame is.
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
  /**
   * The SSE event name as it arrived, when the transport carried one. Absent
   * only for a frame that reached this build through a transport dropping it.
   */
  name?: string;
  /**
   * True when `kind` was deduced from the payload's shape because the transport
   * did not carry the name. Anything that acts rather than displays should
   * treat an inferred kind as lower confidence.
   */
  nameWasInferred?: boolean;
  raw: BeeStreamFrame;
}

export interface BeeNewUtteranceEvent extends BeeEventBase {
  kind: 'new-utterance';
  utterance: BeeUtterance;
  conversationUuid?: string;
  conversationId?: string;
}

export interface BeeOtherEvent extends BeeEventBase {
  kind: Exclude<BeeEventKind, 'new-utterance'>;
}

export type BeeEvent = BeeNewUtteranceEvent | BeeOtherEvent;

export interface BeeSearchOptions {
  limit?: number;
  filter?: 'conversations' | 'daily' | 'facts' | 'all';
  sort?: 'relevance' | 'mostRecent';
  neural?: boolean;
  since?: number;
  until?: number;
}

export interface BeeSearchHit {
  id: string | number;
  type?: string;
  score?: number;
  text?: string;
  short_summary?: string;
  created_at?: string;
  start_time?: string;
  [k: string]: unknown;
}
