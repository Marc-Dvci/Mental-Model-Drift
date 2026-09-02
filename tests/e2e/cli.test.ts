/**
 * The `mmd` command line, as an agent following the Agent Skill meets it: a
 * real process, a real exit code, a real Bee emulator behind it.
 *
 * The exit code *is* the contract here. `SKILL.md` tells an agent that 1 means
 * the human's premise is stale and 2 means a source could not be read, and an
 * agent that trusts that will act differently on each. Collapsing them -- the
 * easy mistake, since both are "not 0" -- would make a connector outage look
 * exactly like a person being wrong, which is the one failure this whole
 * product exists to avoid. So it is asserted from outside the process, where an
 * agent would see it, rather than from a return value in-process.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { BeeSim } from '../../tools/bee-sim/src/server.ts';
import { REPO_ROOT, TSX } from '../helpers.ts';

let sim: BeeSim;
let stateDir: string;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  sim = new BeeSim({
    port: 0,
    fixtureDir: join(REPO_ROOT, 'demo', 'conversations'),
    log: () => {},
  });
  const simPort = await sim.listen();
  stateDir = mkdtempSync(join(tmpdir(), 'mmd-cli-'));
  env = {
    ...process.env,
    BEE_PROXY_URL: `http://127.0.0.1:${simPort}`,
    BEE_ALLOW_CLI: '0',
    MMD_STATE_PATH: join(stateDir, 'store.json'),
  };
}, 60_000);

afterAll(async () => {
  await sim.close();
  rmSync(stateDir, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function mmd(...args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX, 'tools/cli/src/main.ts', ...args], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe('mmd check', () => {
  it('exits 1 and names the change when the premise is stale', async () => {
    const run = await mmd('check', 'the checkout worker retries three times, so a slow consumer is not the problem');
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('DRIFTED');
    expect(run.stdout).toContain('stated 3, actually 1');
    // The date and the reason are what makes this sayable to a human without
    // telling them they were wrong. Without them the agent can only correct.
    expect(run.stdout).toContain('changed 2026-08-23');
    expect(run.stdout).toMatch(/restated in \d+ earlier conversation/);
  }, 60_000);

  it('exits 0 and stays quiet when the premise holds', async () => {
    const run = await mmd('check', 'the events table stores the source IP, so we can trace it back');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('SUPPORTED');
  }, 60_000);

  it('exits 0 on a sentence that asserts nothing checkable', async () => {
    // An opinion is not a wrong belief. Anything other than 0 here would make
    // an agent announce a check it should never have mentioned.
    const run = await mmd('check', 'I think we should refactor the queue at some point');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('UNSUPPORTED');
  }, 60_000);

  it('resolves a pronoun subject from context rather than guessing', async () => {
    const bare = await mmd('check', 'it retries three times');
    expect(bare.code).toBe(0);
    expect(bare.stdout).toContain('UNSUPPORTED');

    const withContext = await mmd(
      'check',
      '--context',
      'we were looking at the checkout worker this morning',
      'it retries three times',
    );
    expect(withContext.code).toBe(1);
    expect(withContext.stdout).toContain('DRIFTED');
  }, 60_000);

  it('emits parseable JSON carrying the verdict and the evidence', async () => {
    const run = await mmd('check', '--json', 'the checkout service is still running 4.12 in production');
    expect(run.code).toBe(1);
    const parsed = JSON.parse(run.stdout) as { findings: { verdict: string; evidence: unknown[] }[] };
    expect(parsed.findings[0]!.verdict).toBe('DRIFTED');
    expect(parsed.findings[0]!.evidence.length).toBeGreaterThan(0);
  }, 60_000);
});

describe('mmd properties', () => {
  it('lists what the registry can settle, which bounds every other answer', async () => {
    const run = await mmd('properties');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('checkout-worker');
    expect(run.stdout).toContain('retry.max_attempts');
    // The skill instructs an agent to run this first and treat it as the limit
    // of what may be checked, so the boundary has to be stated in the output.
    expect(run.stdout).toContain('UNSUPPORTED');
  }, 60_000);
});
