/**
 * Runs once before the suite. The scenarios, the CLI and the firewall all
 * read `demo/checkout-demo`, a git repository with backdated commits that
 * `tools/demo/seed-repo.ts` builds and that is deliberately not committed
 * (a repository inside a repository). A fresh clone has no such directory, so
 * `pnpm verify` would fail eleven tests before `pnpm demo` had ever been run.
 * Seed it here if it is missing, the same way `pnpm demo` does.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

export default function setup(): void {
  if (existsSync(join(ROOT, 'demo', 'checkout-demo', '.git'))) return;
  const result = spawnSync(process.execPath, [TSX, join(ROOT, 'tools', 'demo', 'seed-repo.ts')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`seeding demo/checkout-demo failed with exit code ${String(result.status)}`);
  }
}
