import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import { withCache } from "../integrations/gsc";
import {
  computeAuthoritySnapshot,
  DEFAULT_CORE_THRESHOLD,
} from "../services/authoritySnapshot";

const router: IRouter = Router();

const SNAPSHOT_TTL_MS = 30 * 60 * 1000;

router.get("/snapshot", requireAuth, requireSite, async (req, res) => {
  const site = getSite(req);
  let threshold = DEFAULT_CORE_THRESHOLD;
  const raw = req.query["threshold"];
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      res.status(400).json({ error: "threshold must be a number between 0 and 1" });
      return;
    }
    threshold = n;
  }
  try {
    const data = await withCache(
      `s${site.id}|authority-snapshot:v2|${threshold}`,
      SNAPSHOT_TTL_MS,
      () => computeAuthoritySnapshot(site.id, threshold),
    );
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Authority snapshot failed");
    res.status(502).json({ error: "Failed to build authority snapshot" });
  }
});

export default router;
