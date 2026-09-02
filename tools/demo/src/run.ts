/**
 * The whole demo, in one command.
 *
 *   pnpm demo
 *
 * Starts the Bee emulator and the server in this process, plays the 09:02
 * conversation into the live stream one sentence at a time, cuts the stream to
 * provoke Bee's documented at-most-once loss, lets cursor reconciliation
 * recover it, and then leaves everything running with the dashboard on
 * http://127.0.0.1:4310 so the result can be clicked through.
 *
 * Every step prints what it is doing and, more importantly, what the product
 * decided and why -- including the sentences it deliberately ignored, which are
 * most of them.
 *
 * With a real device this is the same run: `bee proxy` instead of the emulator,
 * BEE_PROXY_URL pointed at it, and no --sim.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';


const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
/**
 * tsx's own entry point, run by this Node.
 *
 * Not `npx tsx`: on Windows that is a `.cmd` shim, which `spawn` will only run
 * with `shell: true`, which in turn makes Node 22 print a DEP0190 warning into
 * the middle of the demo. Spawning node directly is faster too.
 */
const TSX = resolve(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SIM_PORT = Number(process.env.BEE_SIM_PORT ?? 8787);
const PORT = Number(process.env.PORT ?? 4310);
const SPEED = Number(process.env.MMD_DEMO_SPEED ?? 1400);
const children: ChildProcess[] = [];
/**
 * `pnpm demo --tour` brings the same stack up and then stops, leaving the
 * dashboard's guided tour (`/?tour=1`) to play the conversations and cut the
 * stream itself. It is the same run either way; the only question is whether
 * this file or the browser is holding the remote control.
 */
const TOUR = process.argv.includes('--tour');

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function beat(title: string): void {
  console.log(`\n${c.bold(`── ${title} ${'─'.repeat(Math.max(0, 66 - title.length))}`)}`);
}

async function sh(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((res, rej) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('close', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
  });
}

function background(name: string, args: string[], env: Record<string, string>, onLine?: (line: string) => void): ChildProcess {
  const child = spawn(process.execPath, [TSX, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const pipe = (stream: NodeJS.ReadableStream) => {
    let buffer = '';
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.trim() || /DeprecationWarning|--trace-deprecation/.test(line)) continue;
        if (onLine) onLine(line);
        else console.log(c.dim(`  [${name}] ${line}`));
      }
    });
  };
  pipe(child.stdout!);
  pipe(child.stderr!);
  return child;
}

async function waitFor(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`${url} did not come up`);
    await sleep(300);
  }
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function refuseIfInUse(port: number, what: string): Promise<void> {
  const { createServer } = await import('node:net');
  const free = await new Promise<boolean>((res) => {
    const probe = createServer();
    probe.once('error', () => res(false));
    probe.once('listening', () => probe.close(() => res(true)));
    probe.listen(port, '127.0.0.1');
  });
  if (!free) {
    throw new Error(
      `port ${port} is already in use, so the ${what} could not start. ` +
        'Stop whatever is on it (an earlier `pnpm demo` leaves both ports bound) and run again.',
    );
  }
}

