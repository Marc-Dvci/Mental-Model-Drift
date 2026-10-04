/**
 * Shared test fixtures.
 *
 * The tests run against the *demo registry itself* rather than a miniature one
 * written for testing. A registry that passes only against a fixture nobody
 * ships is not evidence about the product; the alias overlaps and scope
 * declarations in the real file are exactly where the interesting failures are.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry } from '#engine/registry';
import { JsonStore } from '#engine/store/json-store';
import type { Claim, RegistryProperty, ValueType } from '#spec';

export const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * tsx's entry point, for tests that need to spawn a real server process.
 * `npx tsx` is a `.cmd` shim on Windows, which since Node 20.19 cannot be
 * spawned without a shell at all (EINVAL), and with one prints DEP0190.
 */
export const TSX = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

export function demoRegistry(): Registry {
  return Registry.fromFile(join(REPO_ROOT, 'demo', 'source-registry.yaml'));
}

export function property(registry: Registry, subject: string, key: string): RegistryProperty {
  const resolved = registry.resolve(subject, key);
  if (!resolved) throw new Error(`fixture registry has no ${subject}.${key}`);
  return resolved.property;
}

/** A claim shaped like the pipeline produces, for adapter and comparator tests. */
export function claim(partial: Partial<Claim> & { subject: string; property: string; assertedValue: unknown; valueType: ValueType }): Claim {
  return {
    id: 'claim-test',
    userId: 'test',
    sourceConversationId: '1',
    originalText: 'test utterance',
    claimType: 'CONFIG_VALUE',
    ownership: 'LIKELY_USER',
    extractionConfidence: 0.9,
    capturedAt: '2026-09-01T09:00:00.000Z',
    status: 'CANDIDATE',
    ...partial,
  };
}

export interface TempStore {
  store: JsonStore;
  path: string;
  cleanup: () => void;
}

export function tempStore(): TempStore {
  const dir = mkdtempSync(join(tmpdir(), 'mmd-test-'));
  const path = join(dir, 'store.json');
  return {
    store: new JsonStore(path),
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
