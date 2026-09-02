/**
 * Longitudinal recall -- has this belief been held before, and was it still
 * being used after the system changed?
 *
 * This is what separates the product from a code-search bot. A single stale
 * sentence is a slip. The same value stated in three conversations across six
 * weeks, twice of them after the config changed, is a mental model, and the
 * difference is visible only because Bee kept the earlier conversations and can
 * be searched semantically.
 *
 * The method matters: prior conversations are found with Bee's neural search,
 * then the *same deterministic grammar* used at capture is re-run over their
 * verbatim utterances. A hit counts only if it grounds to the same subject,
 * property and value. Nothing is counted because it looked topically similar.
 */
import type { BeeClient } from '#bee';
import type { PriorOccurrence } from '#spec';
import { GrammarProposer } from './extract/grammar.ts';
import { ground } from './grounding.ts';
import type { Registry } from './registry.ts';

export interface RecurrenceQuery {
  subject: string;
  property: string;
  /** Omit to find every value the wearer has stated for this property. */
  assertedValue?: unknown;
  object?: string;
  scope?: Record<string, string>;
  /** Exclude the conversation the claim was captured in. */
  excludeConversationId?: string;
  /** Utterances after this instant were spoken when the belief was already wrong. */
  sourceChangeAt?: string;
  /** Only look this far back. Defaults to 180 days. */
  sinceDays?: number;
}

export interface RecurrenceResult {
  occurrences: PriorOccurrence[];
  /** What was asked of Bee, verbatim, for the evidence panel. */
  query: string;
  conversationsSearched: number;
  searchMode: 'neural' | 'keyword' | 'unavailable';
  note?: string;
}

export class RecurrenceFinder {
  constructor(
    private readonly bee: BeeClient,
    private readonly registry: Registry,
    private readonly opts: { maxConversations?: number } = {},
  ) {}

  async find(q: RecurrenceQuery): Promise<RecurrenceResult> {
    const resolved = this.registry.resolve(q.subject, q.property);
    if (!resolved) return { occurrences: [], query: '', conversationsSearched: 0, searchMode: 'unavailable', note: 'unknown property' };

    // The query is built from the registry's own vocabulary rather than from
    // the utterance, so all conversations about this property are reachable,
    // not only ones phrased like the newest one.
    const query = [
      resolved.system.label ?? resolved.systemKey,
      ...resolved.system.aliases.slice(0, 2),
      ...resolved.property.lexemes.slice(0, 4),
    ].join(' ');

    const since = Date.now() - (q.sinceDays ?? 180) * 86_400_000;
    let hits;
    let searchMode: RecurrenceResult['searchMode'] = 'neural';
    try {
      hits = await this.bee.search(query, { neural: true, limit: 25 });
      if (hits.length === 0) {
        hits = await this.bee.search(query, { limit: 20, filter: 'conversations', sort: 'mostRecent', since });
        searchMode = 'keyword';
      }
    } catch (err) {
      return { occurrences: [], query, conversationsSearched: 0, searchMode: 'unavailable', note: (err as Error).message };
    }

    const proposer = new GrammarProposer(this.registry);
    const occurrences: PriorOccurrence[] = [];
    // Wide enough to cover a couple of months of a real person's conversations
    // about one system; the cost is a transcript read per conversation, and the
    // whole point of the feature is that a belief held since July still counts.
    const max = this.opts.maxConversations ?? 25;
    let searched = 0;

    for (const hit of hits) {
      if (searched >= max) break;
      const conversationId = String(hit.id);
      if (conversationId === q.excludeConversationId) continue;
      searched++;

      let utterances;
      try {
        utterances = await this.bee.transcript(conversationId);
      } catch {
        continue;
      }

      const texts = utterances.map((u) => u.text ?? '').filter(Boolean);
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i]!;
        const proposals = await proposer.propose({
          text,
          window: texts.slice(Math.max(0, i - 3), i),
          conversationId,
          utteranceIndex: i,
          capturedAt: hit.created_at ?? hit.start_time ?? new Date().toISOString(),
        });
        const match = proposals.find(
          (p) =>
            p.subject === q.subject &&
            p.property === q.property &&
            (q.assertedValue === undefined || looseEqual(p.assertedValue, q.assertedValue)) &&
            (q.object === undefined || p.object === q.object),
        );
        if (!match) continue;

        // The same gate as live capture. A question about retries in an old
        // conversation is not a prior occurrence of the belief.
        const g = ground({
          text,
          windowText: texts.slice(Math.max(0, i - 3), i).join(' '),
          subject: resolved.systemKey,
          subjectAliases: resolved.system.aliases,
          propertyKey: resolved.propertyKey,
          property: resolved.property,
          // With no value in the query, the gate is applied to whatever value
          // this utterance proposed -- the point is still that it was spoken.
          assertedValue: q.assertedValue ?? match.assertedValue,
          object: q.object ?? match.object,
          scope: q.scope,
        });
        if (!g.passed) continue;

        const at = normaliseTime(hit.created_at ?? hit.start_time) ?? new Date().toISOString();
        occurrences.push({
          conversationId,
          at,
          excerpt: trim(text),
          afterSourceChange: Boolean(q.sourceChangeAt && at > q.sourceChangeAt),
        });
        break; // one occurrence per conversation is enough to establish recurrence
      }
    }

    occurrences.sort((a, b) => a.at.localeCompare(b.at));
    return { occurrences, query, conversationsSearched: searched, searchMode };
  }
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function normaliseTime(v: unknown): string | undefined {
  if (typeof v === 'number') return new Date(v).toISOString();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  return undefined;
}

function trim(text: string, max = 180): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
