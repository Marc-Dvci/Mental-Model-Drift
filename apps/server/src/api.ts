/**
 * The API the dashboard reads, and the ingest endpoint a Bee relay writes to.
 *
 * Everything here is a thin projection over the engine. The interesting rule is
 * what is *not* exposed: there is no endpoint that returns transcripts, and no
 * endpoint that returns another user's anything. A drift card carries the one
 * sentence its claim came from and the conversation id it came from, and a
 * client that wants more has to go and ask Bee, as the owner, itself.
 */
import { randomUUID } from 'node:crypto';
import { classifyEvent, type BeeStreamFrame } from '#bee';
import {
  beeCoverageSource,
  buildEngine,
  GitHubPullRequestWriter,
  preparePatch,
  Reconciler,
  renderPullRequestBody,
  surveyCoverage,
  type BuiltEngine,
  type PipelineEvent,
} from '#engine';
import { scoreSeverity, type Claim, type DriftEvent, type Evidence, type HistoricalChange } from '#spec';

export interface ApiContext {
  built: BuiltEngine;
  reconciler: Reconciler;
  subscribers: Set<(event: ServerEvent) => void>;
  startedAt: string;
  coverage?: { at: number; report: Awaited<ReturnType<typeof surveyCoverage>> };
}

export type ServerEvent = PipelineEvent | { type: 'reconcile'; at: string; report: unknown } | { type: 'hello'; at: string };

export function createContext(onEvent?: (e: ServerEvent) => void): ApiContext {
  const subscribers = new Set<(event: ServerEvent) => void>();
  const publish = (event: ServerEvent) => {
    onEvent?.(event);
    for (const s of subscribers) s(event);
  };
  const built = buildEngine({ onEvent: publish });
  return {
    built,
    reconciler: new Reconciler(built.bee, built.engine, built.store),
    subscribers,
    startedAt: new Date().toISOString(),
  };
}

// ------------------------------------------------------------------ read side

export async function getStatus(ctx: ApiContext) {
  const health = await ctx.built.bee.health();
  const metrics = await ctx.built.store.getMetrics();
  const cursor = await ctx.built.store.getCursor('bee');
  return {
    startedAt: ctx.startedAt,
    ...ctx.built.describe(),
    bee: {
      transport: health.transport,
      connected: health.ok,
      detail: health.detail,
      cursor: cursor ?? null,
    },
    metrics,
    registrySystems: ctx.built.registry.systemKeys().map((key) => {
      const system = ctx.built.registry.system(key)!;
      return {
        key,
        label: system.label ?? key,
        properties: Object.entries(system.properties).map(([p, prop]) => ({
          key: p,
          label: prop.label ?? p,
          type: prop.type,
          impact: prop.impact,
          claimType: prop.claimType,
          source: prop.authoritative_source.adapter,
          historicalSource: prop.historical_source?.adapter ?? null,
        })),
      };
    }),
  };
}

export interface DriftCard {
  drift: DriftEvent;
  claim: Claim | undefined;
  label: string;
  systemLabel: string;
  evidence: Evidence[];
  change?: HistoricalChange;
  severityBreakdown: ReturnType<typeof scoreSeverity>;
}

const SEVERITY_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * A worklist, not a log.
 *
 * Severity first, then how many times the person has said it. A belief stated
 * once may be a slip; the same belief in six conversations is the thing they
 * will reason from again tomorrow, so it goes above a one-off of equal
 * severity. Detection time only breaks the remaining ties.
 */
export async function listDrifts(ctx: ApiContext): Promise<DriftCard[]> {
  const drifts = await ctx.built.store.listDrifts({ limit: 100 });
  const cards = await Promise.all(drifts.map((d) => cardFor(ctx, d)));
  return cards.sort((a, b) => {
    const bySeverity = (SEVERITY_ORDER[a.drift.severity] ?? 3) - (SEVERITY_ORDER[b.drift.severity] ?? 3);
    if (bySeverity !== 0) return bySeverity;
    const byRepetition = b.drift.priorOccurrences.length - a.drift.priorOccurrences.length;
    if (byRepetition !== 0) return byRepetition;
    return Date.parse(b.drift.detectedAt) - Date.parse(a.drift.detectedAt);
  });
}

export async function getDrift(ctx: ApiContext, id: string): Promise<DriftCard | undefined> {
  const drift = await ctx.built.store.getDrift(id);
  return drift ? cardFor(ctx, drift) : undefined;
}

async function cardFor(ctx: ApiContext, drift: DriftEvent): Promise<DriftCard> {
  const claim = await ctx.built.store.getClaim(drift.claimId);
  const evidence = await ctx.built.store.listEvidence(drift.claimId);
  const resolved = ctx.built.registry.resolve(drift.subject, drift.property);
  const history = await ctx.built.store.getHistory(drift.subject, drift.property);
  const change = history.find((c) => String(c.from) === String(drift.assertedValue));
  return {
    drift,
    claim,
    label: resolved?.property.label ?? `${drift.subject}.${drift.property}`,
    systemLabel: resolved?.system.label ?? drift.subject,
    evidence,
    ...(change ? { change } : {}),
    severityBreakdown: scoreSeverity({
      impact: resolved?.property.impact ?? 'MEDIUM',
      priorOccurrences: drift.priorOccurrences,
      detectedAt: drift.detectedAt,
      ...(claim ? { lastSpokenAt: claim.capturedAt } : {}),
      ...(drift.sourceChangeAt ? { sourceChangeAt: drift.sourceChangeAt } : {}),
    }),
  };
}

