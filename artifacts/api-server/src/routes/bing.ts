import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import {
  db,
  pagesTable,
  aiCitationUploadsTable,
  aiCitationRowsTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { UploadAiCitationsBody } from "@workspace/api-zod";
import { csvToObjects } from "../lib/csvParse";
import { canonicalPath, isBlockedPath, loadBlockRegexes } from "../lib/urlCanon";
import { applyAiCitationRollup } from "../jobs/syncBingPages";

const router: IRouter = Router();

// ---------- Header detection (Bing changes export columns without notice) ----------

// Normalized-header candidates, checked in order. First hit wins.
const URL_HEADERS = ["page url", "url", "page", "cited page", "cited url", "landing page"];
const QUERY_HEADERS = [
  "grounding query",
  "grounding queries",
  "query",
  "queries",
  "key phrase",
  "keyphrase",
  "search query",
  "prompt",
];
const CITATION_HEADERS = [
  "total citations",
  "citations",
  "citation count",
  "citation",
  "appearances",
  "count",
];

function pickHeader(keys: string[], candidates: string[]): string | null {
  for (const c of candidates) {
    if (keys.includes(c)) return c;
  }
  // Fuzzy pass: any header containing the candidate as a word sequence.
  for (const c of candidates) {
    const hit = keys.find((k) => k.includes(c));
    if (hit) return hit;
  }
  return null;
}

function parseCount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/[,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function serializeUpload(u: {
  id: number;
  label: string;
  kind: string;
  rowCount: number;
  unmatchedCount: number;
  uploadedAt: Date | null;
}) {
  return {
    id: u.id,
    label: u.label,
    kind: u.kind,
    rowCount: u.rowCount,
    unmatchedCount: u.unmatchedCount,
    uploadedAt: u.uploadedAt?.toISOString() ?? new Date(0).toISOString(),
  };
}

// ---------- Upload a Bing AI Performance export ----------

router.post("/bing/ai-citations/uploads", requireAuth, async (req, res) => {
  const parsed = UploadAiCitationsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const { rawHeaders, rows } = csvToObjects(parsed.data.content);
  if (rawHeaders.length === 0 || rows.length === 0) {
    res.status(400).json({
      error: "The file is empty or has no data rows below the header.",
      detectedHeaders: rawHeaders,
    });
    return;
  }
  const keys = Object.keys(rows[0] ?? {});
  const urlCol = pickHeader(keys, URL_HEADERS);
  const queryCol = pickHeader(keys, QUERY_HEADERS);
  const citationCol = pickHeader(keys, CITATION_HEADERS);
  // A URL column wins: the pages export also includes query-ish columns in
  // some layouts, but a grounding-queries export never includes page URLs.
  const kind = urlCol ? "pages" : queryCol ? "grounding_queries" : null;
  if (!kind) {
    res.status(400).json({
      error:
        "Could not recognize this file: no URL/page column and no query column found. " +
        "Expected a Bing AI Performance export (page citations or grounding queries).",
      detectedHeaders: rawHeaders,
    });
    return;
  }

  const warnings: string[] = [];
  if (!citationCol) {
    warnings.push("No citations column found — each row was counted as 1 citation.");
  }
  const knownCols = new Set([urlCol, queryCol, citationCol].filter(Boolean) as string[]);
  const blockRegexes = await loadBlockRegexes();

  let unmatched = 0;
  let matchedPages = 0;
  let totalCitations = 0;
  const inserts: Array<{
    path: string | null;
    url: string | null;
    query: string | null;
    citations: number;
    extra: Record<string, string> | null;
  }> = [];
  for (const row of rows) {
    const citations = parseCount(citationCol ? row[citationCol] : undefined) ?? 1;
    const extraEntries = Object.entries(row).filter(
      ([k, v]) => !knownCols.has(k) && v !== "",
    );
    const extra = extraEntries.length > 0 ? Object.fromEntries(extraEntries) : null;
    if (kind === "pages") {
      const url = (row[urlCol as string] ?? "").trim();
      if (!url) continue;
      let path = canonicalPath(url);
      if (path !== null && isBlockedPath(path, blockRegexes)) path = null;
      if (path === null) unmatched++;
      else matchedPages++;
      totalCitations += citations;
      inserts.push({ path, url, query: queryCol ? row[queryCol] || null : null, citations, extra });
    } else {
      const query = (row[queryCol as string] ?? "").trim();
      if (!query) continue;
      totalCitations += citations;
      inserts.push({ path: null, url: null, query, citations, extra });
    }
  }
  if (inserts.length === 0) {
    res.status(400).json({
      error: "No usable rows found in the file.",
      detectedHeaders: rawHeaders,
    });
    return;
  }
  if (kind === "pages" && unmatched > 0) {
    warnings.push(
      `${unmatched} row(s) had URLs that don't map to this site (foreign host, blocklisted, or unparseable).`,
    );
  }

  const label =
    parsed.data.label?.trim() ||
    `${kind === "pages" ? "Page citations" : "Grounding queries"} — ${new Date().toISOString().slice(0, 10)}`;

  const upload = await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(aiCitationUploadsTable)
      .values({
        label,
        kind,
        rowCount: inserts.length,
        unmatchedCount: unmatched,
        rawHeaders,
      })
      .returning();
    if (!u) throw new Error("Failed to insert upload");
    const CHUNK = 500;
    for (let i = 0; i < inserts.length; i += CHUNK) {
      await tx
        .insert(aiCitationRowsTable)
        .values(inserts.slice(i, i + CHUNK).map((r) => ({ ...r, uploadId: u.id })));
    }
    return u;
  });

  if (kind === "pages") {
    const rollup = await applyAiCitationRollup(upload.id);
    req.log.info(
      { uploadId: upload.id, rows: inserts.length, ...rollup },
      "AI citation upload applied to pages rollup",
    );
  } else {
    req.log.info(
      { uploadId: upload.id, rows: inserts.length },
      "Grounding-queries upload stored",
    );
  }

  res.status(201).json({
    upload: serializeUpload(upload),
    matchedPages,
    totalCitations,
    warnings,
  });
});

