import cron from 'node-cron';
import { config } from './config.js';
import { runSync } from './sync.js';

let running = false;

async function tick(): Promise<void> {
  if (running) return; // never overlap polls
  running = true;
  try {
    console.log(`[${new Date().toISOString()}] Syncing from Tally...`);
    await runSync();
  } catch (err) {
    console.error('Sync failed:', err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}

if (process.argv.includes('--once')) {
  tick().then(() => process.exit(0));
} else {
  console.log(`Tally sync agent started. Polling ${config.tallyUrl} on "${config.syncCron}"`);
  void tick();
  cron.schedule(config.syncCron, () => void tick());
}
