import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import { ALL_JOBS, loadJobStatuses, runJob, type JobName } from "../jobs/runner";

const router: IRouter = Router();

// Manual job triggers are per-site: any user may run jobs for a site they
// own (requireSite verifies ownership of the X-Site-Id site). Spend is
// bounded by the site's per-run guardrails (maxCrawlPages,
// maxLlmCallsPerRun, maxSerpQueriesPerRun) enforced inside each job.
router.post("/jobs/:jobName/run", requireAuth, requireSite, async (req, res) => {
  const name = req.params.jobName as JobName;
  if (!ALL_JOBS.includes(name)) {
    res.status(400).json({ jobName: name, started: false, message: "Unknown job" });
    return;
  }
  const site = getSite(req);
  const result = await runJob(name, site);
  if (result.started) {
    res.status(202).json({ jobName: name, started: true, message: "Job started" });
  } else {
    res.status(409).json({ jobName: name, started: false, message: result.reason });
  }
});

router.get("/jobs/status", requireAuth, requireSite, async (req, res) => {
  const rows = await loadJobStatuses(getSite(req).id);
  res.json(
    rows.map((r) => ({
      name: r.name,
      running: r.running,
      lastRunAt: r.lastRunAt?.toISOString() ?? null,
      lastStatus: r.lastStatus,
      lastDurationMs: r.lastDurationMs,
      lastError: r.lastError,
    })),
  );
});

export default router;
