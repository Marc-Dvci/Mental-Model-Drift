/**
 * Dry-run the registry over recorded conversations, from the terminal.
 *
 *   pnpm corpus            summary, and every line that survived the gates
 *   pnpm corpus --all      every utterance, including the silent ones
 *   pnpm corpus --bee      read from a running Bee (or `bee proxy`) instead of
 *                          the demo fixtures
 *
 * The survey itself is `surveyCoverage` in `packages/engine/src/coverage.ts`,
 * the same function behind the dashboard's `/api/coverage`. This file only
 * chooses where the conversations come from, and prints them.
 *
 * It is deliberately NOT called `pnpm audit`: pnpm owns that name for its own
 * dependency audit, so a reader following the README got a vulnerability report
 * instead of this.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BeeClient } from '#bee';
import { Extractor, GrammarProposer } from '#engine/extract/index';
import { beeCoverageSource, surveyCoverage, type CoverageConversation, type CoverageSource } from '#engine/coverage';
import { Registry } from '#engine/registry';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const showAll = process.argv.includes('--all');
const fromBee = process.argv.includes('--bee');

interface FixtureConversation {
  id: number | string;
  short_summary?: string;
  start_time?: string;
  utterances?: { text: string; speaker?: string; created_at?: string }[];
}

const registry = Registry.fromFile(join(ROOT, 'demo', 'source-registry.yaml'));
const extractor = new Extractor(registry, [new GrammarProposer(registry)]);

/** The demo fixtures, read straight off disk so this runs with nothing else up. */
const fixtureSource: CoverageSource = async () => {
  const dir = join(ROOT, 'demo', 'conversations');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'demo-facts.json')
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as FixtureConversation)
    .map((c): CoverageConversation => ({
      id: String(c.id),
      ...(c.short_summary ? { summary: c.short_summary } : {}),
      ...(c.start_time ? { startedAt: c.start_time } : {}),
      utterances: (c.utterances ?? []).map((u) => ({
        text: u.text,
        ...(u.speaker ? { speaker: u.speaker } : {}),
        ...(u.created_at ? { createdAt: u.created_at } : {}),
      })),
    }));
};

const source = fromBee ? beeCoverageSource(BeeClient.fromEnv()) : fixtureSource;
const report = await surveyCoverage(source, extractor, { limit: 200 });

let lastConversation = '';
for (const hit of report.hits) {
  if (hit.conversationId !== lastConversation) {
    lastConversation = hit.conversationId;
    console.log(`\n${hit.at.slice(0, 16).replace('T', ' ')}  #${hit.conversationId}  ${hit.summary ?? ''}`);
  }
  console.log(`   CLAIM  ${hit.text}`);
  console.log(`          -> ${hit.key} = ${String(hit.assertedValue)}  confidence ${hit.confidence.toFixed(2)}  ${hit.disposition}`);
}

if (showAll) {
  console.log('\nEverything else, in order, produced nothing:');
  const spoken = new Set(report.hits.map((h) => h.text));
  for (const convo of await source(200)) {
    for (const u of convo.utterances) if (!spoken.has(u.text)) console.log(`      ·  ${u.text}`);
  }
}

console.log(
  `\n${report.conversations} conversations, ${report.utterances} utterances, ${report.speakers} distinct speakers` +
    ` (${fromBee ? 'read from Bee' : 'demo fixtures'})`,
);
console.log(
  `${report.checkable} produced a checkable claim (${((report.checkable / report.utterances) * 100).toFixed(1)}% of what was heard)`,
);
for (const p of report.perProperty) console.log(`  ${String(p.count).padStart(3)}  ${p.key}`);
