/**
 * Sentry -- release and deployment metadata, the authoritative answer to
 * "what version is actually running in production".
 *
 * Sentry is used rather than a CI system on purpose: what a pipeline says it
 * deployed and what is running are different claims, and the errors coming back
 * tagged with a release are evidence of the second.
 *
 * The deployment series doubles as history, so DEPLOYMENT_VERSION drift can
 * explain itself ("4.12 was production until the 4.13 deploy on August 29")
 * without touching the repository at all.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Claim, Evidence, HistoricalChange, SourceRef, Verifier } from '#spec';
import { makeEvidence } from './common.ts';

export interface SentryLocator {
  organization: string;
  project: string;
  environment: string;
}

export interface SentryAdapterOptions {
  mode: 'live' | 'local';
  token?: string;
  baseUrl?: string;
  fixtureRoot?: string;
}

interface SentryRelease {
  version: string;
  dateCreated?: string;
  lastDeploy?: { environment?: string; dateFinished?: string; dateStarted?: string };
  projects?: { slug: string }[];
}

export class SentryVerifier implements Verifier {
  readonly name = 'sentry';

  constructor(private readonly opts: SentryAdapterOptions) {}

  canVerify(_claim: Claim, source: SourceRef): boolean {
    return source.adapter === this.name;
  }

  async verify(claim: Claim, source: SourceRef): Promise<Evidence> {
    const l = source.locator as unknown as SentryLocator;
    const locator = `sentry://${l.organization}/${l.project}?environment=${l.environment} (${this.opts.mode})`;
    try {
      const deploys = await this.deployments(l);
      const current = deploys.at(-1);
      if (!current) {
        return makeEvidence({
          claimId: claim.id,
          source: 'SENTRY',
          sourceLocator: locator,
          status: 'NOT_FOUND',
          value: undefined,
          authoritative: source.authoritative,
          error: `no release has been deployed to ${l.environment}`,
        });
      }
      return makeEvidence({
        claimId: claim.id,
        source: 'SENTRY',
        sourceLocator: locator,
        status: 'OK',
        value: current.version,
        authoritative: source.authoritative,
        version: current.version,
      });
    } catch (err) {
      return makeEvidence({
        claimId: claim.id,
        source: 'SENTRY',
        sourceLocator: locator,
        status: 'UNAVAILABLE',
        value: undefined,
        authoritative: source.authoritative,
        error: (err as Error).message,
      });
    }
  }

  async history(_claim: Claim, source: SourceRef): Promise<HistoricalChange[]> {
    const l = source.locator as unknown as SentryLocator;
    const deploys = await this.deployments(l);
    const out: HistoricalChange[] = [];
    for (let i = 1; i < deploys.length; i++) {
      out.push({
        at: deploys[i]!.at,
        from: deploys[i - 1]!.version,
        to: deploys[i]!.version,
        source: 'SENTRY',
        locator: `sentry://${l.organization}/${l.project}/releases/${deploys[i]!.version}`,
        message: `deployed to ${l.environment}`,
      });
    }
    // Newest first matches how the rest of the engine reads history.
    return out.reverse();
  }

  /** Deployments to the requested environment, oldest first. */
  private async deployments(l: SentryLocator): Promise<{ version: string; at: string }[]> {
    const releases = this.opts.mode === 'live' ? await this.fetchLive(l) : this.fetchLocal(l);
    return releases
      .filter((r) => r.lastDeploy?.environment === l.environment)
      .map((r) => ({
        version: r.version,
        at: r.lastDeploy?.dateFinished ?? r.lastDeploy?.dateStarted ?? r.dateCreated ?? new Date(0).toISOString(),
      }))
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  private async fetchLive(l: SentryLocator): Promise<SentryRelease[]> {
    const token = this.opts.token ?? process.env.SENTRY_AUTH_TOKEN;
    if (!token) throw new Error('SENTRY_AUTH_TOKEN is not set');
    const base = this.opts.baseUrl ?? 'https://sentry.io';
    const url = `${base}/api/0/organizations/${encodeURIComponent(l.organization)}/releases/?per_page=100&project=${encodeURIComponent(l.project)}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Sentry releases returned HTTP ${res.status}`);
    return (await res.json()) as SentryRelease[];
  }

  private fetchLocal(l: SentryLocator): SentryRelease[] {
    const root = this.opts.fixtureRoot ?? join(process.cwd(), 'demo', 'sentry');
    const p = join(root, l.organization, `${l.project}.json`);
    if (!existsSync(p)) throw new Error(`no local Sentry mirror at ${p}`);
    return JSON.parse(readFileSync(p, 'utf8')) as SentryRelease[];
  }
}
