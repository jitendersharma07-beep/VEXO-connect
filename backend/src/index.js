import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
// ==== LANE inventory ====
import { startInventoryScheduler } from './jobs/inventoryScheduler.js';
// ==== END LANE inventory ====
import { startWorker } from './lib/integrations/worker.js';

const app = createApp();

app.listen(env.PORT, env.HOST, () => {
  logger.info(`VEXO Connect API listening on ${env.HOST}:${env.PORT}`);
});

// ==== LANE inventory ====
// Opt-in, and off unless asked for. Two API processes behind a load balancer
// would otherwise both tick; the job's lease makes that safe, but a deployment
// should still be explicit about which process is meant to be running it.
//
// It is started HERE and not in createApp() so that importing the app — which
// every test file does — never starts a timer. A suite whose results depend on
// whether a background pass happened to land mid-assertion is a suite that
// fails for reasons nobody can reproduce.
if (process.env.INVENTORY_SCHEDULER === 'on') {
  startInventoryScheduler({
    intervalMs: Number(process.env.INVENTORY_SCHEDULER_INTERVAL_MS || 60000),
  });
}
// ==== END LANE inventory ====
// Here and not in createApp(), so a test that builds an app does not acquire a
// background timer that outlives the case and claims jobs out from under it.
// Returns null unless POS_INTEGRATION_WORKER_INTERVAL_MS is set, which is the
// shipped default — a deployment with no integration polls nothing.
startWorker();
