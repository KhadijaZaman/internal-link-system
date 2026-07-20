import { db, jobRunsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { withDbRetry } from "../lib/dbRetry";

export type JobName =
  | "crawl_link_map"
  | "gsc_inventory_and_losers"
  | "optimize_queued_urls"
  | "crawl_wordpress"
  | "reembed_wordpress"
  | "semantic_linking"
  | "audit_orphans"
  | "audit_over_linked"
  | "audit_broken_links"
  | "run_full_pipeline"
  | "recompute_action_queue"
  | "weekly_digest"
  | "keyword_clustering";

export const ALL_JOBS: JobName[] = [
  "crawl_link_map",
  "gsc_inventory_and_losers",
  "optimize_queued_urls",
  "crawl_wordpress",
  "reembed_wordpress",
  "semantic_linking",
  "audit_orphans",
  "audit_over_linked",
  "audit_broken_links",
  "run_full_pipeline",
  "recompute_action_queue",
  "weekly_digest",
  "keyword_clustering",
];

type JobFn = () => Promise<void>;

const registry: Partial<Record<JobName, JobFn>> = {};
const running = new Set<JobName>();

// While a job is running we (a) heartbeat its DB row so other instances /
// future boots can tell it's alive, and (b) self-ping the public URL in
// deployments so the autoscale instance isn't recycled for lack of traffic
// mid-job. A DB row stuck at "running" with a stale heartbeat means the
// process was killed mid-run — loadJobStatuses reports it as "interrupted".
const HEARTBEAT_MS = 60_000;
const STALE_RUNNING_MS = 3 * 60_000;
const INTERRUPTED_MESSAGE =
  "The server restarted while this job was running — long jobs can be cut short when the hosting instance recycles (common on Autoscale once the dashboard stops polling). Progress up to the interruption was saved; run the job again to finish.";

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function ensureHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    void heartbeatTick();
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();
}

async function heartbeatTick(): Promise<void> {
  if (running.size === 0) {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    return;
  }
  for (const name of running) {
    try {
      await withDbRetry(
        () =>
          db
            .update(jobRunsTable)
            .set({ lastRunAt: new Date() })
            .where(and(eq(jobRunsTable.name, name), eq(jobRunsTable.lastStatus, "running"))),
        { label: `job_heartbeat:${name}` },
      );
    } catch (e) {
      logger.warn({ err: e, jobName: name }, "Job heartbeat update failed");
    }
  }
  await selfPing();
}

/**
 * In deployments, fetch our own public health endpoint while a job runs.
 * Autoscale keeps instances alive based on incoming traffic; a long background
 * job generates none, so without this the instance can be recycled mid-run.
 * Best-effort mitigation — a Reserved VM deployment is the guaranteed fix.
 */
async function selfPing(): Promise<void> {
  if (!process.env["REPLIT_DEPLOYMENT"]) return;
  const domain = process.env["REPLIT_DOMAINS"]?.split(",")[0];
  if (!domain) return;
  try {
    await fetch(`https://${domain}/api/healthz`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    logger.warn({ err: e }, "Job keep-alive self-ping failed");
  }
}

async function recordJobStart(name: JobName): Promise<void> {
  const values = {
    lastRunAt: new Date(),
    lastStatus: "running",
    lastDurationMs: null,
    lastError: null,
  };
  try {
    await withDbRetry(
      () =>
        db
          .insert(jobRunsTable)
          .values({ name, ...values })
          .onConflictDoUpdate({ target: jobRunsTable.name, set: values }),
      { label: `record_job_start:${name}` },
    );
  } catch (e) {
    logger.warn({ err: e, jobName: name }, "Failed to record job start");
  }
}

export function registerJob(name: JobName, fn: JobFn): void {
  registry[name] = fn;
}

export function isRunning(name: JobName): boolean {
  return running.has(name);
}

export async function runJob(name: JobName): Promise<
  { started: true } | { started: false; reason: string }
> {
  // Hardening: only allow names from the static `ALL_JOBS` allow-list. Without
  // this, a value like "toString" or "constructor" would walk the prototype
  // chain on the plain-object registry and return a function we never meant
  // to expose. TypeScript's `JobName` is erased at runtime, so this is a real
  // (defence-in-depth) check, not a redundancy.
  if (!ALL_JOBS.includes(name as JobName)) {
    return { started: false, reason: `Unknown job ${name}` };
  }
  const fn = Object.prototype.hasOwnProperty.call(registry, name)
    ? registry[name]
    : undefined;
  if (!fn) return { started: false, reason: `Unknown job ${name}` };
  if (running.has(name)) return { started: false, reason: "Already running" };
  running.add(name);
  const startedAt = Date.now();
  (async () => {
    let status = "ok";
    let err: string | null = null;
    try {
      await recordJobStart(name);
      ensureHeartbeat();
      await fn();
    } catch (e) {
      status = "error";
      err = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
      logger.error({ jobName: name, err: e }, "Job failed");
    } finally {
      const duration = Date.now() - startedAt;
      try {
        const finalValues = {
          lastRunAt: new Date(),
          lastStatus: status,
          lastDurationMs: duration,
          lastError: err,
        };
        await withDbRetry(
          () =>
            db
              .insert(jobRunsTable)
              .values({ name, ...finalValues })
              .onConflictDoUpdate({ target: jobRunsTable.name, set: finalValues }),
          { label: `record_job_run:${name}` },
        );
      } catch (e) {
        logger.error({ err: e }, "Failed to record job run");
      }
      running.delete(name);
      logger.info({ jobName: name, status, durationMs: duration }, "Job complete");
    }
  })();
  return { started: true };
}

export async function loadJobStatuses(): Promise<
  Array<{
    name: string;
    running: boolean;
    lastRunAt: Date | null;
    lastStatus: string | null;
    lastDurationMs: number | null;
    lastError: string | null;
  }>
> {
  const rows = await db.select().from(jobRunsTable);
  const map = new Map(rows.map((r) => [r.name, r]));
  const now = Date.now();
  const statuses = [];
  for (const name of ALL_JOBS) {
    const r = map.get(name);
    let isRunningNow = running.has(name);
    let lastStatus = r?.lastStatus ?? null;
    let lastError = r?.lastError ?? null;
    if (!isRunningNow && lastStatus === "running") {
      const heartbeatAge = r?.lastRunAt ? now - r.lastRunAt.getTime() : Infinity;
      if (heartbeatAge < STALE_RUNNING_MS) {
        // Fresh heartbeat from another instance — treat as still running.
        isRunningNow = true;
      } else {
        // Stale "running" row: the process died mid-job. Surface + persist.
        lastStatus = "interrupted";
        lastError = INTERRUPTED_MESSAGE;
        try {
          await db
            .update(jobRunsTable)
            .set({ lastStatus: "interrupted", lastError: INTERRUPTED_MESSAGE })
            .where(and(eq(jobRunsTable.name, name), eq(jobRunsTable.lastStatus, "running")));
        } catch (e) {
          logger.warn({ err: e, jobName: name }, "Failed to persist interrupted job status");
        }
      }
    }
    statuses.push({
      name,
      running: isRunningNow,
      lastRunAt: r?.lastRunAt ?? null,
      lastStatus,
      lastDurationMs: r?.lastDurationMs ?? null,
      lastError,
    });
  }
  return statuses;
}

export async function lastRunAt(name: JobName): Promise<Date | null> {
  const r = await db.select().from(jobRunsTable).where(eq(jobRunsTable.name, name)).limit(1);
  return r[0]?.lastRunAt ?? null;
}