/**
 * Every claim, including the ones that agreed.
 *
 * This view exists to make the product's central promise inspectable: most of
 * what is heard produces nothing. A user who suspects the tool is over-firing
 * should be able to see exactly how much it stayed quiet about.
 */
export async function listClaims(ctx: ApiContext) {
  const claims = await ctx.built.store.listClaims({ limit: 200 });
  return Promise.all(
    claims.map(async (claim) => ({
      claim,
      label: ctx.built.registry.resolve(claim.subject, claim.property)?.property.label ?? `${claim.subject}.${claim.property}`,
      evidence: await ctx.built.store.listEvidence(claim.id),
    })),
  );
}

/**
 * The mental-model timeline: two series on one axis.
 *
 * `system` is what the authoritative value was, over time. `spoken` is when the
 * wearer said what. The story the picture tells is the gap between the moment
 * the first series steps and the moment the second one stops repeating the old
 * value.
 */
export async function getTimeline(ctx: ApiContext, subject: string, property: string) {
  const history = await ctx.built.store.getHistory(subject, property);
  const claims = (await ctx.built.store.listClaims({ limit: 500 })).filter(
    (c) => c.subject === subject && c.property === property,
  );
  const drifts = (await ctx.built.store.listDrifts({ limit: 200 })).filter(
    (d) => d.subject === subject && d.property === property,
  );
  const resolved = ctx.built.registry.resolve(subject, property);

  const spoken = [
    ...claims.map((c) => ({
      at: c.capturedAt,
      value: c.assertedValue,
      excerpt: c.originalText,
      conversationId: c.sourceConversationId,
      status: c.status,
      live: true,
    })),
    ...drifts.flatMap((d) =>
      d.priorOccurrences.map((o) => ({
        at: o.at,
        value: d.assertedValue,
        excerpt: o.excerpt,
        conversationId: o.conversationId,
        status: o.afterSourceChange ? 'STALE' : 'CORRECT_AT_THE_TIME',
        live: false,
      })),
    ),
  ]
    .filter((s, i, arr) => arr.findIndex((x) => x.conversationId === s.conversationId && x.excerpt === s.excerpt) === i)
    .sort((a, b) => a.at.localeCompare(b.at));

  return {
    subject,
    property,
    label: resolved?.property.label ?? `${subject}.${property}`,
    systemLabel: resolved?.system.label ?? subject,
    valueType: resolved?.property.type ?? 'string',
    system: [...history].sort((a, b) => a.at.localeCompare(b.at)),
    spoken,
  };
}

// ----------------------------------------------------------------- write side

export async function ingestBeeFrame(ctx: ApiContext, frame: BeeStreamFrame, origin: 'realtime' | 'reconciled' = 'realtime') {
  const event = classifyEvent(frame);
  if (event.kind !== 'new-utterance') return { ignored: event.kind };
  const ref = event.conversationId ?? event.conversationUuid ?? 'unknown';
  const conversationId = await ctx.built.bee.resolveConversationId(ref).catch(() => ref);

  // A live frame is one sentence with no history attached, so the window and the
  // speaker count are read back from Bee. If Bee is unreachable at that instant
  // the utterance is still processed -- with an unknown speaker count, which
  // makes the claim UNKNOWN-ownership rather than dropping it.
  let window: string[] = [];
  let speakerCount: number | undefined;
  try {
    const utterances = await ctx.built.bee.transcript(conversationId);
    const idx = utterances.findIndex((u) => u.text === event.utterance.text);
    const upto = idx === -1 ? utterances.length : idx;
    window = utterances.slice(Math.max(0, upto - 3), upto).map((u) => u.text ?? '');
    speakerCount = new Set(utterances.map((u) => u.speaker ?? 'unknown')).size;
  } catch {
    /* the window is an optimisation, not a requirement */
  }

  return ctx.built.engine.ingestUtterance({
    text: event.utterance.text,
    conversationId,
    ...(event.conversationUuid ? { conversationUuid: event.conversationUuid } : {}),
    ...(event.utterance.speaker ? { speaker: event.utterance.speaker } : {}),
    window,
    ...(speakerCount !== undefined ? { speakerCount } : {}),
    origin,
  });
}

export async function confirmDrift(ctx: ApiContext, id: string) {
  const drift = await ctx.built.store.getDrift(id);
  if (!drift) return undefined;
  const claim = await ctx.built.store.getClaim(drift.claimId);
  if (claim) await ctx.built.store.putClaim({ ...claim, ownership: 'USER_CONFIRMED' });
  const updated: DriftEvent = { ...drift, confirmationRequired: false, ownership: 'USER_CONFIRMED' };
  await ctx.built.store.putDrift(updated);
  return updated;
}

