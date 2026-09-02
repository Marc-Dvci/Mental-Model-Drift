/**
 * The Source Registry.
 *
 * This is the product's central safety property. A language model is never
 * asked "is this statement true"; it is asked "which of these known properties
 * is this sentence about". Truth then comes from whatever the registry names as
 * authoritative. The registry is therefore the boundary of what the system is
 * even willing to have an opinion on, and it is human-authored and reviewed.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  validateRegistry,
  type RegistryProperty,
  type RegistrySystem,
  type SourceRegistry,
} from '#spec';

export interface ResolvedProperty {
  systemKey: string;
  system: RegistrySystem;
  propertyKey: string;
  property: RegistryProperty;
}

export class Registry {
  private readonly aliasIndex = new Map<string, string>();

  constructor(readonly raw: SourceRegistry) {
    for (const [key, system] of Object.entries(raw.systems)) {
      for (const alias of [key, ...system.aliases]) {
        this.aliasIndex.set(normalise(alias), key);
      }
    }
  }

  static fromFile(path: string): Registry {
    const text = readFileSync(path, 'utf8');
    const parsed = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
    return new Registry(validateRegistry(parsed));
  }

  systemKeys(): string[] {
    return Object.keys(this.raw.systems);
  }

  system(key: string): RegistrySystem | undefined {
    return this.raw.systems[key];
  }

  resolve(subject: string, property: string): ResolvedProperty | undefined {
    const systemKey = this.aliasIndex.get(normalise(subject));
    if (!systemKey) return undefined;
    const system = this.raw.systems[systemKey]!;
    const prop = system.properties[property];
    if (!prop) return undefined;
    return { systemKey, system, propertyKey: property, property: prop };
  }

  /**
   * Longest-alias-wins subject detection over free text.
   *
   * Aliases overlap in real vocabularies: "checkout", "checkout service" and
   * "new checkout" can all be registered, to three different systems. Matching
   * longest-first and *claiming the span* is what stops "the checkout service is
   * still running 4.12" from also counting as a statement about the checkout
   * worker.
   *
   * Every genuinely distinct system mentioned is returned. A sentence naming two
   * of them is ambiguous, and callers are expected to refuse it rather than
   * pick one.
   */
  findSubjects(text: string): { systemKey: string; alias: string }[] {
    const haystack = ` ${normalise(text)} `;
    const hits = new Map<string, string>();
    const claimed: [number, number][] = [];
    const aliases = [...this.aliasIndex.keys()].sort((a, b) => b.length - a.length);

    for (const alias of aliases) {
      const needle = ` ${alias} `;
      let free = false;
      for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
        const span: [number, number] = [i + 1, i + 1 + alias.length];
        if (claimed.some(([s, e]) => span[0] < e && s < span[1])) continue;
        claimed.push(span);
        free = true;
      }
      if (!free) continue;
      const systemKey = this.aliasIndex.get(alias)!;
      if (!hits.has(systemKey)) hits.set(systemKey, alias);
    }
    return [...hits].map(([systemKey, alias]) => ({ systemKey, alias }));
  }

  /** Properties of a system whose lexemes appear in the text, best match first. */
  findProperties(systemKey: string, text: string): { propertyKey: string; lexeme: string; property: RegistryProperty }[] {
    const system = this.raw.systems[systemKey];
    if (!system) return [];
    const haystack = ` ${normalise(text)} `;
    const out: { propertyKey: string; lexeme: string; property: RegistryProperty }[] = [];
    for (const [propertyKey, property] of Object.entries(system.properties)) {
      let best: string | null = null;
      for (const lexeme of property.lexemes) {
        const n = normalise(lexeme);
        if (haystack.includes(` ${n} `) && (best === null || n.length > best.length)) best = n;
      }
      if (best) out.push({ propertyKey, lexeme: best, property });
    }
    return out.sort((a, b) => b.lexeme.length - a.lexeme.length);
  }

  /** A compact catalogue for the extraction prompt. Nothing else is sent. */
  promptCatalogue(): { subject: string; aliases: string[]; properties: { property: string; type: string; claimType: string; describes: string[] }[] }[] {
    return Object.entries(this.raw.systems).map(([subject, system]) => ({
      subject,
      aliases: system.aliases,
      properties: Object.entries(system.properties).map(([property, p]) => ({
        property,
        type: p.type,
        claimType: p.claimType,
        describes: p.lexemes,
      })),
    }));
  }
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[_\-.]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
