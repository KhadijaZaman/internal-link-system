import app from "./app";
import { logger } from "./lib/logger";
import { resyncSerialSequences } from "./lib/sequenceResync";
import { setupJobs, startScheduler } from "./jobs/scheduler";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Realign serial sequences before any job can INSERT (the publish-time DB
// copy can leave sequences behind their tables, breaking all inserts).
// resyncSerialSequences never throws, so jobs always start.
void resyncSerialSequences().then(() => {
  setupJobs();
  startScheduler();
});

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