/**
 * Prepare a documentation correction without touching anything.
 *
 * Always available; opening the pull request is a separate, explicitly gated
 * call. A tool that reads your conversations should not also be a tool that
 * writes to your repository by default.
 */
export async function prepareDocsPatch(ctx: ApiContext, id: string) {
  const card = await getDrift(ctx, id);
  if (!card) return undefined;
  const resolved = ctx.built.registry.resolve(card.drift.subject, card.drift.property);
  const docs = resolved?.property.documents ?? [];
  if (docs.length === 0) return { patches: [], reason: 'no documents are registered for this property' };

  const patches = [];
  for (const doc of docs) {
    const locator = doc.locator as { repository: string; path: string };
    let content: string;
    try {
      const evidence = await ctx.built.github.verify(
        { ...(card.claim as Claim), id: randomUUID() },
        { adapter: 'github', authoritative: false, locator: { ...locator, json_path: '$' } },
      );
      // The verifier reads structured values; for prose we need the raw file.
      content = await readRaw(ctx, locator);
      void evidence;
    } catch (err) {
      patches.push({ path: locator.path, error: (err as Error).message, hunks: [], changed: false });
      continue;
    }
    const patch = preparePatch({
      path: locator.path,
      content,
      oldValue: card.drift.assertedValue,
      newValue: card.drift.actualValue,
      lexemes: resolved!.property.lexemes,
    });
    patches.push({ ...patch, repository: locator.repository });
  }
  return { patches };
}

async function readRaw(ctx: ApiContext, locator: { repository: string; path: string }): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  if (ctx.built.mode === 'local') {
    const root = process.env.MMD_DEMO_REPO ?? 'demo/checkout-demo';
    const { stdout } = await exec('git', ['-C', root, 'show', `HEAD:${locator.path}`], { maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  }
  const res = await fetch(`https://api.github.com/repos/${locator.repository}/contents/${encodeURI(locator.path)}`, {
    headers: {
      accept: 'application/vnd.github.raw+json',
      'user-agent': 'mental-model-drift',
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status} for ${locator.path}`);
  return res.text();
}

export async function openDocsPullRequest(ctx: ApiContext, id: string) {
  if (process.env.MMD_ALLOW_PR !== '1') {
    throw new Error('opening pull requests is disabled; set MMD_ALLOW_PR=1 to enable it');
  }
  const card = await getDrift(ctx, id);
  if (!card) throw new Error('no such drift');
  const prepared = await prepareDocsPatch(ctx, id);
  const patch = prepared?.patches?.find((p) => p.changed);
  if (!patch) throw new Error('no documentation change to propose');

  const authoritative = card.evidence.find((e) => e.authoritative && e.status === 'OK');
  const writer = new GitHubPullRequestWriter();
  return writer.open({
    target: { repository: (patch as { repository: string }).repository, path: patch.path },
    patch: patch as never,
    branchName: `mmd/${card.drift.subject}-${card.drift.property.replace(/[^a-z0-9]+/gi, '-')}-${card.drift.id.slice(0, 8)}`,
    title: `docs: ${card.label} is ${fmt(card.drift.actualValue)}, not ${fmt(card.drift.assertedValue)}`,
    body: renderPullRequestBody({
      label: card.label,
      oldValue: card.drift.assertedValue,
      newValue: card.drift.actualValue,
      sourceName: authoritative?.source ?? 'source of truth',
      sourceLocator: authoritative?.sourceLocator ?? '',
      ...(card.drift.sourceChangeAt ? { changedAt: card.drift.sourceChangeAt } : {}),
      ...(card.drift.sourceChangeCommit ? { changedCommit: card.drift.sourceChangeCommit } : {}),
      occurrences: card.drift.priorOccurrences.length,
    }),
  });
}

function fmt(v: unknown): string {
  return typeof v === 'boolean' ? (v ? 'enabled' : 'disabled') : String(v);
}

// ---------------------------------------------------------------- coverage

/**
 * How much of the wearer's recorded history this product would speak about.
 *
 * A dry run: every utterance Bee has kept goes through the real extraction and
 * grounding gates, and nothing is written, read or raised. The number that
 * matters is the one on the right of the ratio -- the utterances that produce
 * nothing -- because that is the cost of leaving this thing running.
 *
 * Cached for a minute. It re-reads every conversation, which is cheap against
 * an emulator and rude against a device.
 */
export async function getCoverage(ctx: ApiContext, opts: { force?: boolean } = {}) {
  const fresh = ctx.coverage && Date.now() - ctx.coverage.at < 60_000;
  if (fresh && !opts.force) return ctx.coverage!.report;
  const report = await surveyCoverage(beeCoverageSource(ctx.built.bee), ctx.built.extractor, { limit: 200 });
  ctx.coverage = { at: Date.now(), report };
  return report;
}
