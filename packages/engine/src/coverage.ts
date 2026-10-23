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
import { pickTranscript, toIso, type BeeClient, type BeeConversation, type BeeUtterance } from '#bee';
import type { Extractor } from './extract/index.ts';

export interface CoverageConversation {
  id: string;
  summary?: string;
  startedAt?: string;
  utterances: { text: string; speaker?: string; spokenAt?: string }[];
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
  /**
   * Distinct diarisation labels. Bee labels every utterance "Unknown", which is
   * not a speaker, so this is 0 for a Bee transcript today and the dashboard
   * leaves it out rather than print "1 distinct speaker".
   */
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
    // The list carries neither transcriptions nor the short summary, so each
    // conversation is read once in full.
    const conversations = await bee.listConversations({ limit });
    const out: CoverageConversation[] = [];
    for (const c of conversations) {
      const full = await bee.getConversation(String(c.id)).catch(() => c);
      out.push(toCoverageConversation(full));
    }
    return out;
  };
}

/** One Bee conversation as the survey reads it; `utterances` defaults to its own transcript. */
export function toCoverageConversation(c: BeeConversation, utterances: BeeUtterance[] = pickTranscript(c)): CoverageConversation {
  const startedAt = toIso(c.start_time);
  return {
    id: String(c.id),
    ...(c.short_summary ? { summary: c.short_summary } : {}),
    ...(startedAt ? { startedAt } : {}),
    utterances: utterances.map((u) => {
      const spokenAt = toIso(u.spoken_at);
      return {
        text: u.text,
        ...(u.speaker ? { speaker: u.speaker } : {}),
        ...(spokenAt ? { spokenAt } : {}),
      };
    }),
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

  const labels = new Set<string>();
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
      if (u.speaker && u.speaker.toLowerCase() !== 'unknown') labels.add(u.speaker);
      const at = u.spokenAt ?? convo.startedAt ?? '';
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
    speakers: labels.size,
    checkable,
    ignored: utterances - checkable,
    ...(earliest ? { earliest } : {}),
    ...(latest ? { latest } : {}),
    perProperty: [...perProperty].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count })),
    hits,
  };
}
