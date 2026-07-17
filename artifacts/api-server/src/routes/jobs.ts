import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import { ALL_JOBS, loadJobStatuses, runJob, type JobName } from "../jobs/runner";

const router: IRouter = Router();

router.post("/jobs/:jobName/run", requireAuth, async (req, res) => {
  const name = req.params.jobName as JobName;
  if (!ALL_JOBS.includes(name)) {
    res.status(400).json({ jobName: name, started: false, message: "Unknown job" });
    return;
  }
  const result = await runJob(name);
  if (result.started) {
    res.status(202).json({ jobName: name, started: true, message: "Job started" });
  } else {
    res.status(409).json({ jobName: name, started: false, message: result.reason });
  }
});

router.get("/jobs/status", requireAuth, async (_req, res) => {
  const rows = await loadJobStatuses();
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
