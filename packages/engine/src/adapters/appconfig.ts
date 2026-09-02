/**
 * AWS AppConfig -- the authoritative source for what production is running
 * right now.
 *
 * Deployed configuration, not the repository, is what the service actually
 * reads, which is why this adapter is the authoritative one for CONFIG_VALUE
 * and FEATURE_STATE and GitHub is not. The repository answers a different and
 * strictly historical question: when did this stop being what the engineer
 * remembers?
 *
 * Two modes, one contract:
 *
 *   live   StartConfigurationSession + GetLatestConfiguration (appconfigdata),
 *          and the hosted-configuration version list for history (appconfig)
 *   local  the same JSON documents on disk, for offline development, tests and
 *          the golden scenarios
 *
 * Both return identical Evidence. The mode is recorded in the locator so a
 * human reading an evidence panel can always tell which one produced a value.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Claim, Evidence, HistoricalChange, SourceRef, Verifier } from '#spec';
import { bindLocator, makeEvidence, readPath } from './common.ts';

export interface AppConfigLocator {
  application: string;
  environment: string;
  profile: string;
  json_path: string;
}

export interface AppConfigAdapterOptions {
  mode: 'live' | 'local';
  region?: string;
  /** Root of the on-disk mirror used in local mode. */
  fixtureRoot?: string;
  /** Identifier this client presents to AppConfig for session affinity. */
  clientId?: string;
}

export class AppConfigVerifier implements Verifier {
  readonly name = 'aws_appconfig';
  private sessionTokens = new Map<string, string>();

  constructor(private readonly opts: AppConfigAdapterOptions) {}

  canVerify(_claim: Claim, source: SourceRef): boolean {
    return source.adapter === this.name;
  }

  async verify(claim: Claim, source: SourceRef): Promise<Evidence> {
    // The registry addresses the property; the claim says which instance of it.
    let l: AppConfigLocator;
    try {
      l = bindLocator(source.locator, { ...(claim.scope ? { scope: claim.scope } : {}), ...(claim.object ? { object: claim.object } : {}) }) as unknown as AppConfigLocator;
    } catch (err) {
      const raw = source.locator as unknown as AppConfigLocator;
      return makeEvidence({
        claimId: claim.id,
        source: 'AWS_APPCONFIG',
        sourceLocator: `appconfig://${raw.application}/${raw.environment}/${raw.profile}${raw.json_path} (${this.opts.mode})`,
        status: 'AMBIGUOUS',
        value: undefined,
        authoritative: source.authoritative,
        error: (err as Error).message,
      });
    }
    const locator = `appconfig://${l.application}/${l.environment}/${l.profile}${l.json_path} (${this.opts.mode})`;
    try {
      const doc = this.opts.mode === 'live' ? await this.fetchLive(l) : this.fetchLocal(l);
      const { found, value } = readPath(doc, l.json_path);
      if (!found) {
        return makeEvidence({
          claimId: claim.id,
          source: 'AWS_APPCONFIG',
          sourceLocator: locator,
          status: 'NOT_FOUND',
          value: undefined,
          authoritative: source.authoritative,
          error: `${l.json_path} is not present in the deployed configuration`,
        });
      }
      return makeEvidence({
        claimId: claim.id,
        source: 'AWS_APPCONFIG',
        sourceLocator: locator,
        status: 'OK',
        value,
        authoritative: source.authoritative,
      });
    } catch (err) {
      // A connector failure is never drift. It is the absence of an answer.
      return makeEvidence({
        claimId: claim.id,
        source: 'AWS_APPCONFIG',
        sourceLocator: locator,
        status: 'UNAVAILABLE',
        value: undefined,
        authoritative: source.authoritative,
        error: (err as Error).message,
      });
    }
  }

  /**
   * When each hosted configuration version changed the value at `json_path`.
   *
   * AppConfig keeps every hosted version, so this reconstructs the value's
   * history without needing the repository at all -- useful when the deployed
   * value was changed by hand and never went through a commit.
   */
  async history(claim: Claim, source: SourceRef): Promise<HistoricalChange[]> {
    const l = bindLocator(source.locator, {
      ...(claim?.scope ? { scope: claim.scope } : {}),
      ...(claim?.object ? { object: claim.object } : {}),
    }) as unknown as AppConfigLocator;
    const versions = this.opts.mode === 'live' ? await this.historyLive(l) : this.historyLocal(l);
    const changes: HistoricalChange[] = [];
    let previous: unknown = undefined;
    let first = true;
    for (const v of versions) {
      const { found, value } = readPath(v.content, l.json_path);
      if (!found) continue;
      if (first) {
        previous = value;
        first = false;
        continue;
      }
      if (JSON.stringify(value) !== JSON.stringify(previous)) {
        changes.push({
          at: v.at,
          from: previous,
          to: value,
          source: 'AWS_APPCONFIG',
          locator: `appconfig://${l.application}/${l.environment}/${l.profile} v${v.version}`,
          ...(v.description ? { message: v.description } : {}),
        });
        previous = value;
      }
    }
    return changes;
  }