router.get("/bing/ai-citations/uploads", requireAuth, async (_req, res) => {
  const uploads = await db
    .select()
    .from(aiCitationUploadsTable)
    .orderBy(desc(aiCitationUploadsTable.id))
    .limit(20);
  res.json(uploads.map(serializeUpload));
});

// ---------- Per-page mapping report ----------

router.get("/bing/pages", requireAuth, async (_req, res) => {
  const [pages, blockRegexes, [latestPagesUpload]] = await Promise.all([
    db
      .select({
        path: pagesTable.path,
        title: pagesTable.title,
        section: pagesTable.section,
        gscClicks: pagesTable.clicks,
        gscImpressions: pagesTable.impressions,
        gscPosition: pagesTable.position,
        bingClicks: pagesTable.bingClicks,
        bingImpressions: pagesTable.bingImpressions,
        bingPosition: pagesTable.bingPosition,
        aiCitations: pagesTable.aiCitations,
        aiSessions: pagesTable.aiSessions,
        bingSyncedAt: pagesTable.bingSyncedAt,
        aiCitationsAt: pagesTable.aiCitationsAt,
      })
      .from(pagesTable)
      .where(
        sql`coalesce(${pagesTable.clicks}, 0) > 0
          OR coalesce(${pagesTable.impressions}, 0) > 0
          OR coalesce(${pagesTable.bingClicks}, 0) > 0
          OR coalesce(${pagesTable.bingImpressions}, 0) > 0
          OR coalesce(${pagesTable.aiCitations}, 0) > 0
          OR coalesce(${pagesTable.aiSessions}, 0) > 0`,
      ),
    loadBlockRegexes(),
    db
      .select()
      .from(aiCitationUploadsTable)
      .where(eq(aiCitationUploadsTable.kind, "pages"))
      .orderBy(desc(aiCitationUploadsTable.id))
      .limit(1),
  ]);

  const visible = pages.filter((p) => !isBlockedPath(p.path, blockRegexes));
  visible.sort(
    (a, b) =>
      (b.aiCitations ?? 0) - (a.aiCitations ?? 0) ||
      (b.bingClicks ?? 0) - (a.bingClicks ?? 0) ||
      (b.gscClicks ?? 0) - (a.gscClicks ?? 0),
  );

  const totals = { gscClicks: 0, bingClicks: 0, aiCitations: 0, aiSessions: 0 };
  let bingSyncedAt: Date | null = null;
  let aiCitationsAt: Date | null = null;
  for (const p of visible) {
    totals.gscClicks += p.gscClicks ?? 0;
    totals.bingClicks += p.bingClicks ?? 0;
    totals.aiCitations += p.aiCitations ?? 0;
    totals.aiSessions += p.aiSessions ?? 0;
    if (p.bingSyncedAt && (!bingSyncedAt || p.bingSyncedAt > bingSyncedAt)) {
      bingSyncedAt = p.bingSyncedAt;
    }
    if (p.aiCitationsAt && (!aiCitationsAt || p.aiCitationsAt > aiCitationsAt)) {
      aiCitationsAt = p.aiCitationsAt;
    }
  }

  res.json({
    rows: visible.map((p) => ({
      path: p.path,
      title: p.title,
      section: p.section,
      gscClicks: p.gscClicks,
      gscImpressions: p.gscImpressions,
      gscPosition: p.gscPosition,
      bingClicks: p.bingClicks,
      bingImpressions: p.bingImpressions,
      bingPosition: p.bingPosition,
      aiCitations: p.aiCitations,
      aiSessions: p.aiSessions,
    })),
    bingSyncedAt: bingSyncedAt?.toISOString() ?? null,
    aiCitationsAt: aiCitationsAt?.toISOString() ?? null,
    latestUpload: latestPagesUpload ? serializeUpload(latestPagesUpload) : null,
    totals,
  });
});

export default router;