async function main(): Promise<void> {
  console.log(c.bold('\nMental Model Drift'));
  console.log(c.dim('We monitor configuration drift, infrastructure drift and schema drift.'));
  console.log(c.dim("This monitors the one system nobody instruments: the engineer's understanding.\n"));

  beat('setup');
  if (!existsSync(join(ROOT, 'demo', 'checkout-demo', '.git'))) {
    console.log('  seeding the demo repository with backdated commits');
    await sh('npx', ['tsx', 'tools/demo/seed-repo.ts', '--force']);
  }
  if (!existsSync(join(ROOT, 'apps', 'dashboard', 'dist', 'index.html'))) {
    console.log('  building the dashboard');
    await sh('npx', ['vite', 'build', '--config', 'apps/dashboard/vite.config.ts']);
  }
  // Dedupe keys persist, so a second run would legitimately produce nothing.
  await rm(join(ROOT, '.state'), { recursive: true, force: true });
  console.log('  cleared .state (the content-key dedupe would otherwise skip a repeat run)');

  // A simulator left running from an earlier demo would be silently reused,
  // serving whatever fixtures it loaded then. That is a confusing half-hour.
  await refuseIfInUse(SIM_PORT, 'bee emulator');
  await refuseIfInUse(PORT, 'server');

  background('bee-sim', ['tools/bee-sim/src/cli.ts'], { BEE_SIM_PORT: String(SIM_PORT), BEE_SIM_LIVE: '10743,10744' });
  await waitFor(`http://127.0.0.1:${SIM_PORT}/v1/me`);
  console.log(`  bee emulator on :${SIM_PORT}  ${c.dim('(the documented /v1 surface: stream, changes, search, facts)')}`);

  background(
    'server',
    ['apps/server/src/main.ts'],
    {
      BEE_PROXY_URL: `http://127.0.0.1:${SIM_PORT}`,
      BEE_ALLOW_CLI: '0',
      MMD_STREAM: '1',
      MMD_MODE: 'local',
      PORT: String(PORT),
      ...(TOUR ? { MMD_TOUR: '1' } : {}),
    },
    (line) => {
      if (/bee stream (connected|lost)/.test(line)) console.log(c.dim(`  [server] ${line.trim()}`));
    },
  );
  await waitFor(`http://127.0.0.1:${PORT}/api/status`);
  console.log(`  server on :${PORT}, subscribed to the realtime stream`);
  console.log(`  dashboard ${c.blue(`http://127.0.0.1:${PORT}`)}`);

  if (TOUR) {
    console.log(`\n  guided tour  ${c.blue(`http://127.0.0.1:${PORT}/?tour=1`)}`);
    console.log(c.dim('  the browser drives the conversations, the stream cut and the reconnect.'));
    console.log(c.dim('\n  ctrl-c to stop everything.\n'));
    return;
  }

  beat('09:02 — the conversation, as Bee hears it');
  console.log(c.dim('  eight sentences. Half of them the product will not have an opinion about.\n'));
  await post(`http://127.0.0.1:${SIM_PORT}/_sim/play`, { conversationId: '10743', speedMs: SPEED });
  await sleep(2500);
  await report();

  beat('11:40 — the stream drops, and a conversation happens anyway');
  console.log(c.dim("  Bee documents realtime delivery as at-most-once: what happens while you are"));
  console.log(c.dim('  disconnected is not replayed. So the stream is the fast path, not the record.\n'));
  await post(`http://127.0.0.1:${SIM_PORT}/_sim/network`, { up: false });
  console.log(`  ${c.red('stream cut')}`);
  await sleep(1200);
  await post(`http://127.0.0.1:${SIM_PORT}/_sim/play`, { conversationId: '10744', speedMs: 400 });
  console.log(c.dim('  the corridor conversation is recorded by Bee with nobody listening'));
  await sleep(1200);
  await post(`http://127.0.0.1:${SIM_PORT}/_sim/network`, { up: true });
  console.log(`  ${c.green('stream restored')} — the client treats every drop as a gap and reconciles immediately`);
  await sleep(4000);
  await report();

  beat('what is left running');
  console.log(`  dashboard   ${c.blue(`http://127.0.0.1:${PORT}`)}`);
  console.log(`  api         ${c.dim(`http://127.0.0.1:${PORT}/api/drifts`)}`);
  console.log(`  emulator    ${c.dim(`http://127.0.0.1:${SIM_PORT}/_sim/state`)}`);
  console.log(c.dim('\n  ctrl-c to stop everything.\n'));
}

/** Print the current cards, and the metrics that show what stayed silent. */
async function report(): Promise<void> {
  const [drifts, claims, status] = await Promise.all([
    fetch(`http://127.0.0.1:${PORT}/api/drifts`).then((r) => r.json() as Promise<DriftCard[]>),
    fetch(`http://127.0.0.1:${PORT}/api/claims`).then((r) => r.json() as Promise<ClaimRow[]>),
    fetch(`http://127.0.0.1:${PORT}/api/status`).then((r) => r.json() as Promise<{ metrics: Record<string, number> }>),
  ]);

  const supported = claims.filter((c2) => c2.claim.status === 'SUPPORTED');
  for (const card of drifts.filter((d) => d.drift.resolution === 'OPEN')) {
    const d = card.drift;
    const colour = d.severity === 'HIGH' ? c.red : d.severity === 'MEDIUM' ? c.yellow : c.dim;
    console.log(`\n  ${colour(d.severity.padEnd(6))} ${c.bold(card.label)}`);
    console.log(`         said ${fmt(d.assertedValue)}, actually ${fmt(d.actualValue)}`);
    if (d.sourceChangeAt) {
      console.log(`         changed ${d.sourceChangeAt.slice(0, 10)}${d.sourceChangeCommit ? ` in ${d.sourceChangeCommit.slice(0, 7)}` : ''}`);
    }
    for (const o of d.priorOccurrences) {
      console.log(`         ${o.at.slice(0, 10)} ${o.afterSourceChange ? c.red('after the change ') : c.dim('correct then   ')} ${c.dim(trim(o.excerpt))}`);
    }
    for (const e of card.evidence.filter((x) => x.authoritative)) {
      console.log(c.dim(`         evidence: ${e.source} ${e.status} ${e.sourceLocator}`));
    }
  }

  if (supported.length) {
    console.log(`\n  ${c.green('silent')} ${supported.length} claim(s) agreed with their source and produced no card:`);
    for (const s of supported) console.log(c.dim(`         ${trim(s.claim.originalText)}`));
  }

  const m = status.metrics;
  console.log(
    `\n  ${c.dim(
      `heard ${m.BeeEventsReceived ?? 0} · reconciled ${m.BeeEventsReconciled ?? 0} · deduplicated ${m.BeeEventsDeduplicated ?? 0} · ` +
        `claims ${m.ClaimsDetected ?? 0} · drifted ${m.DriftsDetected ?? 0} · supported ${m.ClaimsSupported ?? 0}`,
    )}`,
  );
}

interface DriftCard {
  label: string;
  evidence: { source: string; status: string; sourceLocator: string; authoritative: boolean }[];
  drift: {
    severity: string;
    assertedValue: unknown;
    actualValue: unknown;
    sourceChangeAt?: string;
    sourceChangeCommit?: string;
    resolution: string;
    priorOccurrences: { at: string; excerpt: string; afterSourceChange: boolean }[];
  };
}
interface ClaimRow {
  claim: { status: string; originalText: string };
}

function fmt(v: unknown): string {
  return typeof v === 'boolean' ? (v ? 'enabled' : 'disabled') : String(v);
}
function trim(s: string, n = 72): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function shutdown(): void {
  for (const child of children) child.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await main().catch((err: Error) => {
  console.error(c.red(`\ndemo failed: ${err.message}`));
  shutdown();
});
