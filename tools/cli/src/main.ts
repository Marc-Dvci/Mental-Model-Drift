/**
 * `mmd` -- the command line the Agent Skill drives.
 *
 * Mental Model Drift has three surfaces onto the same engine, one per audience:
 *
 *   the dashboard   for the person, after the fact
 *   the MCP server  for an agent that speaks MCP, mid-task
 *   this            for an agent that has a shell, and for a shell script
 *
 * The third exists because Bee's own integration story is a CLI plus a Skill
 * that drives it, and because an agent that can run one command needs no
 * transport, no server and no session. `skills/mental-model-drift/SKILL.md`
 * teaches an agent when to reach for it; this is what it reaches for.
 *
 *   mmd check "the checkout worker retries three times"
 *   mmd check --json "..."          machine-readable, same answer
 *   mmd history checkout-worker retry.max_attempts
 *   mmd properties                  what this registry can settle
 *   mmd open                        drift cards currently open
 *
 * Exit codes are the point of a CLI, so they carry the verdict:
 *   0  supported, or nothing checkable was said
 *   1  drifted -- the human's premise does not match the source
 *   2  inconclusive -- a source could not be read; do not act as if checked
 */
import { buildEngine, checkAssumption, renderFindings, verdictCode } from '#engine';

const USAGE = `mmd -- verify what someone believes about a system against what it is

  mmd check [--json] [--context "<sentence>"]... "<statement>"
  mmd history <subject> <property> [value]
  mmd properties [--json]
  mmd open [--json]

exit: 0 supported/not checkable   1 drifted   2 inconclusive`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const json = argv.includes('--json');

  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  const built = buildEngine();

  switch (command) {
    case 'check': {
      const context: string[] = [];
      const rest: string[] = [];
      for (let i = 1; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--json') continue;
        if (arg === '--context') {
          const value = argv[++i];
          if (value) context.push(value);
          continue;
        }
        rest.push(arg);
      }
      const statement = rest.join(' ').trim();
      if (!statement) {
        console.error('mmd check needs a statement.\n\n' + USAGE);
        process.exitCode = 2;
        return;
      }

      const result = await checkAssumption(built, statement, context, true);
      console.log(json ? JSON.stringify(result, null, 2) : renderFindings(result, { unsupportedHint: 'Run `mmd properties` to see what is in the registry.' }));
      process.exitCode = verdictCode(result);
      return;
    }

    case 'history': {
      const [, subject, property, value] = argv.filter((a) => a !== '--json');
      if (!subject || !property) {
        console.error('mmd history needs a subject and a property.\n\n' + USAGE);
        process.exitCode = 2;
        return;
      }
      const resolved = built.registry.resolve(subject, property);
      if (!resolved) {
        console.error(`No registry entry for ${subject}.${property}. Try \`mmd properties\`.`);
        process.exitCode = 2;
        return;
      }
      const recall = await built.engine.recallOccurrences({
        subject: resolved.systemKey,
        property: resolved.propertyKey,
        ...(value !== undefined ? { assertedValue: value } : {}),
      });
      const changes = await built.store.getHistory(resolved.systemKey, resolved.propertyKey);
      if (json) {
        console.log(JSON.stringify({ subject: resolved.systemKey, property: resolved.propertyKey, occurrences: recall.occurrences, changes }, null, 2));
        return;
      }
      const label = resolved.property.label ?? property;
      console.log(`${label} -- found through Bee ${recall.searchMode} search over ${recall.conversationsSearched} conversation(s)\n`);
      if (recall.occurrences.length === 0) console.log('  no recorded conversation states a value for it');
      for (const o of recall.occurrences) {
        console.log(`  ${o.at.slice(0, 10)}  ${o.afterSourceChange ? '[after the change] ' : ''}${o.excerpt}`);
      }
      for (const c of changes) console.log(`  ${String(c.at).slice(0, 10)}  SOURCE CHANGED ${fmt(c.from)} -> ${fmt(c.to)}${c.message ? ` -- ${c.message}` : ''}`);
      return;
    }

    case 'properties': {
      const catalogue = built.registry.promptCatalogue();
      if (json) {
        console.log(JSON.stringify(catalogue, null, 2));
        return;
      }
      console.log('Properties this registry can settle:\n');
      for (const system of catalogue) {
        console.log(`  ${system.subject}  (${system.aliases.join(', ')})`);
        for (const p of system.properties) {
          console.log(`    ${p.property.padEnd(30)} ${p.type.padEnd(8)} ${p.describes.join(', ')}`);
        }
        console.log('');
      }
      console.log('Anything outside this list returns UNSUPPORTED rather than a guess.');
      return;
    }

    case 'open': {
      const drifts = (await built.store.listDrifts({ limit: 50 })).filter((d) => d.resolution === 'OPEN');
      if (json) {
        console.log(JSON.stringify(drifts, null, 2));
        return;
      }
      if (drifts.length === 0) {
        console.log('No open drift. Nothing said recently disagrees with its source.');
        return;
      }
      for (const d of drifts) {
        console.log(
          `${d.severity}  ${d.subject}.${d.property}: stated ${fmt(d.assertedValue)}, actually ${fmt(d.actualValue)}` +
            `${d.sourceChangeAt ? ` (changed ${d.sourceChangeAt.slice(0, 10)})` : ''}`,
        );
      }
      process.exitCode = 1;
      return;
    }

    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

function fmt(v: unknown): string {
  return typeof v === 'boolean' ? (v ? 'enabled' : 'disabled') : String(v);
}

void main().catch((err: Error) => {
  console.error(`mmd: ${err.message}`);
  process.exitCode = 2;
});
