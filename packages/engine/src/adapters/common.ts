import { createHash, randomUUID } from 'node:crypto';
import type { Evidence } from '#spec';

export function makeEvidence(input: {
  claimId: string;
  source: string;
  sourceLocator: string;
  status: Evidence['status'];
  value: unknown;
  authoritative: boolean;
  version?: string;
  commitSha?: string;
  error?: string;
  fetchedAt?: string;
}): Evidence {
  const fetchedAt = input.fetchedAt ?? new Date().toISOString();
  // What was read, never when it was read. Two readings a second apart that
  // return the same value have to hash the same, or the hash cannot answer the
  // only question it is asked: has the source's answer changed since last time?
  const body = {
    source: input.source,
    sourceLocator: input.sourceLocator,
    status: input.status,
    value: input.value ?? null,
    authoritative: input.authoritative,
    version: input.version ?? null,
    commitSha: input.commitSha ?? null,
  };
  return {
    id: randomUUID(),
    claimId: input.claimId,
    source: input.source,
    sourceLocator: input.sourceLocator,
    status: input.status,
    authoritative: input.authoritative,
    fetchedAt,
    ...(input.version ? { version: input.version } : {}),
    ...(input.commitSha ? { commitSha: input.commitSha } : {}),
    ...(input.error ? { error: input.error } : {}),
    value: input.value,
    evidenceHash: createHash('sha256').update(stableStringify(body)).digest('hex'),
  };
}

/** Key-sorted JSON so an evidence hash does not depend on property order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * A deliberately small subset of JSONPath: `$.a.b`, `$.a[0].b`, `$["a b"]`.
 *
 * A full implementation would accept filters and wildcards, which can select
 * more than one node. A property whose authoritative value is "whatever these
 * three nodes are" is not a property this product can adjudicate, so the
 * restricted grammar is the feature.
 */
export function readPath(root: unknown, path: string): { found: boolean; value: unknown } {
  const clean = path.trim().replace(/^\$\.?/, '');
  if (!clean) return { found: true, value: root };
  const tokens = clean.match(/[^.[\]"']+|\[\d+\]/g);
  if (!tokens) return { found: false, value: undefined };
  let cur: unknown = root;
  for (const tokenRaw of tokens) {
    const token = tokenRaw.replace(/^\[|\]$/g, '');
    if (cur === null || cur === undefined) return { found: false, value: undefined };
    if (Array.isArray(cur)) {
      const idx = Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { found: false, value: undefined };
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== 'object') return { found: false, value: undefined };
    const obj = cur as Record<string, unknown>;
    if (!(token in obj)) return { found: false, value: undefined };
    cur = obj[token];
  }
  return { found: true, value: cur };
}

export function loc(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Bind a claim's scope and object into a registry locator.
 *
 * A registry entry addresses a *property*, not one instance of it. The rollout
 * flag exists per region, and writing three near-identical entries -- one per
 * region, each with its own hard-coded json_path -- is how a claim about the US
 * ends up silently verified against the EU value. So the locator names the
 * dimension instead:
 *
 *     json_path: $.new_checkout.regions.${scope.region}
 *
 * and the scope actually resolved from the spoken words is substituted here.
 * A placeholder with nothing to fill it is an error rather than an empty
 * string, because reading `$.new_checkout.regions.` would return the whole map
 * and compare a boolean against an object.
 */
export function bindLocator<T extends Record<string, unknown>>(
  locator: T,
  binding: { scope?: Record<string, string>; object?: string },
): T {
  const substitute = (value: string): string =>
    value.replace(/\$\{(scope\.[A-Za-z0-9_]+|object)\}/g, (_match, ref: string) => {
      const resolved = ref === 'object' ? binding.object : binding.scope?.[ref.slice('scope.'.length)];
      if (resolved === undefined || resolved === '') {
        throw new Error(`locator needs ${ref}, and the claim does not carry one`);
      }
      return resolved;
    });

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return substitute(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };

  return walk(locator) as T;
}

/** True when a locator contains at least one `${scope.x}` / `${object}` slot. */
export function hasBinding(locator: Record<string, unknown>, ref: string): boolean {
  return JSON.stringify(locator).includes(`\${${ref}}`);
}
