/**
 * The extraction evaluation harness.
 *
 * Any product built on a wearable microphone can claim it "understands what you
 * say about your systems". The question a reviewer should ask is how often it
 * is wrong, and about what -- so this measures it, on a labelled corpus, and
 * prints numbers that can be regenerated in twenty seconds.
 *
 * What is optimised for is precision, not recall, and the asymmetry is the
 * product's central bet:
 *
 *   a false negative is a missed opportunity -- nobody notices;
 *   a false positive tells a person their understanding of production is stale
 *   about something they never said, and costs more trust than ten catches
 *   earn back.
 *
 *   pnpm eval                     grammar proposer only (no model, no network)
 *   pnpm eval --proposers grammar,bedrock
 *   pnpm eval --verdicts          also verify each claim against the sources
 *   pnpm eval --json report.json  machine-readable output for CI
 *   pnpm eval --errors            print every disagreement, with the reason
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Extractor, GrammarProposer, BedrockProposer, type Proposer, type Accepted } from '#engine/extract/index';
import { Registry } from '#engine/registry';
import { adjudicateAll, type Verdict } from '#spec';
import { AppConfigVerifier } from '#engine/adapters/appconfig';
import { GitHubVerifier } from '#engine/adapters/github';
import { SentryVerifier } from '#engine/adapters/sentry';
import { randomUUID } from 'node:crypto';
import type { Claim, Verifier } from '#spec';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

type Category = 'SUPPORTED_CLAIM' | 'DRIFTED_CLAIM' | 'UNVERIFIABLE' | 'NON_CLAIM';

interface GoldRow {
  id: string;
  category: Category;
  text: string;
  window?: string[];
  expect: { subject: string; property: string; value: unknown; object?: string; scope?: Record<string, string> } | null;
  verdict?: Verdict;
  note?: string;
}

interface Outcome {
  row: GoldRow;
  accepted: Accepted[];
  /** Exactly one accepted candidate, and it matches the gold triple. */
  correct: boolean;
  /** A candidate was produced where the gold says there is no claim. */
  falsePositive: boolean;
  /** The gold says there is a claim and nothing was produced. */
  missed: boolean;
  subjectPropertyCorrect?: boolean;
  valueCorrect?: boolean;
  verdict?: Verdict;
  verdictCorrect?: boolean;
  detail: string;
}

function parseArgs(argv: string[]) {
  const args = { proposers: ['grammar'] as ('grammar' | 'bedrock')[], verdicts: false, errors: false, json: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--proposers') args.proposers = (argv[++i] ?? 'grammar').split(',') as ('grammar' | 'bedrock')[];
    else if (a === '--verdicts') args.verdicts = true;
    else if (a === '--errors') args.errors = true;
    else if (a === '--json') args.json = argv[++i] ?? 'eval-report.json';
  }
  return args;
}

function loadCorpus(): GoldRow[] {
  const path = join(ROOT, 'tools', 'eval', 'corpus', 'golden.jsonl');
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as GoldRow);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  // A spoken "4.12" and a gold "4.12.0" are the same release.
  const pad = (s: string) => {
    const parts = s.replace(/^v/, '').split('.').map(Number);
    while (parts.length < 3) parts.push(0);
    return parts.join('.');
  };
  const sa = String(a);
  const sb = String(b);
  if (/^v?\d+(\.\d+)*$/.test(sa) && /^v?\d+(\.\d+)*$/.test(sb)) return pad(sa) === pad(sb);
  return sa.toLowerCase() === sb.toLowerCase();
}

