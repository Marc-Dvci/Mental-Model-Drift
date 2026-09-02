/**
 * The Assumption Firewall -- Mental Model Drift as an MCP server.
 *
 * The dashboard is for the person. This is for the agent sitting next to them.
 *
 * A coding agent is handed human context constantly, and it has no way to tell
 * a fact from a memory. "The worker retries three times, so a slow consumer
 * isn't the problem" is, to a model, indistinguishable from something true.
 * Acting on it produces a confident patch resting on a premise that stopped
 * holding three weeks ago -- and the agent will defend that patch, because it
 * reasoned correctly from what it was told.
 *
 * So before acting on something a human said, an agent can ask here. The answer
 * is not an opinion: it is the deployed configuration, the release Sentry
 * records, or the checked-in schema, plus the commit that moved it and how many
 * times the person has restated the stale version in conversations Bee recorded.
 *
 *   check_assumption            is this statement still true, and since when not
 *   belief_history              how long has this belief been held, and after what
 *   list_verifiable_properties  what this firewall is able to have an opinion on
 *   open_drifts                 stale beliefs already found, unresolved
 *   record_understanding        write the verified value back into Bee's memory
 *
 * Two deliberate limits. Only registry properties can be checked, and anything
 * outside comes back UNSUPPORTED rather than guessed at. And the one tool that
 * writes is off unless it is explicitly enabled, because a server that reads
 * your conversations should not also edit your assistant's memory by default.
 */
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BuiltEngine } from '#engine';
import type { RecurrenceResult } from '#engine/recurrence';
import { adjudicateAll, scoreSeverity, type Claim, type Evidence, type HistoricalChange } from '#spec';

export interface McpOptions {
  /** Enables record_understanding, the one tool that writes to Bee. */
  allowWrites?: boolean;
}

