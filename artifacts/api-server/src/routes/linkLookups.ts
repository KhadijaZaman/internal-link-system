import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, linkLookupsTable, type LinkLookup } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { createAndRunLookups, type LookupInput } from "../services/linkLookups";

const router: IRouter = Router();

function serialize(s: LinkLookup) {
  return {
    id: s.id,
    kind: s.kind as "url" | "text",
    label: s.label,
    inputValue: s.inputValue,
    resolvedUrl: s.resolvedUrl,
    fetchedTitle: s.fetchedTitle,
    fetchedH1: s.fetchedH1,
    fetchedExcerpt: s.fetchedExcerpt,
    wordCount: s.wordCount,
    fetcherUsed: s.fetcherUsed,
    status: s.status as "pending" | "ready" | "failed",
    error: s.error,
    outboundResults: s.outboundResults ?? [],
    inboundResults: s.inboundResults ?? [],
    existingOutbound: s.existingOutbound ?? [],
    existingInbound: s.existingInbound ?? [],
    durationMs: s.durationMs,
    createdAt: (s.createdAt ?? new Date()).toISOString(),
    completedAt: s.completedAt?.toISOString() ?? null,
  };
}

router.get("/link-lookups", requireAuth, async (_req, res) => {
  // Project only the columns the list view needs — exclude the heavy
  // `embedding` vector and `fetchedBodyText` to keep list queries cheap.
  const rows = await db
    .select({
      id: linkLookupsTable.id,
      kind: linkLookupsTable.kind,
      label: linkLookupsTable.label,
      inputValue: linkLookupsTable.inputValue,
      resolvedUrl: linkLookupsTable.resolvedUrl,
      fetchedTitle: linkLookupsTable.fetchedTitle,
      fetchedH1: linkLookupsTable.fetchedH1,
      fetchedExcerpt: linkLookupsTable.fetchedExcerpt,
      wordCount: linkLookupsTable.wordCount,
      fetcherUsed: linkLookupsTable.fetcherUsed,
      status: linkLookupsTable.status,
      error: linkLookupsTable.error,
      outboundResults: linkLookupsTable.outboundResults,
      inboundResults: linkLookupsTable.inboundResults,
      existingOutbound: linkLookupsTable.existingOutbound,
      existingInbound: linkLookupsTable.existingInbound,
      durationMs: linkLookupsTable.durationMs,
      createdAt: linkLookupsTable.createdAt,
      completedAt: linkLookupsTable.completedAt,
    })
    .from(linkLookupsTable)
    .orderBy(desc(linkLookupsTable.createdAt))
    .limit(100);
  res.json(
    rows.map((r) =>
      serialize({
        ...r,
        embedding: null,
        fetchedBodyText: null,
      } as LinkLookup),
    ),
  );
});

router.get("/link-lookups/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const rows = await db.select().from(linkLookupsTable).where(eq(linkLookupsTable.id, id)).limit(1);
  if (rows.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serialize(rows[0]!));
});

router.delete("/link-lookups/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(linkLookupsTable).where(eq(linkLookupsTable.id, id));
  res.json({ ok: true });
});

router.post("/link-lookups", requireAuth, async (req, res) => {
  const body = req.body as { inputs?: unknown } | undefined;
  const raw = Array.isArray(body?.inputs) ? body.inputs : null;
  if (!raw || raw.length === 0) {
    res.status(400).json({ error: "inputs[] is required" });
    return;
  }
  if (raw.length > 50) {
    res.status(400).json({ error: "Maximum 50 inputs per request" });
    return;
  }
  const inputs: LookupInput[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") {
      res.status(400).json({ error: "Invalid input item" });
      return;
    }
    const item = r as { kind?: unknown; value?: unknown; label?: unknown };
    if (item.kind !== "url" && item.kind !== "text") {
      res.status(400).json({ error: "kind must be 'url' or 'text'" });
      return;
    }
    if (typeof item.value !== "string" || !item.value.trim()) {
      res.status(400).json({ error: "value must be a non-empty string" });
      return;
    }
    if (item.kind === "url") {
      try {
        const u = new URL(item.value.trim());
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          res.status(400).json({ error: `Invalid URL protocol: ${u.protocol}` });
          return;
        }
      } catch {
        res.status(400).json({ error: `Invalid URL: ${item.value}` });
        return;
      }
    }
    inputs.push({
      kind: item.kind,
      value: item.value.trim(),
      label: typeof item.label === "string" ? item.label : null,
    });
  }
  const ids = await createAndRunLookups(inputs);
  res.status(202).json({ ids });
});

export default router;
