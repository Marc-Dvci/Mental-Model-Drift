import type { ClaimType, GroundingReport } from '#spec';

/** One system+property+value triple a proposer thinks was asserted. */
export interface Proposal {
  subject: string;
  property: string;
  claimType: ClaimType;
  assertedValue: unknown;
  object?: string;
  scope?: Record<string, string>;
  /** The proposer's own confidence, before grounding. */
  confidence: number;
  proposer: 'grammar' | 'bedrock';
  /** Free-text note for the evidence panel, e.g. which lexeme fired. */
  note?: string;
}

export interface ExtractionContext {
  /** The utterance under consideration. */
  text: string;
  /** A few preceding utterances of the same conversation, oldest first.
   *  Used only to resolve a subject the speaker has stopped naming. */
  window?: string[];
  conversationId: string;
  utteranceIndex?: number;
  speaker?: string;
  capturedAt: string;
}

export interface Proposer {
  readonly name: string;
  propose(ctx: ExtractionContext): Promise<Proposal[]>;
}

export interface ExtractionResult {
  proposals: Proposal[];
  accepted: AcceptedClaim[];
  rejected: RejectedProposal[];
  /** Which proposers ran, and whether each succeeded. */
  proposerStatus: { name: string; ok: boolean; ms: number; error?: string }[];
}

export interface AcceptedClaim {
  proposal: Proposal;
  grounding: GroundingReport;
  /** Post-gate confidence. This is what the thresholds are applied to. */
  confidence: number;
  /** True when an independent proposer produced the same triple. */
  corroborated: boolean;
}

export interface RejectedProposal {
  proposal: Proposal;
  reason: string;
  stage: 'registry' | 'grounding' | 'threshold' | 'ambiguity';
}
