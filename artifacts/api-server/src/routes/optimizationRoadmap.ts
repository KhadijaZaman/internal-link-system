import { Router, type IRouter } from "express";
import { requireAdmin, requireAuth } from "../lib/auth";
import { getSite, requireAdminSite, requireSite } from "../lib/site";
import {
  getOptimizationRoadmapSheetInfo,
  refreshOptimizationRoadmapSheet,
} from "../services/optimizationRoadmapSheet";

const router: IRouter = Router();

router.get(
  "/optimization-roadmap/sheet-info",
  requireAuth,
  requireSite,
  async (req, res) => {
    const site = getSite(req);
    res.json(await getOptimizationRoadmapSheetInfo(site.id));
  },
);

router.post(
  "/optimization-roadmap/refresh-sheet",
  requireAuth,
  requireAdmin,
  requireAdminSite,
  async (req, res) => {
    const site = getSite(req);
    const body = (req.body ?? {}) as { spreadsheetId?: unknown; tabTitle?: unknown };
    if (
      body.spreadsheetId !== undefined &&
      typeof body.spreadsheetId !== "string"
    ) {
      res.status(400).json({ error: "spreadsheetId must be a Google Sheets URL or id" });
      return;
    }
    if (body.tabTitle !== undefined && typeof body.tabTitle !== "string") {
      res.status(400).json({ error: "tabTitle must be a string" });
      return;
    }
    try {
      const result = await refreshOptimizationRoadmapSheet(site, {
        spreadsheetId: body.spreadsheetId,
        tabTitle: body.tabTitle,
      });
      if (result.skipped) {
        res.status(409).json({
          error:
            "No roadmap workbook is bound. Send spreadsheetId once to bind the existing sheet.",
          code: "roadmap_sheet_not_configured",
        });
        return;
      }
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      req.log.error({ err: error, siteId: site.id }, "optimization roadmap refresh failed");
      if (
        /Invalid Google Sheets|No roadmap tab found|must contain a Path or URL column|already bound to another|already running/.test(
          message,
        )
      ) {
        res.status(400).json({ error: message });
        return;
      }
      res.status(502).json({ error: "Optimization roadmap refresh failed" });
    }
  },
);

export default router;
