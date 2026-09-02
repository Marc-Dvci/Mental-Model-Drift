/**
 * GitHub -- the archaeology adapter.
 *
 * Its authoritative job is narrow (schema facts, where the checked-in DDL *is*
 * the truth). Its important job is historical: reconstructing the moment a value
 * stopped being what the engineer remembers.
 *
 * That reconstruction is what turns "you are wrong" into "this changed on
 * August 23, after you learned it", and those are not the same product.
 *
 * The walk is deliberately backwards and lazy. Commits touching the file are
 * listed newest first, and each one is only fetched until the value differs
 * from the current one -- so the common case (the value changed once, recently)
 * costs two or three blob reads rather than the whole history of the file.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { launch } from '#bee';
import type { Claim, Evidence, HistoricalChange, SourceRef, Verifier } from '#spec';
import { bindLocator, makeEvidence, readPath } from './common.ts';

const exec = promisify(execFile);

export interface GitHubLocator {
  repository: string;
  path: string;
  ref?: string;
  /** For structured config files. */
  json_path?: string;
  /** For .sql schema files: assert that `column` exists on `table`. */
  table?: string;
  column?: string;
}

export interface GitHubAdapterOptions {
  /** `api` reads github.com; `localgit` reads a clone on disk. */
  mode: 'api' | 'localgit';
  token?: string;
  /** Path to the clone, in localgit mode. */
  repoRoot?: string;
  /** How many commits back to walk when reconstructing history. */
  maxHistoryCommits?: number;
  apiBase?: string;
}

export class GitHubVerifier implements Verifier {
  readonly name = 'github';
  private tokenPromise?: Promise<string | undefined>;

  constructor(private readonly opts: GitHubAdapterOptions) {}

  canVerify(_claim: Claim, source: SourceRef): boolean {
    return source.adapter === this.name;
  }

  async verify(claim: Claim, source: SourceRef): Promise<Evidence> {
    // A schema entry addresses a table; which column is being asserted about is
    // a property of the claim, not of the registry, so one entry covers the
    // whole table rather than needing a line per column.
    const base = bindLocator(source.locator, {
      ...(claim.scope ? { scope: claim.scope } : {}),
      ...(claim.object ? { object: claim.object } : {}),
    }) as unknown as GitHubLocator;
    const l: GitHubLocator = base.table && !base.column && claim.object ? { ...base, column: claim.object } : base;
    const ref = l.ref ?? 'HEAD';
    const locator = `github://${l.repository}/${l.path}@${ref}${l.json_path ?? (l.column ? `#${l.table}.${l.column}` : '')} (${this.opts.mode})`;
    try {
      const { content, sha } = await this.readFile(l, ref);
      const extracted = extractValue(l, content);
      if (!extracted.found) {
        return makeEvidence({
          claimId: claim.id,
          source: 'GITHUB',
          sourceLocator: locator,
          status: 'NOT_FOUND',
          value: undefined,
          authoritative: source.authoritative,
          commitSha: sha,
          error: extracted.reason,
        });
      }
      return makeEvidence({
        claimId: claim.id,
        source: 'GITHUB',
        sourceLocator: locator,
        status: 'OK',
        value: extracted.value,
        authoritative: source.authoritative,
        commitSha: sha,
      });
    } catch (err) {
      return makeEvidence({
        claimId: claim.id,
        source: 'GITHUB',
        sourceLocator: locator,
        status: (err as Error).message.includes('403') ? 'FORBIDDEN' : 'UNAVAILABLE',
        value: undefined,
        authoritative: source.authoritative,
        error: (err as Error).message,
      });
    }
  }

  async history(claim: Claim, source: SourceRef): Promise<HistoricalChange[]> {
    const l = bindLocator(source.locator, {
      ...(claim?.scope ? { scope: claim.scope } : {}),
      ...(claim?.object ? { object: claim.object } : {}),
    }) as unknown as GitHubLocator;
    const max = this.opts.maxHistoryCommits ?? 40;
    const commits = await this.listCommits(l, max);
    const changes: HistoricalChange[] = [];

    let laterValue: unknown;
    let laterCommit: CommitRef | undefined;
    for (const commit of commits) {
      let value: unknown;
      try {
        const { content } = await this.readFile(l, commit.sha);
        const extracted = extractValue(l, content);
        value = extracted.found ? extracted.value : undefined;
      } catch {
        continue;
      }
      if (laterCommit === undefined) {
        laterValue = value;
        laterCommit = commit;
        continue;
      }
      if (JSON.stringify(value) !== JSON.stringify(laterValue)) {
        // `laterCommit` is the commit that introduced `laterValue`; this one is
        // the last commit that still had the old value.
        changes.push({
          at: laterCommit.date,
          from: value,
          to: laterValue,
          source: 'GITHUB',
          locator: `github://${l.repository}/${l.path}@${laterCommit.sha.slice(0, 7)}`,
          commitSha: laterCommit.sha,
          author: laterCommit.author,
          message: laterCommit.message,
        });
        laterValue = value;
      }
      laterCommit = commit;
    }
    return changes;
  }

  /**
   * The commit that most recently moved the value away from what was asserted.
   *
   * This is the question the drift card actually asks -- "why do I remember
   * three?" -- and answering it needs the transition *out of* the remembered
   * value, not merely the most recent edit to the file.
   */
  async findChangeAwayFrom(source: SourceRef, assertedValue: unknown): Promise<HistoricalChange | undefined> {
    const changes = await this.history({} as Claim, source);
    const want = JSON.stringify(normaliseLoose(assertedValue));
    return changes.find((c) => JSON.stringify(normaliseLoose(c.from)) === want);
  }