export function createMcpServer(built: BuiltEngine, opts: McpOptions = {}): McpServer {
  const allowWrites = opts.allowWrites ?? false;
  const server = new McpServer(
    { name: 'mental-model-drift', version: '0.1.0' },
    {
      instructions:
        'Verify human statements about software systems against their authoritative sources before acting on them. ' +
        'Call check_assumption whenever a human tells you a configuration value, feature-flag state, deployed version ' +
        'or schema fact that your next action depends on. A DRIFTED result means the person is describing the system ' +
        'as it used to be: use actualValue, and tell them what changed and when rather than silently correcting them.',
    },
  );

  server.registerTool(
    'check_assumption',
    {
      title: 'Check an assumption against the source of truth',
      description:
        'Verify a statement a human made about a system against the authoritative source for that property ' +
        '(AWS AppConfig, Sentry, or the checked-in schema). Returns SUPPORTED, DRIFTED, INCONCLUSIVE or UNSUPPORTED, ' +
        'with the evidence, the change that made it wrong, and how often the belief has been restated in the ' +
        "wearer's recorded conversations. Use before acting on human-supplied context.",
      inputSchema: {
        statement: z.string().min(3).describe('The statement to check, in the words it was said or written.'),
        context: z
          .array(z.string())
          .optional()
          .describe('Preceding sentences. Used only to resolve a subject the statement refers to as "it".'),
        includeHistory: z
          .boolean()
          .optional()
          .describe('Also reconstruct when the value changed and how often the belief was restated. Default true.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ statement, context, includeHistory }) => checkAssumption(built, statement, context ?? [], includeHistory ?? true),
  );

  server.registerTool(
    'belief_history',
    {
      title: 'How long has this belief been held',
      description:
        'For one registry property, return every conversation in which the wearer stated a value for it, alongside ' +
        'the times the authoritative source changed. Answers "have they been working from this for weeks, or did ' +
        'they just misspeak".',
      inputSchema: {
        subject: z.string().describe('Registry system key, e.g. "checkout-worker".'),
        property: z.string().describe('Registry property key, e.g. "retry.max_attempts".'),
        value: z.string().optional().describe('Restrict to statements of this value. Omit for every value stated.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ subject, property, value }) => {
      const resolved = built.registry.resolve(subject, property);
      if (!resolved) return text(`No registry entry for ${subject}.${property}.`, true);

      const recall = await built.engine.recallOccurrences({
        subject: resolved.systemKey,
        property: resolved.propertyKey,
        ...(value !== undefined ? { assertedValue: value } : {}),
      });
      const label = resolved.property.label ?? property;
      const sourceChanges = await built.store.getHistory(resolved.systemKey, resolved.propertyKey);

      return structured(
        {
          subject: resolved.systemKey,
          property: resolved.propertyKey,
          label,
          beeQuery: recall.query,
          searchMode: recall.searchMode,
          conversationsSearched: recall.conversationsSearched,
          occurrences: recall.occurrences,
          sourceChanges,
        },
        recall.occurrences.length === 0
          ? `No recorded conversation states a value for ${label}.`
          : [
              `${recall.occurrences.length} conversation(s) state a value for ${label}, found through Bee ${recall.searchMode} search:`,
              ...recall.occurrences.map(
                (o) => `  ${o.at.slice(0, 10)}  ${o.afterSourceChange ? '[after the change] ' : ''}${o.excerpt}`,
              ),
            ].join('\n'),
      );
    },
  );

  server.registerTool(
    'list_verifiable_properties',
    {
      title: 'What this firewall can check',
      description:
        'The source registry: every system and property whose value can be verified, the spoken vocabulary that ' +
        'points at each one, and which source is authoritative for it. Anything not listed here cannot be checked ' +
        'and comes back UNSUPPORTED.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const systems = built.registry.systemKeys().map((key) => {
        const system = built.registry.system(key)!;
        return {
          subject: key,
          label: system.label ?? key,
          aliases: system.aliases,
          properties: Object.entries(system.properties).map(([property, p]) => ({
            property,
            label: p.label ?? property,
            type: p.type,
            claimType: p.claimType,
            impact: p.impact,
            spokenAs: p.lexemes,
            authoritativeSource: p.authoritative_source.adapter,
          })),
        };
      });
      return structured(
        { systems, mode: built.mode },
        systems
          .map((s) => `${s.label} (${s.subject})\n${s.properties.map((p) => `  ${p.property}  ${p.type}  via ${p.authoritativeSource}`).join('\n')}`)
          .join('\n\n'),
      );
    },
  );

  server.registerTool(
    'open_drifts',
    {
      title: 'Stale beliefs already found',
      description:
        'Unresolved drift between what the wearer has said and what their systems are. Worth reading at the start ' +
        'of a task: if what you are about to change depends on one of these, say so before you write anything.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const drifts = (await built.store.listDrifts({ limit: limit ?? 20 })).filter((d) => d.resolution === 'OPEN');
      return structured(
        { drifts },
        drifts.length === 0
          ? 'No open drift.'
          : drifts
              .map(
                (d) =>
                  `${d.severity}  ${d.subject}.${d.property}: said ${fmt(d.assertedValue)}, actually ${fmt(d.actualValue)}` +
                  `${d.sourceChangeAt ? ` (changed ${d.sourceChangeAt.slice(0, 10)})` : ''}` +
                  `${d.priorOccurrences.length ? `, restated in ${d.priorOccurrences.length} earlier conversation(s)` : ''}` +
                  `\n  drift id ${d.id}`,
              )
              .join('\n'),
      );
    },
  );

  server.registerTool(
    'record_understanding',
    {
      title: 'Write the corrected value into Bee memory',
      description:
        "Record the verified value as a confirmed fact in the wearer's Bee memory, so their assistant answers with " +
        'it next time. Takes a drift id from open_drifts. Disabled unless the server was started with writes enabled.',
      inputSchema: { driftId: z.string().describe('Drift id, as returned by open_drifts.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ driftId }) => {
      if (!allowWrites) {
        return text(
          'Writing to Bee memory is disabled on this server. Start it with MMD_MCP_ALLOW_WRITES=1, or use the ' +
            'dashboard, where the same action sits behind a confirmation the wearer sees.',
          true,
        );
      }
      const drift = await built.store.getDrift(driftId);
      if (!drift) return text(`No drift with id ${driftId}.`, true);
      if (drift.confirmationRequired) {
        // Ownership is diarisation, not identity. A belief that cannot be
        // attributed to the wearer must not be written into their memory by an
        // agent acting on its own.
        return text(
          `Drift ${driftId} is not attributed to the wearer (ownership ${drift.ownership}). The person has to ` +
            'confirm it in the dashboard before anything is written to their memory.',
          true,
        );
      }
      const result = await built.engine.updateUnderstanding(driftId);
      return structured(
        { factText: result.factText, factId: result.factId, error: result.error, resolution: result.drift.resolution },
        result.error ? `Could not write the fact: ${result.error}` : `Wrote to Bee memory: ${result.factText}`,
      );
    },
  );

  return server;
}

// ---------------------------------------------------------------------------

/**
 * The firewall itself.
 *
 * Same registry, same grounding gate, same deterministic comparator as the
 * wearable feed. An agent asking about a sentence gets exactly the answer the
 * dashboard would show for it, which is the property that makes having two
 * surfaces worth anything.
 */
export async function checkAssumption(built: BuiltEngine, statement: string, context: string[], includeHistory: boolean) {
  const extraction = await built.engine.extractOnly({ text: statement, window: context });

  if (extraction.accepted.length === 0) {
    const why = extraction.rejected[0]?.reason ?? 'no registry property is named in the statement';
    return structured(
      { verdict: 'UNSUPPORTED', statement, reason: why, checkable: false },
      `UNSUPPORTED -- this statement is outside what can be verified.\n  ${why}\n` +
        'Call list_verifiable_properties to see what is in the registry.',
    );
  }

  const findings: Finding[] = [];
  for (const accepted of extraction.accepted) {
    const resolved = built.registry.resolve(accepted.proposal.subject, accepted.proposal.property)!;
    const claim: Claim = {
      id: randomUUID(),
      userId: 'mcp',
      sourceConversationId: 'mcp',
      originalText: statement,
      claimType: accepted.proposal.claimType,
      subject: accepted.proposal.subject,
      property: accepted.proposal.property,
      ...(accepted.proposal.object ? { object: accepted.proposal.object } : {}),
      ...(accepted.proposal.scope ? { scope: accepted.proposal.scope } : {}),
      assertedValue: accepted.proposal.assertedValue,
      valueType: resolved.property.type,
      ownership: 'UNKNOWN',
      extractionConfidence: accepted.confidence,
      grounding: accepted.grounding,
      capturedAt: new Date().toISOString(),
      status: 'CANDIDATE',
    };

    const source = resolved.property.authoritative_source;
    const verifier = built.verifiers.find((v) => v.canVerify(claim, source));
    const evidence: Evidence[] = verifier ? [await verifier.verify(claim, source)] : [];
    const adjudication = adjudicateAll(claim, evidence);

    let change: HistoricalChange | undefined;
    let recall: RecurrenceResult | undefined;
    if (includeHistory && adjudication.verdict === 'DRIFTED') {
      const historySource = resolved.property.historical_source ?? source;
      const historyVerifier = built.verifiers.find((v) => v.canVerify(claim, historySource));
      const changes = (await historyVerifier?.history?.(claim, historySource).catch(() => [])) ?? [];
      change = changes.find((c) => String(c.from) === String(claim.assertedValue));
      recall = await built.engine.recallOccurrences({
        subject: claim.subject,
        property: claim.property,
        assertedValue: claim.assertedValue,
        ...(claim.object ? { object: claim.object } : {}),
        ...(claim.scope ? { scope: claim.scope } : {}),
        ...(change ? { sourceChangeAt: change.at } : {}),
      });
    }

    const now = new Date().toISOString();
    const severity =
      adjudication.verdict === 'DRIFTED'
        ? scoreSeverity({
            impact: resolved.property.impact,
            priorOccurrences: recall?.occurrences ?? [],
            detectedAt: now,
            lastSpokenAt: now,
            ...(change ? { sourceChangeAt: change.at } : {}),
          })
        : undefined;

    findings.push({
      verdict: adjudication.verdict,
      reason: adjudication.reason,
      subject: claim.subject,
      property: claim.property,
      label: resolved.property.label ?? claim.property,
      ...(claim.scope ? { scope: claim.scope } : {}),
      ...(claim.object ? { object: claim.object } : {}),
      assertedValue: claim.assertedValue,
      actualValue: adjudication.normalisedActual,
      evidence: evidence.map((e) => ({
        source: e.source,
        locator: e.sourceLocator,
        status: e.status,
        value: e.value,
        fetchedAt: e.fetchedAt,
      })),
      ...(change ? { changedAt: change.at, changedBy: change.commitSha ?? change.locator, changeMessage: change.message } : {}),
      ...(recall ? { priorOccurrences: recall.occurrences, beeQuery: recall.query } : {}),
      ...(severity ? { severity: severity.severity, severityFactors: severity.factors } : {}),
      groundedOn: accepted.grounding,
      confidence: accepted.confidence,
    });
  }

  return structured({ statement, findings }, findings.map(renderFinding).join('\n\n'));
}

interface Finding {
  verdict: string;
  reason: string;
  subject: string;
  property: string;
  label: string;
  scope?: Record<string, string>;
  object?: string;
  assertedValue: unknown;
  actualValue: unknown;
  evidence: { source: string; locator: string; status: string; value: unknown; fetchedAt: string }[];
  changedAt?: string;
  changedBy?: string;
  changeMessage?: string;
  priorOccurrences?: { at: string; excerpt: string; afterSourceChange: boolean }[];
  beeQuery?: string;
  severity?: string;
  severityFactors?: { name: string; points: number; because: string }[];
  groundedOn: unknown;
  confidence: number;
}

/**
 * The text an agent reads. Written as an instruction rather than a report: the
 * useful behaviour is not "know the value", it is "use the real one and tell
 * the human what moved".
 */
function renderFinding(f: Finding): string {
  const lines = [`${f.verdict} -- ${f.label}${f.scope ? ` (${Object.entries(f.scope).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}`];
  if (f.verdict === 'DRIFTED') {
    lines.push(`  stated ${fmt(f.assertedValue)}, actually ${fmt(f.actualValue)}`);
    if (f.changedAt) lines.push(`  changed ${f.changedAt.slice(0, 10)}${f.changeMessage ? ` -- ${f.changeMessage}` : ''}`);
    if (f.severity) lines.push(`  severity ${f.severity}`);
    const after = (f.priorOccurrences ?? []).filter((o) => o.afterSourceChange).length;
    if (f.priorOccurrences?.length) {
      lines.push(`  restated in ${f.priorOccurrences.length} earlier conversation(s)${after ? `, ${after} of them after the change` : ''}`);
    }
    lines.push('  Act on the actual value, and tell the human what changed and when rather than silently correcting them.');
  } else if (f.verdict === 'SUPPORTED') {
    lines.push(`  ${fmt(f.actualValue)}, as stated. Safe to act on.`);
  } else {
    lines.push(`  ${f.reason}`);
    lines.push('  Treat this as neither confirmed nor refuted; do not act as though it were checked.');
  }
  for (const e of f.evidence) lines.push(`  evidence: ${e.source} ${e.status} ${e.locator}`);
  return lines.join('\n');
}

// ------------------------------------------------------------------ plumbing

function text(body: string, isError = false) {
  return { content: [{ type: 'text' as const, text: body }], ...(isError ? { isError: true } : {}) };
}

function structured(data: Record<string, unknown>, body: string) {
  return { content: [{ type: 'text' as const, text: body }], structuredContent: data };
}

function fmt(v: unknown): string {
  return typeof v === 'boolean' ? (v ? 'enabled' : 'disabled') : String(v);
}
