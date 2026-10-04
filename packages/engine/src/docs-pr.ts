/**
 * Documentation correction.
 *
 * The most useful thing to do about a stale belief is usually not to correct the
 * person. It is to correct whatever taught them. A README that still says three
 * retries will keep producing this drift in whoever reads it next, including the
 * next new hire and the next coding agent.
 *
 * Two deliberate constraints:
 *
 *  - The edit is proposed, never applied silently. `preparePatch` is pure and
 *    returns hunks a human can read; `openPullRequest` is a separate call.
 *  - The PR body carries provenance and no transcript. It says a stale value was
 *    referenced and what the source of truth says. It does not quote what anyone
 *    said, or when, or to whom.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launch } from '#bee';

const exec = promisify(execFile);

export interface DocTarget {
  repository: string;
  path: string;
  branch?: string;
}

export interface PatchHunk {
  line: number;
  before: string;
  after: string;
}

export interface PreparedPatch {
  path: string;
  hunks: PatchHunk[];
  content: string;
  changed: boolean;
}

const NUMBER_WORDS: Record<number, string[]> = {
  0: ['zero', 'no'], 1: ['one', 'once'], 2: ['two', 'twice'], 3: ['three', 'thrice'],
  4: ['four'], 5: ['five'], 6: ['six'], 7: ['seven'], 8: ['eight'], 9: ['nine'], 10: ['ten'],
};

/**
 * Rewrite the stale value where the document actually states it.
 *
 * Only lines that mention the property are touched. Without that constraint,
 * correcting "3" to "1" in a README would happily rewrite a version number, a
 * port, or a bullet in an unrelated list -- which is how an automated docs fix
 * loses the right to be trusted.
 */
export function preparePatch(input: {
  path: string;
  content: string;
  oldValue: unknown;
  newValue: unknown;
  lexemes: string[];
}): PreparedPatch {
  const lines = input.content.split('\n');
  const hunks: PatchHunk[] = [];
  const lexemes = input.lexemes.map((l) => l.toLowerCase());

  const forms = valueForms(input.oldValue);
  const replacement = renderValue(input.newValue, input.oldValue);

  const out = lines.map((line, i) => {
    const lower = line.toLowerCase();
    if (!lexemes.some((l) => lower.includes(l))) return line;
    let next = line;
    for (const form of forms) {
      const re = new RegExp(`(?<![\\w.])${escape(form)}(?![\\w.])`, 'gi');
      if (!re.test(next)) continue;
      next = next.replace(new RegExp(re.source, 'gi'), replacement);
    }
    // English agreement is not worth a grammar library, but "retry 1 times" in a
    // generated PR reads as carelessness and undermines the whole correction.
    if (next !== line && typeof input.newValue === 'number') {
      next = fixAgreement(next, input.newValue);
    }
    if (next !== line) hunks.push({ line: i + 1, before: line, after: next });
    return next;
  });

  return { path: input.path, hunks, content: out.join('\n'), changed: hunks.length > 0 };
}

function valueForms(value: unknown): string[] {
  if (typeof value === 'number' && NUMBER_WORDS[value]) return [String(value), ...NUMBER_WORDS[value]!];
  if (typeof value === 'boolean') return value ? ['true', 'enabled'] : ['false', 'disabled'];
  return [String(value)];
}

/** Match the register of what was written: a spelled-out word stays a word. */
function renderValue(newValue: unknown, oldValue: unknown): string {
  if (typeof newValue === 'number' && typeof oldValue === 'number') {
    return NUMBER_WORDS[newValue]?.[0] ?? String(newValue);
  }
  if (typeof newValue === 'boolean') return newValue ? 'enabled' : 'disabled';
  return String(newValue);
}

