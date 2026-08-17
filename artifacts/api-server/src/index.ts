import app from "./app";
import { logger } from "./lib/logger";
import { resyncSerialSequences } from "./lib/sequenceResync";
import { setupJobs, startScheduler, runDailyCatchUp, recoverStaleCompetitorScans } from "./jobs/scheduler";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// One-time admin bootstrap: if no platform admin exists yet, promote the
// owner of the legacy site (id 1). Idempotent — runs on every boot, does
// nothing once an admin exists. Never throws (startup must not be blocked).
async function bootstrapAdmin(): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE users SET is_admin = true
      WHERE id = (SELECT owner_user_id FROM sites WHERE id = 1)
        AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = true)
    `);
  } catch (err) {
    logger.warn({ err }, "Admin bootstrap failed (will retry next boot)");
  }
}

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
void resyncSerialSequences().then(async () => {
  await bootstrapAdmin();
  setupJobs();
  startScheduler();
  // If the server was asleep when a daily cron should have fired (dev
  // workspace, autoscale recycle), run overdue daily jobs now instead of
  // waiting for tomorrow's slot. runDailyCatchUp never throws.
  void runDailyCatchUp();
  // Recover any competitor scans that were left queued or running when the
  // server last restarted. Safe to call at any time — no-ops when nothing is stuck.
  void recoverStaleCompetitorScans();
});

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