  // ------------------------------------------------------------------- live

  private async fetchLive(l: AppConfigLocator): Promise<unknown> {
    const { AppConfigDataClient, StartConfigurationSessionCommand, GetLatestConfigurationCommand } =
      await import('@aws-sdk/client-appconfigdata');
    const client = new AppConfigDataClient({ region: this.opts.region ?? process.env.AWS_REGION });
    const key = `${l.application}/${l.environment}/${l.profile}`;

    // AppConfig sessions are single-use tokens that roll forward: each
    // GetLatestConfiguration returns the token for the next poll. Caching it
    // is what makes repeated verification cheap rather than a new session per
    // claim.
    let token = this.sessionTokens.get(key);
    if (!token) {
      const started = await client.send(
        new StartConfigurationSessionCommand({
          ApplicationIdentifier: l.application,
          EnvironmentIdentifier: l.environment,
          ConfigurationProfileIdentifier: l.profile,
        }),
      );
      token = started.InitialConfigurationToken!;
    }
    const res = await client.send(new GetLatestConfigurationCommand({ ConfigurationToken: token }));
    if (res.NextPollConfigurationToken) this.sessionTokens.set(key, res.NextPollConfigurationToken);

    if (!res.Configuration || res.Configuration.length === 0) {
      // An empty body means "unchanged since your last poll", not "empty
      // configuration". Re-open a session and read once more rather than
      // reporting an absent value.
      this.sessionTokens.delete(key);
      if (!this.reentered) {
        this.reentered = true;
        try {
          return await this.fetchLive(l);
        } finally {
          this.reentered = false;
        }
      }
      throw new Error('AppConfig returned no configuration body');
    }
    return JSON.parse(new TextDecoder().decode(res.Configuration));
  }

  private reentered = false;

  private async historyLive(l: AppConfigLocator): Promise<HostedVersion[]> {
    const { AppConfigClient, ListHostedConfigurationVersionsCommand, GetHostedConfigurationVersionCommand } =
      await import('@aws-sdk/client-appconfig');
    const client = new AppConfigClient({ region: this.opts.region ?? process.env.AWS_REGION });
    const list = await client.send(
      new ListHostedConfigurationVersionsCommand({
        ApplicationId: l.application,
        ConfigurationProfileId: l.profile,
        MaxResults: 50,
      }),
    );
    const items = (list.Items ?? []).slice().sort((a, b) => (a.VersionNumber ?? 0) - (b.VersionNumber ?? 0));
    const out: HostedVersion[] = [];
    for (const item of items) {
      const got = await client.send(
        new GetHostedConfigurationVersionCommand({
          ApplicationId: l.application,
          ConfigurationProfileId: l.profile,
          VersionNumber: item.VersionNumber,
        }),
      );
      const bytes = await got.Content?.transformToString();
      if (!bytes) continue;
      out.push({
        version: item.VersionNumber ?? 0,
        at: new Date().toISOString(),
        description: item.Description,
        content: JSON.parse(bytes),
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ local

  private path(l: AppConfigLocator, suffix: string): string {
    const root = this.opts.fixtureRoot ?? join(process.cwd(), 'demo', 'appconfig');
    return join(root, l.application, l.environment, `${l.profile}${suffix}`);
  }

  private fetchLocal(l: AppConfigLocator): unknown {
    const p = this.path(l, '.json');
    if (!existsSync(p)) throw new Error(`no local AppConfig mirror at ${p}`);
    return JSON.parse(readFileSync(p, 'utf8'));
  }

  private historyLocal(l: AppConfigLocator): HostedVersion[] {
    const p = this.path(l, '.history.json');
    if (!existsSync(p)) return [];
    return JSON.parse(readFileSync(p, 'utf8')) as HostedVersion[];
  }
}

interface HostedVersion {
  version: number;
  at: string;
  description?: string;
  content: unknown;
}
