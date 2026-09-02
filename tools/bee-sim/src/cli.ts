import { BeeSim } from './server.ts';

const port = Number(process.env.BEE_SIM_PORT ?? 8787);
const live = (process.env.BEE_SIM_LIVE ?? '10743,10744').split(',').map((s) => s.trim()).filter(Boolean);

const sim = new BeeSim({ port, liveConversationIds: live });

const listening = await sim.listen();
console.log(`bee-sim listening on http://127.0.0.1:${listening}`);
console.log(`  BEE_PROXY_URL=http://127.0.0.1:${listening}`);
console.log(`  live conversations held back until /_sim/play: ${live.join(', ') || 'none'}`);

const shutdown = () => {
  void sim.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
