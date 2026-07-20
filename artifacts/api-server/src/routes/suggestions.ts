import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, linkSuggestionsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { ActSuggestionBody, ListSuggestionsQueryParams } from "@workspace/api-zod";
import { buildWhyLine } from "../lib/semanticScorer";

const router: IRouter = Router();

function serialize(s: typeof linkSuggestionsTable.$inferSelect) {
  return {
    id: s.id,
    // Computed at read time from stored sub-scores; null for legacy rows
    // without sub-scores (the UI falls back to korayRationale).
    why: buildWhyLine(
      {
        similarity: s.similarityScore,
        authority: s.authorityScore,
        anchorFit: s.anchorFitScore,
        freshness: s.freshnessScore,
      },
      s.tierPair,
    ),
    donorUrl: s.donorUrl,
    receiverUrl: s.receiverUrl,
    anchorText: s.anchorText,
    korayRationale: s.korayRationale,
    sectionLinkType: s.sectionLinkType ?? "",
    insertionSentence: s.insertionSentence,
    priorityScore: s.priorityScore ?? 0,
    status: s.status,
    suggestedAt: (s.suggestedAt ?? new Date()).toISOString(),
    reviewedAt: s.reviewedAt?.toISOString() ?? null,
    engineVersion: s.engineVersion ?? "legacy-v0",
    tierPair: s.tierPair,
    similarityScore: s.similarityScore,
    authorityScore: s.authorityScore,
    anchorFitScore: s.anchorFitScore,
    freshnessScore: s.freshnessScore,
    anchorVariants: s.anchorVariants ?? [],
    placementHint: s.placementHint,
  };
}

router.get("/suggestions", requireAuth, async (req, res) => {
  const parsed = ListSuggestionsQueryParams.safeParse(req.query);
  const status = parsed.success ? parsed.data.status : undefined;
  const rows = await (status && status !== "all"
    ? db
        .select()
        .from(linkSuggestionsTable)
        .where(eq(linkSuggestionsTable.status, status))
        .orderBy(desc(linkSuggestionsTable.priorityScore))
    : db
        .select()
        .from(linkSuggestionsTable)
        .orderBy(desc(linkSuggestionsTable.priorityScore)));
  res.json(rows.map(serialize));
});

router.post("/suggestions/:id/action", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = ActSuggestionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid action" });
    return;
  }
  const map: Record<string, string> = {
    approve: "approved",
    reject: "rejected",
    inserted: "inserted",
  };
  const newStatus = map[parsed.data.action];
  if (!newStatus) {
    res.status(400).json({ error: "Invalid action" });
    return;
  }
  const updated = await db
    .update(linkSuggestionsTable)
    .set({ status: newStatus, reviewedAt: new Date() })
    .where(eq(linkSuggestionsTable.id, id))
    .returning();
  if (updated.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serialize(updated[0]!));
});

export default router;
