/**
 * Build the demo service repository, with real history.
 *
 * The archaeology adapter is only worth demonstrating against a repository whose
 * commits actually happened in the order and on the dates the story claims. So
 * this writes a small but real service and commits it five times with backdated
 * author and committer dates, and everything the drift cards say about "changed
 * on August 23, commit 8d21f4" is then read back out of git rather than staged.
 *
 *   pnpm demo:seed            build demo/checkout-demo
 *   pnpm demo:seed --force    delete and rebuild it
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ROOT = resolve(args[0] ?? join(process.cwd(), 'demo', 'checkout-demo'));
const FORCE = process.argv.includes('--force');

interface Commit {
  date: string;
  message: string;
  author: string;
  files: Record<string, string>;
}

const AUTHOR_A = 'Priya Raman <priya@example.invalid>';
const AUTHOR_B = 'Tomas Lindqvist <tomas@example.invalid>';

const commits: Commit[] = [
  {
    date: '2026-07-14T10:12:00+02:00',
    author: AUTHOR_A,
    message: 'Initial checkout worker',
    files: {
      'README.md': `# checkout-demo

A deliberately small stand-in for a checkout service, used to demonstrate
Mental Model Drift against a repository with real history.

- \`config/checkout.yaml\` — worker configuration
- \`config/feature-flags.yaml\` — rollout state
- \`database/schema.sql\` — event schema
- \`docs/architecture.md\` — the documentation that goes stale
`,
      'config/checkout.yaml': `# Checkout worker configuration.
# Deployed to production through AWS AppConfig; this file is the source history.

retry:
  max_attempts: 3
  backoff_seconds: 5

dlq:
  enabled: true
  queue: checkout-dlq

concurrency: 8
`,
      'config/feature-flags.yaml': `new_checkout:
  regions:
    EU: false
    US: false
    APAC: false
`,
      'database/schema.sql': `CREATE TABLE orders (
  id            BIGSERIAL PRIMARY KEY,
  customer_id   BIGINT NOT NULL,
  total_cents   INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id            BIGSERIAL PRIMARY KEY,
  order_id      BIGINT NOT NULL REFERENCES orders(id),
  kind          TEXT NOT NULL,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX events_order_id_idx ON events (order_id);
`,
      'docs/architecture.md': `# Checkout architecture

The checkout worker consumes payment jobs from the queue.

## Retries

Checkout jobs retry three times before landing in the dead-letter queue.
Each attempt backs off five seconds.

## Events

Every state transition is written to the \`events\` table.
`,
      'src/worker.ts': `import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const config = parse(readFileSync('config/checkout.yaml', 'utf8'));

export async function handle(job: { id: string }, run: () => Promise<void>): Promise<void> {
  for (let attempt = 1; attempt <= config.retry.max_attempts; attempt++) {
    try {
      await run();
      return;
    } catch (err) {
      if (attempt === config.retry.max_attempts) throw err;
      await new Promise((r) => setTimeout(r, config.retry.backoff_seconds * 1000));
    }
  }
}
`,
    },
  },
  {
    date: '2026-08-02T16:41:00+02:00',
    author: AUTHOR_B,
    message: 'Record the source IP on every event for fraud review',
    files: {
      'database/schema.sql': `CREATE TABLE orders (
  id            BIGSERIAL PRIMARY KEY,
  customer_id   BIGINT NOT NULL,
  total_cents   INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id            BIGSERIAL PRIMARY KEY,
  order_id      BIGINT NOT NULL REFERENCES orders(id),
  kind          TEXT NOT NULL,
  payload       JSONB NOT NULL,
  source_ip     INET NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX events_order_id_idx ON events (order_id);
`,
    },
  },
  {
    date: '2026-08-23T11:07:00+02:00',
    author: AUTHOR_A,
    // The commit the whole demo turns on. Note that it is a good change,
    // competently justified -- drift is not caused by carelessness.
    message: 'Reduce checkout retries to 1 after duplicate-charge incident',
    files: {
      'config/checkout.yaml': `# Checkout worker configuration.
# Deployed to production through AWS AppConfig; this file is the source history.

retry:
  max_attempts: 1
  backoff_seconds: 5

dlq:
  enabled: true
  queue: checkout-dlq

concurrency: 8
`,
    },
  },
  {
    date: '2026-08-27T09:23:00+02:00',
    author: AUTHOR_B,
    message: 'Enable new checkout in EU',
    files: {
      'config/feature-flags.yaml': `new_checkout:
  regions:
    EU: true
    US: false
    APAC: false
`,
    },
  },
  {
    date: '2026-08-29T15:02:00+02:00',
    author: AUTHOR_A,
    message: 'Release 4.13',
    files: {
      'package.json': `{
  "name": "checkout-service",
  "version": "4.13.0",
  "private": true
}
`,
    },
  },
];

function git(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', ['-C', ROOT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function main(): void {
  if (existsSync(ROOT)) {
    if (!FORCE) {
      console.error(`${ROOT} already exists. Re-run with --force to rebuild it.`);
      process.exit(1);
    }
    rmSync(ROOT, { recursive: true, force: true });
  }
  mkdirSync(ROOT, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', ROOT], { encoding: 'utf8' });
  git(['config', 'user.name', 'demo']);
  git(['config', 'user.email', 'demo@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);

  for (const commit of commits) {
    for (const [path, content] of Object.entries(commit.files)) {
      const full = join(ROOT, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    git(['add', '-A']);
    // Author and committer dates are both set: a tool that reads only one of
    // them would otherwise show today's date for every commit in this history.
    const [name, email] = splitAuthor(commit.author);
    git(['commit', '-q', '-m', commit.message], {
      GIT_AUTHOR_DATE: commit.date,
      GIT_COMMITTER_DATE: commit.date,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    });
  }

  console.log(`Seeded ${ROOT}`);
  console.log(git(['log', '--format=%h  %ad  %an  %s', '--date=short']).trimEnd());
}

function splitAuthor(author: string): [string, string] {
  const m = /^(.*?)\s*<(.+)>$/.exec(author);
  return m ? [m[1]!, m[2]!] : [author, 'demo@example.invalid'];
}

main();
