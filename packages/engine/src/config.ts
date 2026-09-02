/**
 * Assembly. One place where environment becomes wiring, so that every entry
 * point -- server, relay, MCP server, evaluation harness, tests -- gets an
 * identically configured engine and no component reads process.env itself.
 *
 * The mode switch is the important part. `local` runs every source from the
 * on-disk mirrors in demo/ and needs no cloud account; `live` runs the same code
 * against AWS AppConfig, github.com and Sentry. Nothing in the engine, the
 * comparator or the UI knows which one is in effect -- only the evidence
 * locator says so, which is exactly where a reader should be able to check.
 */
import { join, resolve } from 'node:path';
import { BeeClient } from '#bee';
import type { Verifier } from '#spec';
import { AppConfigVerifier } from './adapters/appconfig.ts';
import { GitHubVerifier } from './adapters/github.ts';
import { SentryVerifier } from './adapters/sentry.ts';
import { BedrockProposer, Extractor, GrammarProposer, type Proposer } from './extract/index.ts';
import { DriftEngine } from './pipeline.ts';
import { RecurrenceFinder } from './recurrence.ts';
import { Registry } from './registry.ts';
import { JsonStore } from './store/json-store.ts';
import { DynamoStore } from './store/dynamo-store.ts';
import type { Store } from './store/types.ts';

export type Mode = 'local' | 'live';

export interface BuiltEngine {
  engine: DriftEngine;
  registry: Registry;
  /** Exposed so a coverage survey can dry-run the same gates the pipeline uses. */
  extractor: Extractor;
  store: Store;
  bee: BeeClient;
  verifiers: Verifier[];
  github: GitHubVerifier;
  mode: Mode;
  proposers: string[];
  describe(): Record<string, string>;
}

export interface BuildOptions {
  root?: string;
  mode?: Mode;
  registryPath?: string;
  statePath?: string;
  userId?: string;
  onEvent?: ConstructorParameters<typeof DriftEngine>[0]['onEvent'];
  /** Force a proposer set instead of deriving it from the environment. */
  proposers?: ('grammar' | 'bedrock')[];
  /**
   * An already-constructed Bee client, instead of one built from the
   * environment. Tests and the golden scenarios point this at the local
   * emulator; nothing else in the engine can tell the difference, which is the
   * property that makes those scenarios worth running.
   */
  bee?: BeeClient;
}

export function buildEngine(opts: BuildOptions = {}): BuiltEngine {
  const root = opts.root ?? process.cwd();
  const mode: Mode = opts.mode ?? (process.env.MMD_MODE === 'live' ? 'live' : 'local');
  const registryPath = opts.registryPath ?? process.env.MMD_REGISTRY ?? join(root, 'demo', 'source-registry.yaml');
  const registry = Registry.fromFile(resolve(registryPath));

  const store: Store = process.env.MMD_DYNAMO_TABLE
    ? new DynamoStore({ tableName: process.env.MMD_DYNAMO_TABLE, userId: opts.userId ?? process.env.MMD_USER_ID ?? 'local' })
    : new JsonStore(resolve(opts.statePath ?? process.env.MMD_STATE ?? join(root, '.state', 'store.json')));

  const bee = opts.bee ?? BeeClient.fromEnv();

  const github = new GitHubVerifier(
    mode === 'live'
      ? { mode: 'api', ...(process.env.MMD_GITHUB_REF ? {} : {}) }
      : { mode: 'localgit', repoRoot: process.env.MMD_DEMO_REPO ?? join(root, 'demo', 'checkout-demo') },
  );

  const verifiers: Verifier[] = [
    new AppConfigVerifier({ mode, fixtureRoot: join(root, 'demo', 'appconfig') }),
    github,
    new SentryVerifier({ mode, fixtureRoot: join(root, 'demo', 'sentry') }),
  ];

  const wanted = opts.proposers ?? deriveProposers();
  const proposers: Proposer[] = [];
  if (wanted.includes('grammar')) proposers.push(new GrammarProposer(registry));
  if (wanted.includes('bedrock')) proposers.push(new BedrockProposer(registry));

  const extractor = new Extractor(registry, proposers);
  const recurrence = new RecurrenceFinder(bee, registry);

  const engine = new DriftEngine({
    userId: opts.userId ?? process.env.MMD_USER_ID ?? 'local',
    registry,
    extractor,
    verifiers,
    store,
    bee,
    recurrence,
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });

  return {
    engine,
    registry,
    extractor,
    store,
    bee,
    verifiers,
    github,
    mode,
    proposers: proposers.map((p) => p.name),
    describe: () => ({
      mode,
      registry: resolve(registryPath),
      store: process.env.MMD_DYNAMO_TABLE ? `dynamodb:${process.env.MMD_DYNAMO_TABLE}` : 'json',
      bee: bee.describeTransport(),
      proposers: proposers.map((p) => p.name).join(' + ') || 'none',
      github: mode === 'live' ? 'api.github.com' : 'local clone',
    }),
  };
}

/**
 * Bedrock is used when it is configured, and the grammar proposer always runs.
 *
 * The grammar proposer is never dropped, even when Bedrock is available: it is
 * the corroborating second opinion the confidence blend depends on, and the
 * reason extraction still works when a region is degraded.
 */
function deriveProposers(): ('grammar' | 'bedrock')[] {
  const explicit = process.env.MMD_PROPOSERS;
  if (explicit) return explicit.split(',').map((s) => s.trim()) as ('grammar' | 'bedrock')[];
  const bedrockAvailable =
    Boolean(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) &&
    process.env.MMD_DISABLE_BEDROCK !== '1';
  return bedrockAvailable ? ['grammar', 'bedrock'] : ['grammar'];
}
