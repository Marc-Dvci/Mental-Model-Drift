/**
 * The Bedrock proposer -- Claude on Amazon Bedrock, used for exactly one job:
 * turning a spoken sentence into a triple that names a registry entry.
 *
 * What it is asked:      which of these known properties is this sentence about,
 *                        and what value did the speaker give it?
 * What it is not asked:  is the speaker right?
 *
 * That boundary is the whole architecture. The model never sees a production
 * value, never sees evidence, and its output is passed through a deterministic
 * grounding gate before anything reaches a human. A hallucinated subject dies
 * at the registry; a hallucinated number dies at grounding.
 *
 * Utterances are redacted before they leave the process.
 */
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import type { Registry } from '../registry.ts';
import { redact } from '../redact.ts';
import type { ExtractionContext, Proposal, Proposer } from './types.ts';
import type { ClaimType } from '#spec';

export interface BedrockProposerConfig {
  region?: string;
  modelId?: string;
  maxTokens?: number;
}

const CLAIM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      description: 'Every registry-backed assertion the utterance makes. Empty when it makes none.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'property', 'claimType', 'assertedValue', 'confidence', 'spokenValue'],
        properties: {
          subject: { type: 'string', description: 'A subject key from the catalogue. Never invent one.' },
          property: { type: 'string', description: 'A property key belonging to that subject.' },
          claimType: { type: 'string', enum: ['CONFIG_VALUE', 'FEATURE_STATE', 'SCHEMA_FACT', 'DEPLOYMENT_VERSION'] },
          assertedValue: {
            type: ['string', 'number', 'boolean'],
            description: 'The value the speaker asserted, typed per the catalogue entry.',
          },
          spokenValue: {
            type: 'string',
            description: 'The exact substring of the utterance the value was read from. Must appear verbatim.',
          },
          object: { type: 'string', description: 'For SCHEMA_FACT, the object key being asserted about.' },
          scope: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Scope narrowing, e.g. {"region":"EU"}, only if the speaker said it.',
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
} as const;

const SYSTEM = `You map spoken engineering sentences onto a catalogue of known system properties.

You are one half of a verification pipeline. The other half reads the real value from production and decides whether the speaker was right. You must not try to do that half's job.

Rules, in order of importance:

1. Only ever name a subject and property that appear in the catalogue. If the sentence is about something not in the catalogue, return no claims.
2. Only report a value the speaker actually said. Copy the exact substring you read it from into spokenValue. If you cannot point at the words, there is no claim.
3. Only report statements about what the system IS. Not questions, not proposals, not opinions, not hypotheticals, not plans, not what it used to be, and not what someone else said. "It retries three times" is a claim. "Should it retry three times?", "let's make it retry three times", "three retries seems low", "maybe it retries three times", "it'll retry three times once we ship", and "I thought it retried three times" are all not.
4. A sentence may contain several claims, or none. Returning none is the common and correct outcome; most speech is not a claim about a catalogued property.
5. Never guess a scope. "Checkout is disabled" and "checkout is disabled in Europe" are different claims, and only the second has a scope.

Set confidence to how sure you are that this sentence asserts this property of this subject with this value. Be strict: a false claim about someone's beliefs is far more costly than a missed one.`;

export class BedrockProposer implements Proposer {
  readonly name = 'bedrock';
  private readonly client: AnthropicBedrockMantle;
  readonly modelId: string;
  private readonly maxTokens: number;

  constructor(private readonly registry: Registry, cfg: BedrockProposerConfig = {}) {
    const region = cfg.region ?? process.env.AWS_REGION ?? 'us-east-1';
    this.client = new AnthropicBedrockMantle({ awsRegion: region });
    this.modelId = cfg.modelId ?? process.env.MMD_BEDROCK_MODEL_ID ?? 'anthropic.claude-opus-5';
    this.maxTokens = cfg.maxTokens ?? 2048;
  }

  async propose(ctx: ExtractionContext): Promise<Proposal[]> {
    const utterance = redact(ctx.text).text;
    const window = (ctx.window ?? []).slice(-3).map((w) => redact(w).text);

    const userContent = [
      'Catalogue of known properties:',
      JSON.stringify(this.registry.promptCatalogue(), null, 1),
      '',
      window.length ? `Preceding lines (context only, do not extract claims from these):\n${window.map((w) => `- ${w}`).join('\n')}` : '',
      '',
      'Utterance to map:',
      utterance,
    ]
      .filter(Boolean)
      .join('\n');

    const response = await this.client.messages.create({
      model: this.modelId,
      max_tokens: this.maxTokens,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent }],
      output_config: { format: { type: 'json_schema', schema: CLAIM_SCHEMA } },
    } as never);

    const text = (response as { content: { type: string; text?: string }[] }).content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');

    let parsed: { claims?: RawClaim[] };
    try {
      parsed = JSON.parse(text) as { claims?: RawClaim[] };
    } catch {
      return [];
    }

    const out: Proposal[] = [];
    for (const raw of parsed.claims ?? []) {
      // The registry is checked here, not later: a proposal naming something
      // that does not exist is not a low-confidence claim, it is not a claim.
      const resolved = this.registry.resolve(raw.subject, raw.property);
      if (!resolved) continue;
      if (!raw.spokenValue || !ctx.text.toLowerCase().includes(raw.spokenValue.toLowerCase().trim())) {
        // The model was asked to quote the words it read the value from. If the
        // quote is not in the utterance, the value was invented.
        continue;
      }
      out.push({
        subject: resolved.systemKey,
        property: resolved.propertyKey,
        claimType: resolved.property.claimType as ClaimType,
        assertedValue: raw.assertedValue,
        object: raw.object,
        scope: raw.scope,
        confidence: clamp(raw.confidence ?? 0.5),
        proposer: 'bedrock',
        note: `quoted "${raw.spokenValue}"`,
      });
    }
    return out;
  }
}

interface RawClaim {
  subject: string;
  property: string;
  claimType: ClaimType;
  assertedValue: unknown;
  spokenValue?: string;
  object?: string;
  scope?: Record<string, string>;
  confidence?: number;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}