  // ------------------------------------------------------------------ access

  private async token(): Promise<string | undefined> {
    if (this.opts.token) return this.opts.token;
    this.tokenPromise ??= (async () => {
      if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
      // Falling back to the GitHub CLI's own credential keeps the setup
      // instructions to "gh auth login", which most engineers have already done.
      try {
        const gh = launch('gh');
        const { stdout } = await exec(gh.command, ['auth', 'token'], { shell: gh.shell });
        const t = stdout.trim();
        return t || undefined;
      } catch {
        return undefined;
      }
    })();
    return this.tokenPromise;
  }

  private async api<T>(path: string): Promise<T> {
    const base = this.opts.apiBase ?? 'https://api.github.com';
    const token = await this.token();
    const res = await fetch(`${base}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'mental-model-drift',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GitHub ${path} returned HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private async readFile(l: GitHubLocator, ref: string): Promise<{ content: string; sha: string }> {
    if (this.opts.mode === 'localgit') {
      const root = this.opts.repoRoot;
      if (!root) throw new Error('localgit mode requires repoRoot');
      const rev = ref === 'HEAD' ? 'HEAD' : ref;
      const { stdout } = await exec('git', ['-C', root, 'show', `${rev}:${l.path}`], { maxBuffer: 8 * 1024 * 1024 });
      const { stdout: shaOut } = await exec('git', ['-C', root, 'rev-parse', rev]);
      return { content: stdout, sha: shaOut.trim() };
    }
    const body = await this.api<{ content: string; encoding: string; sha: string }>(
      `/repos/${l.repository}/contents/${encodeURI(l.path)}?ref=${encodeURIComponent(ref === 'HEAD' ? (l.ref ?? 'HEAD') : ref)}`,
    );
    const content = body.encoding === 'base64' ? Buffer.from(body.content, 'base64').toString('utf8') : body.content;
    return { content, sha: body.sha };
  }

  private async listCommits(l: GitHubLocator, max: number): Promise<CommitRef[]> {
    if (this.opts.mode === 'localgit') {
      const root = this.opts.repoRoot;
      if (!root) throw new Error('localgit mode requires repoRoot');
      const { stdout } = await exec('git', [
        '-C', root, 'log', `-n${max}`, '--format=%H%x1f%aI%x1f%an%x1f%s', '--', l.path,
      ], { maxBuffer: 8 * 1024 * 1024 });
      return stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, date, author, message] = line.split('\x1f');
          return { sha: sha!, date: date!, author: author!, message: message ?? '' };
        });
    }
    const body = await this.api<GitHubCommit[]>(
      `/repos/${l.repository}/commits?path=${encodeURIComponent(l.path)}&per_page=${Math.min(max, 100)}${l.ref ? `&sha=${encodeURIComponent(l.ref)}` : ''}`,
    );
    return body.map((c) => ({
      sha: c.sha,
      date: c.commit.author?.date ?? c.commit.committer?.date ?? new Date().toISOString(),
      author: c.commit.author?.name ?? 'unknown',
      message: c.commit.message.split('\n')[0]!,
    }));
  }
}

interface CommitRef {
  sha: string;
  date: string;
  author: string;
  message: string;
}

interface GitHubCommit {
  sha: string;
  commit: { message: string; author?: { name?: string; date?: string }; committer?: { date?: string } };
}

/**
 * Pull the addressed value out of a file.
 *
 * SQL gets a real (if small) treatment rather than a substring search: matching
 * `source_ip` anywhere in a schema file would happily find it in a comment, in
 * another table, or in an index definition, and report a column that does not
 * exist.
 */
export function extractValue(l: GitHubLocator, content: string): { found: boolean; value?: unknown; reason?: string } {
  if (l.table && l.column) {
    const table = findCreateTable(content, l.table);
    if (!table) return { found: false, reason: `no CREATE TABLE ${l.table} in ${l.path}` };
    return { found: true, value: hasColumn(table, l.column) };
  }
  if (!l.json_path) return { found: false, reason: 'locator names neither a json_path nor a table/column' };

  let doc: unknown;
  try {
    doc = /\.ya?ml$/i.test(l.path) ? parseYaml(content) : JSON.parse(content);
  } catch (err) {
    return { found: false, reason: `could not parse ${l.path}: ${(err as Error).message}` };
  }
  const { found, value } = readPath(doc, l.json_path);
  return found ? { found: true, value } : { found: false, reason: `${l.json_path} not present in ${l.path}` };
}

function findCreateTable(sql: string, table: string): string | null {
  const re = new RegExp(
    `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:[\\w."]*\\.)?"?${table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\s*\\(`,
    'i',
  );
  const m = re.exec(sql);
  if (!m) return null;
  // Balance parentheses from the opening one so a nested type or CHECK clause
  // does not truncate the body early.
  let depth = 0;
  const start = m.index + m[0].length - 1;
  for (let i = start; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) return sql.slice(start + 1, i);
    }
  }
  return null;
}

function hasColumn(tableBody: string, column: string): boolean {
  const lines = tableBody.split(/,(?![^(]*\))/).map((l) => l.trim());
  const re = new RegExp(`^"?${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\s`, 'i');
  return lines.some((line) => {
    const stripped = line.replace(/^--.*$/gm, '').trim();
    if (/^(primary|foreign|unique|check|constraint|index|key)\b/i.test(stripped)) return false;
    return re.test(stripped);
  });
}

function normaliseLoose(v: unknown): unknown {
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return v;
}