function sameScope(a?: Record<string, string>, b?: Record<string, string>): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const registry = Registry.fromFile(join(ROOT, 'demo', 'source-registry.yaml'));
  const corpus = loadCorpus();

  const proposers: Proposer[] = [];
  if (args.proposers.includes('grammar')) proposers.push(new GrammarProposer(registry));
  if (args.proposers.includes('bedrock')) proposers.push(new BedrockProposer(registry));
  const extractor = new Extractor(registry, proposers);

  const verifiers: Verifier[] = args.verdicts
    ? [
        new AppConfigVerifier({ mode: 'local', fixtureRoot: join(ROOT, 'demo', 'appconfig') }),
        new GitHubVerifier({ mode: 'localgit', repoRoot: join(ROOT, 'demo', 'checkout-demo') }),
        new SentryVerifier({ mode: 'local', fixtureRoot: join(ROOT, 'demo', 'sentry') }),
      ]
    : [];

  const outcomes: Outcome[] = [];
  const t0 = Date.now();

  for (const row of corpus) {
    const result = await extractor.extract({
      text: row.text,
      ...(row.window ? { window: row.window } : {}),
      conversationId: `eval-${row.id}`,
      capturedAt: '2026-09-01T09:00:00.000Z',
    });
    const accepted = result.accepted;
    const gold = row.expect;

    const outcome: Outcome = {
      row,
      accepted,
      correct: false,
      falsePositive: false,
      missed: false,
      detail: '',
    };

    if (!gold) {
      outcome.falsePositive = accepted.length > 0;
      outcome.detail = accepted.length
        ? `expected silence, got ${accepted.map((a) => `${a.proposal.subject}.${a.proposal.property}=${String(a.proposal.assertedValue)}`).join(', ')}`
        : 'silent, as expected';
    } else if (accepted.length === 0) {
      outcome.missed = true;
      outcome.detail = `expected ${gold.subject}.${gold.property}=${String(gold.value)}, got nothing (${result.rejected.map((r) => `${r.stage}: ${r.reason}`).join(' | ') || 'no proposal'})`;
    } else {
      const match = accepted.find(
        (a) =>
          a.proposal.subject === gold.subject &&
          a.proposal.property === gold.property &&
          sameValue(a.proposal.assertedValue, gold.value) &&
          (gold.object === undefined || a.proposal.object === gold.object) &&
          sameScope(a.proposal.scope, gold.scope),
      );
      outcome.subjectPropertyCorrect = accepted.some((a) => a.proposal.subject === gold.subject && a.proposal.property === gold.property);
      outcome.valueCorrect = Boolean(match);
      outcome.correct = Boolean(match) && accepted.length === 1;
      outcome.falsePositive = accepted.some(
        (a) => !(a.proposal.subject === gold.subject && a.proposal.property === gold.property && sameValue(a.proposal.assertedValue, gold.value)),
      );
      outcome.detail = outcome.correct
        ? 'exact'
        : `expected ${gold.subject}.${gold.property}=${String(gold.value)}, got ${accepted
            .map((a) => `${a.proposal.subject}.${a.proposal.property}=${String(a.proposal.assertedValue)}`)
            .join(', ')}`;

      if (args.verdicts && match) {
        const resolved = registry.resolve(gold.subject, gold.property)!;
        const claim: Claim = {
          id: randomUUID(),
          userId: 'eval',
          sourceConversationId: `eval-${row.id}`,
          originalText: row.text,
          claimType: resolved.property.claimType,
          subject: gold.subject,
          property: gold.property,
          ...(match.proposal.object ? { object: match.proposal.object } : {}),
          ...(match.proposal.scope ? { scope: match.proposal.scope } : {}),
          assertedValue: match.proposal.assertedValue,
          valueType: resolved.property.type,
          ownership: 'LIKELY_USER',
          extractionConfidence: match.confidence,
          capturedAt: '2026-09-01T09:00:00.000Z',
          status: 'CANDIDATE',
        };
        const source = resolved.property.authoritative_source;
        const verifier = verifiers.find((v) => v.canVerify(claim, source));
        const evidence = verifier ? [await verifier.verify(claim, source)] : [];
        outcome.verdict = adjudicateAll(claim, evidence).verdict;
        outcome.verdictCorrect = outcome.verdict === row.verdict;
      }
    }
    outcomes.push(outcome);
  }

  const ms = Date.now() - t0;
  const report = summarise(outcomes, args.proposers, ms, args.verdicts);
  print(report, outcomes, args.errors);
  if (args.json) {
    writeFileSync(resolve(args.json), JSON.stringify({ ...report, outcomes: outcomes.map(compact) }, null, 2));
    console.log(`\nwrote ${resolve(args.json)}`);
  }
  // A regression in precision should fail a pipeline, not just print in red.
  if (report.candidatePrecision < 0.95 || report.subjectPropertyAccuracy < 0.95) process.exitCode = 1;
}

function compact(o: Outcome) {
  return {
    id: o.row.id,
    category: o.row.category,
    text: o.row.text,
    correct: o.correct,
    falsePositive: o.falsePositive,
    missed: o.missed,
    ...(o.verdict ? { verdict: o.verdict, verdictCorrect: o.verdictCorrect } : {}),
    detail: o.detail,
  };
}

interface Report {
  proposers: string[];
  utterances: number;
  claims: number;
  nonClaims: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  candidatePrecision: number;
  recall: number;
  falsePositiveRate: number;
  subjectPropertyAccuracy: number;
  valueAccuracy: number;
  verdictAccuracy?: number;
  msPerUtterance: number;
  byCategory: Record<string, { n: number; correct: number; falsePositives: number; missed: number }>;
}

