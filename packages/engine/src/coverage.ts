/**
 * "How much of what I say would this thing have an opinion about?"
 *
 * A dry run of extraction over recorded conversations. Every utterance goes
 * through the real proposers and the real grounding gate, and nothing else
 * happens: no source is read, no claim is stored, no card is raised.
 *
 * It exists because the honest answer to that question has to be *very little*,
 * and a product that reads someone's conversations should be able to prove it
 * before it is trusted with them rather than after. It is also the review that
 * matters when the registry changes: it says exactly what the change made the
 * system newly willing to speak about.
 *
 * The conversations come from a source rather than from Bee directly, so the
 * same code answers the question for a live account (`beeCoverageSource`) and
 * for a fixture directory, which is what the tests and the offline CLI use.
 */
import type { BeeClient, BeeConversation } from '#bee';
import type { Extractor } from './extract/index.ts';

export interface CoverageConversation {
  id: string;
  summary?: string;
  startedAt?: string;
  utterances: { text: string; speaker?: string; createdAt?: string }[];
}

export type CoverageSource = (limit: number) => Promise<CoverageConversation[]>;

export interface CoverageHit {
  conversationId: string;
  summary?: string;
  at: string;
  text: string;
  key: string;
  assertedValue: unknown;
  confidence: number;
  disposition: string;
}

export interface CoverageReport {
  conversations: number;
  utterances: number;
  speakers: number;
  /** Utterances that produced at least one grounded candidate. */
  checkable: number;
  /** Utterances the product would never have an opinion about. */
  ignored: number;
  earliest?: string;
  latest?: string;
  perProperty: { key: string; count: number }[];
  hits: CoverageHit[];
}

/** Read recorded conversations from a Bee account, newest first. */
export function beeCoverageSource(bee: BeeClient): CoverageSource {
  return async (limit) => {
    const conversations = await bee.listConversations({ limit });
    const out: CoverageConversation[] = [];
    for (const c of conversations) {
      const utterances = c.utterances?.length ? c.utterances : await bee.transcript(String(c.id)).catch(() => []);
      out.push(toCoverageConversation(c, utterances));
    }
    return out;
  };
}

function toCoverageConversation(c: BeeConversation, utterances: { text: string; speaker?: string; created_at?: string }[]): CoverageConversation {
  return {
    id: String(c.id),
    ...(c.short_summary ? { summary: c.short_summary } : {}),
    ...(c.start_time ? { startedAt: c.start_time } : {}),
    utterances: utterances.map((u) => ({
      text: u.text,
      ...(u.speaker ? { speaker: u.speaker } : {}),
      ...(u.created_at ? { createdAt: u.created_at } : {}),
    })),
  };
}

export async function surveyCoverage(
  source: CoverageSource,
  extractor: Extractor,
  opts: { limit?: number } = {},
): Promise<CoverageReport> {
  const conversations = (await source(opts.limit ?? 200)).sort((a, b) =>
    String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')),
  );

  const speakers = new Set<string>();
  const perProperty = new Map<string, number>();
  const hits: CoverageHit[] = [];
  let utterances = 0;
  let checkable = 0;
  let earliest: string | undefined;
  let latest: string | undefined;

  for (const convo of conversations) {
    const texts = convo.utterances.map((u) => u.text);
    for (let i = 0; i < convo.utterances.length; i++) {
      const u = convo.utterances[i]!;
      utterances++;
      speakers.add(u.speaker ?? 'unknown');
      const at = u.createdAt ?? convo.startedAt ?? '';
      if (at) {
        if (!earliest || at < earliest) earliest = at;
        if (!latest || at > latest) latest = at;
      }
      const result = await extractor.extract({
        text: u.text,
        window: texts.slice(Math.max(0, i - 3), i),
        conversationId: convo.id,
        utteranceIndex: i,
        capturedAt: at || new Date().toISOString(),
      });
      if (result.accepted.length === 0) continue;
      checkable++;
      for (const a of result.accepted) {
        const key = `${a.proposal.subject}.${a.proposal.property}`;
        perProperty.set(key, (perProperty.get(key) ?? 0) + 1);
        hits.push({
          conversationId: convo.id,
          ...(convo.summary ? { summary: convo.summary } : {}),
          at,
          text: u.text,
          key,
          assertedValue: a.proposal.assertedValue,
          confidence: a.confidence,
          disposition: a.disposition,
        });
      }
    }
  }

  return {
    conversations: conversations.length,
    utterances,
    speakers: speakers.size,
    checkable,
    ignored: utterances - checkable,
    ...(earliest ? { earliest } : {}),
    ...(latest ? { latest } : {}),
    perProperty: [...perProperty].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count })),
    hits,
  };
}
