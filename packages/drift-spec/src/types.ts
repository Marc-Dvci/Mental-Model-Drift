/**
 * drift-spec — a portable schema for verifying human assertions about software
 * systems against authoritative machine-readable sources.
 *
 * The spec is deliberately independent of Bee, AWS, GitHub and of any language
 * model. It describes four things:
 *
 *   1. a typed *assertion* a person made about a system;
 *   2. a *registry* naming which source is authoritative for which property;
 *   3. immutable *evidence* retrieved from such a source;
 *   4. a deterministic *verdict* relating the two.
 *
 * No part of this package may consult a language model. Extraction (natural
 * language -> assertion) happens upstream; adjudication happens here, and it is
 * pure.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

/** Assertion classes the MVP knows how to adjudicate. */
export type ClaimType =
  | 'CONFIG_VALUE'
  | 'FEATURE_STATE'
  | 'SCHEMA_FACT'
  | 'DEPLOYMENT_VERSION';

/** Value domains a registry property may declare. */
export type ValueType = 'integer' | 'number' | 'boolean' | 'semver' | 'string' | 'presence';

/**
 * How confident we are that the *wearer* holds the belief, as opposed to
 * someone else who happened to be in the room. Speaker diarisation labels are
 * not identity, so this is never inferred silently as LIKELY_USER.
 */
export type Ownership = 'LIKELY_USER' | 'UNKNOWN' | 'USER_CONFIRMED';

/**
 * Four verdicts, never two. A binary true/false forces connector failures and
 * ambiguity to masquerade as drift, which is the single worst failure mode of a
 * product that tells people they are wrong.
 */
export type Verdict = 'SUPPORTED' | 'DRIFTED' | 'INCONCLUSIVE' | 'UNSUPPORTED_TYPE';

export type ClaimStatus =
  | 'CANDIDATE'
  | 'VERIFYING'
  | 'SUPPORTED'
  | 'DRIFTED'
  | 'INCONCLUSIVE'
  | 'DISMISSED';

/** A typed assertion, resolved against a registry entry. */
export interface Claim {
  id: string;
  userId: string;

  /** Provenance in the ambient capture system (Bee). */
  sourceConversationId: string;
  sourceUtteranceIndex?: number;
  /** The minimum excerpt needed to justify the claim. Never a full transcript. */
  originalText: string;

  claimType: ClaimType;
  /** Registry system key, e.g. "checkout-worker". */
  subject: string;
  /** Registry property key, e.g. "retry.max_attempts". */
  property: string;
  /** Optional narrowing, e.g. { region: "EU" }. */
  scope?: Record<string, string>;
  /** Object of a relational claim, e.g. the column name for SCHEMA_FACT. */
  object?: string;

  assertedValue: unknown;
  valueType: ValueType;

  ownership: Ownership;
  extractionConfidence: number;
  /** Deterministic gates the candidate passed. See @mmd/engine grounding. */
  grounding?: GroundingReport;

  capturedAt: string;
  status: ClaimStatus;
}

export interface GroundingReport {
  speechAct: string;
  subjectAliasMatched: string | null;
  valueLiteralMatched: string | null;
  propertyLexemeMatched: string | null;
  passed: boolean;
  rejectedBy?: string;
}

/** Where a value can be read from, and whether that reading is authoritative. */
export interface SourceRef {
  adapter: string;
  authoritative: boolean;
  /** Adapter-specific addressing. Opaque to the spec. */
  locator: Record<string, unknown>;
}

export interface RegistryProperty {
  type: ValueType;
  /** Blast radius if the wearer acts on a stale belief. Set by a human. */
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
  claimType: ClaimType;
  /** Words that, in the wearer's speech, point at this property. */
  lexemes: string[];
  authoritative_source: SourceRef;
  /** Optional source used only to reconstruct when the value changed. */
  historical_source?: SourceRef;
  /** Human-readable label for the UI. */
  label?: string;
  /** Documentation files that restate this value and may need correcting. */
  documents?: { adapter: string; locator: Record<string, unknown> }[];
  /**
   * Spoken vocabulary for each scope dimension, e.g.
   *   scopes: { region: { EU: ["europe", "eu", "emea"] } }
   * A property that declares scopes will not accept a claim whose scope cannot
   * be resolved from the words actually spoken.
   */
  scopes?: Record<string, Record<string, string[]>>;
  /** For SCHEMA_FACT: the spoken names of the object being asserted about. */
  objectAliases?: Record<string, string[]>;
}

export interface RegistrySystem {
  aliases: string[];
  label?: string;
  properties: Record<string, RegistryProperty>;
}

export interface SourceRegistry {
  version: 1;
  systems: Record<string, RegistrySystem>;
}

/** The outcome of asking one source for one value, at one instant. Immutable. */
export interface Evidence {
  id: string;
  claimId: string;
  source: string;
  /** Human-checkable address of what was read: URL, ARN, path#jsonpath. */
  sourceLocator: string;
  status: 'OK' | 'UNAVAILABLE' | 'NOT_FOUND' | 'AMBIGUOUS' | 'FORBIDDEN';
  value: unknown;
  valueType?: ValueType;
  authoritative: boolean;
  /** Version identity of the thing read, when the source has one. */
  version?: string;
  commitSha?: string;
  fetchedAt: string;
  /** Hash of what was read, excluding when: equal hashes mean the source still says the same thing. */
  evidenceHash: string;
  error?: string;
}

/** A point where an authoritative value changed, reconstructed after the fact. */
export interface HistoricalChange {
  at: string;
  from: unknown;
  to: unknown;
  source: string;
  locator: string;
  commitSha?: string;
  author?: string;
  message?: string;
}

export interface DriftEvent {
  id: string;
  claimId: string;
  subject: string;
  property: string;
  assertedValue: unknown;
  actualValue: unknown;
  verdict: Verdict;
  detectedAt: string;
  /** When the authoritative value moved away from what the wearer said. */
  sourceChangeAt?: string;
  sourceChangeCommit?: string;
  /** Earlier conversations in which the same stale value was spoken. */
  priorOccurrences: PriorOccurrence[];
  severity: Severity;
  /**
   * True when the reading has not earned the right to act on its own: either
   * extraction was not confident enough, or the conversation had more than one
   * speaker and the belief cannot be attributed to the wearer. Such a card is
   * still shown -- it asks a question before it offers an action.
   */
  confirmationRequired: boolean;
  ownership: Ownership;
  resolution:
    | 'OPEN'
    | 'ACKNOWLEDGED'
    | 'NOT_MY_BELIEF'
    | 'DOCS_FIXED'
    | 'MODEL_UPDATED'
    | 'FALSE_POSITIVE';
}

export interface PriorOccurrence {
  conversationId: string;
  at: string;
  excerpt: string;
  /** True when the utterance post-dates the change that made it wrong. */
  afterSourceChange: boolean;
}

export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * The adapter contract. `verify` answers "what is it now"; `history` answers
 * "when did it stop being what they said". An adapter that cannot answer must
 * return non-OK evidence, never a guess.
 */
export interface Verifier {
  readonly name: string;
  canVerify(claim: Claim, source: SourceRef): boolean;
  verify(claim: Claim, source: SourceRef): Promise<Evidence>;
  history?(claim: Claim, source: SourceRef): Promise<HistoricalChange[]>;
}

export interface Adjudication {
  verdict: Verdict;
  reason: string;
  normalisedAsserted?: unknown;
  normalisedActual?: unknown;
}