function summarise(outcomes: Outcome[], proposers: string[], ms: number, verdicts: boolean): Report {
  const claimRows = outcomes.filter((o) => o.row.expect);
  const nonClaimRows = outcomes.filter((o) => !o.row.expect);

  const truePositives = claimRows.filter((o) => o.correct).length;
  // Every candidate that is not the gold claim is a false positive, whether it
  // appeared on a claim row or on a row that should have produced silence.
  const falsePositives =
    nonClaimRows.reduce((n, o) => n + o.accepted.length, 0) +
    claimRows.reduce((n, o) => n + o.accepted.filter((a) => !isGold(o, a)).length, 0);
  const falseNegatives = claimRows.filter((o) => !o.correct).length;

  const withCandidate = claimRows.filter((o) => o.accepted.length > 0);
  const verdictRows = claimRows.filter((o) => o.verdict !== undefined);

  const byCategory: Report['byCategory'] = {};
  for (const o of outcomes) {
    const c = (byCategory[o.row.category] ??= { n: 0, correct: 0, falsePositives: 0, missed: 0 });
    c.n++;
    if (o.correct) c.correct++;
    if (o.falsePositive) c.falsePositives++;
    if (o.missed) c.missed++;
  }

  return {
    proposers,
    utterances: outcomes.length,
    claims: claimRows.length,
    nonClaims: nonClaimRows.length,
    truePositives,
    falsePositives,
    falseNegatives,
    candidatePrecision: truePositives / Math.max(1, truePositives + falsePositives),
    recall: truePositives / Math.max(1, claimRows.length),
    falsePositiveRate: nonClaimRows.filter((o) => o.accepted.length > 0).length / Math.max(1, nonClaimRows.length),
    subjectPropertyAccuracy: withCandidate.filter((o) => o.subjectPropertyCorrect).length / Math.max(1, withCandidate.length),
    valueAccuracy: withCandidate.filter((o) => o.valueCorrect).length / Math.max(1, withCandidate.length),
    ...(verdicts ? { verdictAccuracy: verdictRows.filter((o) => o.verdictCorrect).length / Math.max(1, verdictRows.length) } : {}),
    msPerUtterance: ms / outcomes.length,
    byCategory,
  };
}

function isGold(o: Outcome, a: Accepted): boolean {
  const gold = o.row.expect!;
  return a.proposal.subject === gold.subject && a.proposal.property === gold.property && sameValue(a.proposal.assertedValue, gold.value);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function print(r: Report, outcomes: Outcome[], showErrors: boolean): void {
  console.log(`\nMental Model Drift -- extraction evaluation`);
  console.log(`proposers: ${r.proposers.join(' + ')}    corpus: ${r.utterances} utterances (${r.claims} claims, ${r.nonClaims} non-claims)\n`);

  const line = (label: string, value: string, target?: string) =>
    console.log(`  ${label.padEnd(28)} ${value.padStart(8)}${target ? `    target ${target}` : ''}`);

  line('candidate precision', pct(r.candidatePrecision), '> 95%');
  line('recall', pct(r.recall));
  line('false-positive rate', pct(r.falsePositiveRate));
  line('subject/property accuracy', pct(r.subjectPropertyAccuracy), '> 95%');
  line('value accuracy', pct(r.valueAccuracy), '> 98%');
  if (r.verdictAccuracy !== undefined) line('verdict accuracy', pct(r.verdictAccuracy));
  line('latency', `${r.msPerUtterance.toFixed(1)}ms`);

  console.log('');
  for (const [category, c] of Object.entries(r.byCategory)) {
    console.log(`  ${category.padEnd(18)} ${String(c.correct).padStart(3)}/${String(c.n).padEnd(4)} correct   ${c.falsePositives} false positive${c.falsePositives === 1 ? '' : 's'}   ${c.missed} missed`);
  }

  const errors = outcomes.filter((o) => (o.row.expect ? !o.correct : o.falsePositive));
  if (errors.length && showErrors) {
    console.log(`\ndisagreements (${errors.length}):`);
    for (const e of errors) console.log(`  [${e.row.id}] ${e.row.text}\n        ${e.detail}`);
  } else if (errors.length) {
    console.log(`\n${errors.length} disagreement${errors.length === 1 ? '' : 's'}; re-run with --errors to see them`);
  }
}

await run();
