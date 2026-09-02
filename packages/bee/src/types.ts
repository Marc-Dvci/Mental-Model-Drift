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
 * A realtime stream frame.
 *
 * Bee's stream carries no top-level `event` discriminator; the docs instruct
 * clients to distinguish frames by structural keys. `classifyEvent` does that.
 */
export type BeeStreamFrame = Record<string, unknown>;

export interface BeeNewUtteranceEvent {
  kind: 'new-utterance';
  utterance: BeeUtterance;
  conversationUuid?: string;
  conversationId?: string;
  raw: BeeStreamFrame;
}

export interface BeeOtherEvent {
  kind:
    | 'connected'
    | 'new-conversation'
    | 'update-conversation'
    | 'update-conversation-summary'
    | 'delete-conversation'
    | 'update-location'
    | 'todo'
    | 'journal'
    | 'unknown';
  raw: BeeStreamFrame;
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