function fixAgreement(line: string, n: number): string {
  if (n === 1) return line.replace(/\bonce\s+times\b/gi, 'once').replace(/\b(one|1)\s+times\b/gi, '$1 time');
  return line.replace(/\b(\d+|two|three|four|five)\s+time\b/gi, '$1 times');
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --------------------------------------------------------------------- GitHub

export interface PullRequestInput {
  target: DocTarget;
  patch: PreparedPatch;
  title: string;
  body: string;
  branchName: string;
  token?: string;
}

export interface PullRequestResult {
  url: string;
  number: number;
  branch: string;
}

export class GitHubPullRequestWriter {
  constructor(private readonly opts: { token?: string; apiBase?: string } = {}) {}

  private async token(): Promise<string> {
    if (this.opts.token) return this.opts.token;
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
    try {
      const gh = launch('gh');
      const { stdout } = await exec(gh.command, ['auth', 'token'], { shell: gh.shell });
      if (stdout.trim()) return stdout.trim();
    } catch {
      /* fall through to the explicit error below */
    }
    throw new Error('no GitHub credential: set GITHUB_TOKEN or run `gh auth login`');
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const base = this.opts.apiBase ?? 'https://api.github.com';
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'mental-model-drift',
        authorization: `Bearer ${await this.token()}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`GitHub ${method} ${path} returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  async open(input: PullRequestInput): Promise<PullRequestResult> {
    const { repository, path } = input.target;
    const repo = await this.api<{ default_branch: string }>('GET', `/repos/${repository}`);
    const base = input.target.branch ?? repo.default_branch;

    const baseRef = await this.api<{ object: { sha: string } }>('GET', `/repos/${repository}/git/ref/heads/${base}`);
    await this.api('POST', `/repos/${repository}/git/refs`, {
      ref: `refs/heads/${input.branchName}`,
      sha: baseRef.object.sha,
    });

    const existing = await this.api<{ sha: string }>('GET', `/repos/${repository}/contents/${encodeURI(path)}?ref=${encodeURIComponent(base)}`);
    await this.api('PUT', `/repos/${repository}/contents/${encodeURI(path)}`, {
      message: input.title,
      content: Buffer.from(input.patch.content, 'utf8').toString('base64'),
      sha: existing.sha,
      branch: input.branchName,
    });

    const pr = await this.api<{ html_url: string; number: number }>('POST', `/repos/${repository}/pulls`, {
      title: input.title,
      head: input.branchName,
      base,
      body: input.body,
    });
    return { url: pr.html_url, number: pr.number, branch: input.branchName };
  }
}

/**
 * The PR body.
 *
 * Written to be readable by someone who has never heard of this tool and who
 * will, correctly, be suspicious of an automated documentation change. It states
 * what the source of truth says, where that was read, and when the value moved.
 * It never quotes a conversation.
 */
export function renderPullRequestBody(input: {
  label: string;
  oldValue: unknown;
  newValue: unknown;
  sourceName: string;
  sourceLocator: string;
  changedAt?: string;
  changedCommit?: string;
  occurrences: number;
}): string {
  const lines: string[] = [
    '## Why',
    '',
    `The documentation states that ${input.label} is ${fmt(input.oldValue)}. The configured source of truth reports ${fmt(input.newValue)}.`,
    '',
    '## Source of truth',
    '',
    `- **${input.sourceName}** — \`${input.sourceLocator}\``,
    `- Current value: \`${fmt(input.newValue)}\``,
  ];
  if (input.changedAt) {
    lines.push(
      `- Changed: ${input.changedAt.slice(0, 10)}${input.changedCommit ? ` (\`${input.changedCommit.slice(0, 7)}\`)` : ''}`,
    );
  }
  lines.push(
    '',
    '## How this was found',
    '',
    'Mental Model Drift verifies statements engineers make about this system against the source above.',
    input.occurrences > 0
      ? `The previous value was referenced in ${input.occurrences} earlier engineering ${input.occurrences === 1 ? 'conversation' : 'conversations'}, which suggests the stale documentation is still propagating.`
      : 'The previous value was referenced in a recent engineering conversation.',
    '',
    'No transcript content is included in this pull request. Only the corrected value and its source are reproduced here.',
  );
  return lines.join('\n');
}

function fmt(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'enabled' : 'disabled';
  return String(v);
}
