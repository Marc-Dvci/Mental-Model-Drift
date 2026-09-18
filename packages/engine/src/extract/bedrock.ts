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
  private readonly region: string;

  constructor(private readonly registry: Registry, cfg: BedrockProposerConfig = {}) {
    this.region = cfg.region ?? process.env.AWS_REGION ?? 'us-east-1';
    this.client = new AnthropicBedrockMantle({ awsRegion: this.region });
    this.modelId = cfg.modelId ?? process.env.MMD_BEDROCK_MODEL_ID ?? 'anthropic.claude-opus-5';
    this.maxTokens = cfg.maxTokens ?? 2048;
  }

  /**
   * The same question, to a model family that speaks chat completions.
   *
   * Bedrock serves Anthropic models over the Messages API and every other
   * family over `/v1/chat/completions`, on the same host, under the same
   * bearer token. The proposer's job is to name a catalogue entry and quote
   * the words it read the value from; nothing about that is Anthropic-specific,
   * and the account this was first run against could invoke `openai.gpt-oss-120b`
   * and no Claude model. The JSON schema goes across as `response_format` and
   * the answer comes back through the same registry and quotation gates, so a
   * different family changes nothing downstream of this method.
   */
  private async completeViaChat(system: string, user: string): Promise<string> {
    const { getToken } = await import('@aws/bedrock-token-generator');
    const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers');
    const token = await getToken({ credentials: fromNodeProviderChain(), region: this.region });
    const response = await fetch(`https://bedrock-mantle.${this.region}.api.aws/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: this.modelId,
        max_tokens: this.maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'claims', schema: CLAIM_SCHEMA, strict: true } },
      }),
    });
    if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 400)}`);
    const body = (await response.json()) as { choices?: { message?: { content?: string | null } }[] };
    return body.choices?.[0]?.message?.content ?? '';
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

    let text: string;
    if (this.modelId.startsWith('anthropic.')) {
      const response = await this.client.messages.create({
        model: this.modelId,
        max_tokens: this.maxTokens,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userContent }],
        output_config: { format: { type: 'json_schema', schema: CLAIM_SCHEMA } },
      } as never);
      text = (response as { content: { type: string; text?: string }[] }).content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
    } else {
      text = await this.completeViaChat(SYSTEM, userContent);
    }

    // The model's raw answer, before the registry and quotation gates, because
    // "the model proposed nothing" and "the gates rejected everything it
    // proposed" are different failures with different fixes.
    if (process.env.MMD_DEBUG_BEDROCK === '1') console.error(`[bedrock] ${this.modelId} -> ${text.slice(0, 600)}`);
    const parsed = readClaimsObject(text);
    if (!parsed) return [];

    const out: Proposal[] = [];
    for (const raw of parsed.claims ?? []) {
      // The registry is checked here, not later: a proposal naming something
      // that does not exist is not a low-confidence claim, it is not a claim.
      const resolved = this.registry.resolve(raw.subject, raw.property);
      if (!resolved) continue;
      // A schema fact is about a column, and the schema requires the object
      // only in prose. A model that names the table and not the column has not
      // made a claim the registry can address, and letting it through produced
      // a second, objectless copy of the claim the grammar had already made.
      if (resolved.property.claimType === 'SCHEMA_FACT' && !raw.object) continue;
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

/**
 * The claims object, wherever the model put it.
 *
 * `openai.gpt-oss-120b` under `response_format: json_schema` answers with the
 * schema's object about two thirds of the time, and with a stray token in
 * front of it the rest: a lone `{`, or `[]`, then the object. Every one of those
 * answers was right about the sentence, and every one of them failed
 * `JSON.parse`, so the proposer reported nothing and the corpus read the model
 * as adding zero recall. The object is found by its `"claims"` key and read
 * from the brace that opens it, which tolerates a prefix and a wrapping array
 * alike and still refuses anything that is not that object.
 */
function readClaimsObject(text: string): { claims?: RawClaim[] } | undefined {
  try {
    const decoded: unknown = JSON.parse(text);
    const candidate = Array.isArray(decoded) ? decoded[0] : decoded;
    if (candidate && typeof candidate === 'object' && 'claims' in candidate) return candidate as { claims?: RawClaim[] };
  } catch {
    // fall through to the scan
  }
  const key = text.indexOf('"claims"');
  if (key === -1) return undefined;
  const open = text.lastIndexOf('{', key);
  if (open === -1) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === String.fromCharCode(92)) i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(open, i + 1)) as { claims?: RawClaim[] };
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
