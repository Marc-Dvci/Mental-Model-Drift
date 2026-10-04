/**
 * Source-registry validation.
 *
 * The registry is the only thing standing between "a language model proposed a
 * subject" and "we went and read a production system", so it is validated
 * eagerly and rejected loudly. A registry that half-loads is worse than one that
 * refuses to load.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ClaimType, SourceRegistry, ValueType } from './types.ts';

const VALUE_TYPES: ValueType[] = ['integer', 'number', 'boolean', 'semver', 'string', 'presence'];
const CLAIM_TYPES: ClaimType[] = ['CONFIG_VALUE', 'FEATURE_STATE', 'SCHEMA_FACT', 'DEPLOYMENT_VERSION'];

export class RegistryError extends Error {
  constructor(public readonly issues: string[]) {
    super(`source registry is invalid:\n  - ${issues.join('\n  - ')}`);
    this.name = 'RegistryError';
  }
}

export function validateRegistry(raw: unknown): SourceRegistry {
  const issues: string[] = [];
  const reg = raw as SourceRegistry;

  if (!reg || typeof reg !== 'object') throw new RegistryError(['registry is not an object']);
  if (reg.version !== 1) issues.push(`unsupported registry version: ${String((reg as any).version)}`);
  if (!reg.systems || typeof reg.systems !== 'object') throw new RegistryError(['registry.systems is missing']);

  // Two systems answering to the same alias makes subject resolution ambiguous,
  // and an ambiguous subject is exactly the case where this product should stay
  // silent rather than guess. Caught here, at load, not at 3am.
  const aliasOwner = new Map<string, string>();

  for (const [systemKey, system] of Object.entries(reg.systems)) {
    const where = `systems.${systemKey}`;
    if (!Array.isArray(system.aliases) || system.aliases.length === 0) {
      issues.push(`${where}.aliases must be a non-empty array`);
    } else {
      for (const alias of [...system.aliases, systemKey]) {
        const norm = alias.toLowerCase().trim();
        const owner = aliasOwner.get(norm);
        if (owner && owner !== systemKey) {
          issues.push(`alias "${alias}" is claimed by both ${owner} and ${systemKey}`);
        }
        aliasOwner.set(norm, systemKey);
      }
    }

    if (!system.properties || Object.keys(system.properties).length === 0) {
      issues.push(`${where}.properties must declare at least one property`);
      continue;
    }

    for (const [propKey, prop] of Object.entries(system.properties)) {
      const pw = `${where}.properties.${propKey}`;
      if (!VALUE_TYPES.includes(prop.type)) issues.push(`${pw}.type "${prop.type}" is not a known value type`);
      if (!CLAIM_TYPES.includes(prop.claimType)) issues.push(`${pw}.claimType "${prop.claimType}" is not a known claim type`);
      if (!['HIGH', 'MEDIUM', 'LOW'].includes(prop.impact)) issues.push(`${pw}.impact must be HIGH, MEDIUM or LOW`);
      if (!Array.isArray(prop.lexemes) || prop.lexemes.length === 0) {
        issues.push(`${pw}.lexemes must list at least one word that points at this property in speech`);
      }
      const src = prop.authoritative_source;
      if (!src || typeof src.adapter !== 'string') {
        issues.push(`${pw}.authoritative_source.adapter is required`);
      } else if (src.authoritative !== true) {
        issues.push(`${pw}.authoritative_source.authoritative must be true`);
      }
      if (prop.historical_source && prop.historical_source.authoritative === true) {
        issues.push(`${pw}.historical_source must not be marked authoritative; it explains the past, it does not define the present`);
      }

      // A property that exists once per region, tenant or environment must say
      // so in its locator. Without this check a registry can declare a scope,
      // resolve it correctly from speech, and then read a hard-coded instance --
      // reporting drift on the US rollout by comparing it against the EU one.
      for (const dimension of Object.keys(prop.scopes ?? {})) {
        const slot = '${scope.' + dimension + '}';
        if (src && !JSON.stringify(src.locator ?? {}).includes(slot)) {
          issues.push(`${pw}.authoritative_source.locator declares scope "${dimension}" but never binds ${slot}`);
        }
        if (prop.historical_source && !JSON.stringify(prop.historical_source.locator ?? {}).includes(slot)) {
          issues.push(`${pw}.historical_source.locator declares scope "${dimension}" but never binds ${slot}`);
        }
      }
    }
  }

  if (issues.length) throw new RegistryError(issues);
  return reg;
}
