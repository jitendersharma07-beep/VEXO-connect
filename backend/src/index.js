import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { startWorker } from './lib/integrations/worker.js';

const app = createApp();

app.listen(env.PORT, env.HOST, () => {
  logger.info(`VEXO Connect API listening on ${env.HOST}:${env.PORT}`);
});

// Here and not in createApp(), so a test that builds an app does not acquire a
// background timer that outlives the case and claims jobs out from under it.
// Returns null unless POS_INTEGRATION_WORKER_INTERVAL_MS is set, which is the
// shipped default — a deployment with no integration polls nothing.
startWorker();
