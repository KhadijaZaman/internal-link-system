import { actionItemsTable, appStateTable, db } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import type { SiteContext } from "../lib/site";
import { sheetsRequest } from "../integrations/googleSheets";

const BASE_KEY = "opportunities_sheet";
const TAB = "Opportunities";
const HEADERS = [
  "Site ID",
  "Action ID",
  "Version",
  "Category",
  "Opportunity",
  "Target URL",
  "Score",
  "Score Components",
  "Source Evidence",
  "Freshness",
  "Owner",
  "Status",
  "Due Date",
  "Market",
];
const EDITABLE_STATUSES = new Set(["open", "done", "dismissed"]);

type SheetValue = string | number | boolean;
interface SheetMeta {
  spreadsheetUrl?: string;
  sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
}
interface ValueRange {
  values?: SheetValue[][];
}

type SheetStateSuffix = "id" | "exported" | "imported" | "conflicts";

function key(siteId: number, suffix: SheetStateSuffix): string {
  return `${BASE_KEY}:${siteId}:${suffix}`;
}

async function readState(siteId: number, suffix: SheetStateSuffix) {
  const [row] = await db
    .select({ value: appStateTable.value })
    .from(appStateTable)
    .where(eq(appStateTable.key, key(siteId, suffix)))
    .limit(1);
  return row?.value ?? null;
}

async function writeState(siteId: number, suffix: SheetStateSuffix, value: string) {
  await db
    .insert(appStateTable)
    .values({ key: key(siteId, suffix), value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appStateTable.key,
      set: { value, updatedAt: new Date() },
    });
}

function parseSheetId(raw: string): string | null {
  const value = raw.trim();
  const id = value.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1] ?? value;
  return /^[A-Za-z0-9_-]{20,100}$/.test(id) ? id : null;
}

async function claimBinding(siteId: number, spreadsheetId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${BASE_KEY}:sheet:${spreadsheetId}`}))`);
    const ownKey = key(siteId, "id");
    const [own] = await tx
      .select({ value: appStateTable.value })
      .from(appStateTable)
      .where(eq(appStateTable.key, ownKey))
      .limit(1);
    if (own?.value && own.value !== spreadsheetId) {
      throw new Error("This site is already bound to another Opportunities workbook");
    }
    const isNew = !own?.value;
    const claims = await tx
      .select({ key: appStateTable.key })
      .from(appStateTable)
      .where(eq(appStateTable.value, spreadsheetId));
    if (claims.some((row) => row.key.startsWith(`${BASE_KEY}:`) && row.key.endsWith(":id") && row.key !== ownKey)) {
      throw new Error("This Opportunities workbook is already bound to another site");
    }
    await tx
      .insert(appStateTable)
      .values({ key: ownKey, value: spreadsheetId, updatedAt: new Date() })
      .onConflictDoUpdate({ target: appStateTable.key, set: { value: spreadsheetId, updatedAt: new Date() } });
    return isNew;
  });
}

async function releaseNewBinding(siteId: number, spreadsheetId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${BASE_KEY}:sheet:${spreadsheetId}`}))`);
    await tx
      .delete(appStateTable)
      .where(
        and(
          eq(appStateTable.key, key(siteId, "id")),
          eq(appStateTable.value, spreadsheetId),
        ),
      );
  });
}

export async function withOpportunitiesSheetLock<T>(
  siteId: number,
  operation: () => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${BASE_KEY}:refresh:${siteId}`}))`,
    );
    return operation();
  });
}

async function ensureTab(spreadsheetId: string): Promise<string> {
  const meta = await sheetsRequest<SheetMeta>(
    `/v4/spreadsheets/${spreadsheetId}?fields=spreadsheetUrl,sheets.properties(sheetId,title)`,
  );
  if (!(meta.sheets ?? []).some((sheet) => sheet.properties?.title === TAB)) {
    await sheetsRequest(`/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: { requests: [{ addSheet: { properties: { title: TAB, gridProperties: { rowCount: 1000, columnCount: HEADERS.length } } } }] },
    });
  }
  return meta.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

export async function replaceOpportunitySheetValues(
  spreadsheetId: string,
  values: SheetValue[][],
): Promise<void> {
  await sheetsRequest(
    `/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${TAB}'!A1`)}?valueInputOption=RAW`,
    { method: "PUT", body: { range: `'${TAB}'!A1`, majorDimension: "ROWS", values } },
  );
  // Write the complete replacement first. If that fails, the previous
  // governed export remains intact. Only then remove rows left over from a
  // larger prior export.
  await sheetsRequest(
    `/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${TAB}'!A${values.length + 1}:Z`)}:clear`,
    { method: "POST", body: {} },
  );
}

export async function getOpportunitiesSheetInfo(siteId: number) {
  const [id, lastExportedAt, lastImportedAt, rawConflicts] = await Promise.all([
    readState(siteId, "id"),
    readState(siteId, "exported"),
    readState(siteId, "imported"),
    readState(siteId, "conflicts"),
  ]);
  return {
    url: id ? `https://docs.google.com/spreadsheets/d/${id}/edit` : null,
    lastExportedAt,
    lastImportedAt,
    conflicts: parseStoredConflicts(rawConflicts),
  };
}

function parseStoredConflicts(raw: string | null): OpportunitiesSyncConflict[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is OpportunitiesSyncConflict => (
      typeof item === "object" &&
      item !== null &&
      Number.isInteger((item as OpportunitiesSyncConflict).rowNumber) &&
      typeof (item as OpportunitiesSyncConflict).actionId === "string" &&
      ["stale", "invalid"].includes((item as OpportunitiesSyncConflict).reason)
    ));
  } catch {
    return [];
  }
}

async function exportOpportunitiesSheetInner(
  site: SiteContext,
  supplied?: string,
  confirmConflictOverwrite = false,
) {
  const existingBinding = await readState(site.id, "id");
  const conflicts = parseStoredConflicts(await readState(site.id, "conflicts"));
  if (existingBinding && conflicts.length > 0 && !confirmConflictOverwrite) {
    throw new Error("Unresolved spreadsheet conflicts must be confirmed before refreshing the export");
  }
  let spreadsheetId = supplied ? parseSheetId(supplied) : existingBinding;
  if (supplied && !spreadsheetId) throw new Error("Invalid Google Sheets spreadsheet id or URL");
  if (supplied && existingBinding && existingBinding !== spreadsheetId) {
    throw new Error("This site is already bound to another Opportunities workbook");
  }
  if (!spreadsheetId) {
    const created = await sheetsRequest<{ spreadsheetId?: string; spreadsheetUrl?: string }>(
      "/v4/spreadsheets",
      {
        method: "POST",
        body: {
          properties: { title: `${site.displayName} — Opportunities` },
          sheets: [{ properties: { title: TAB, gridProperties: { rowCount: 1000, columnCount: HEADERS.length } } }],
        },
      },
    );
    if (!created.spreadsheetId) throw new Error("Google Sheets did not return a spreadsheet id");
    spreadsheetId = created.spreadsheetId;
  }
  // Validate connector access before making a durable first-time binding.
  await sheetsRequest(`/v4/spreadsheets/${spreadsheetId}?fields=spreadsheetId`);
  let isNewBinding = false;
  try {
    isNewBinding = await claimBinding(site.id, spreadsheetId);
    const url = await ensureTab(spreadsheetId);
    const rows = await db
      .select()
      .from(actionItemsTable)
      .where(eq(actionItemsTable.siteId, site.id))
      .orderBy(sql`${actionItemsTable.score} desc`);
    const values: SheetValue[][] = [
      HEADERS,
      ...rows.map((row) => [
        site.id,
        row.id,
        row.version,
        row.category,
        row.title ?? row.description ?? row.actionType,
        row.targetUrl,
        row.score,
        JSON.stringify(row.scoreComponents ?? {}),
        JSON.stringify(row.sourceRecords ?? []),
        row.freshness,
        row.owner ?? "",
        row.status,
        row.dueDate ?? "",
        row.market,
      ]),
    ];
    await replaceOpportunitySheetValues(spreadsheetId, values);
    const exportedAt = new Date().toISOString();
    await Promise.all([
      writeState(site.id, "exported", exportedAt),
      writeState(site.id, "conflicts", "[]"),
    ]);
    return { url, rowCount: rows.length, exportedAt };
  } catch (error) {
    if (isNewBinding) await releaseNewBinding(site.id, spreadsheetId);
    throw error;
  }
}

export async function exportOpportunitiesSheet(
  site: SiteContext,
  supplied?: string,
  confirmConflictOverwrite = false,
) {
  return withOpportunitiesSheetLock(site.id, () =>
    exportOpportunitiesSheetInner(site, supplied, confirmConflictOverwrite),
  );
}

export interface ParsedReview {
  id: number;
  expectedVersion: number;
  rowNumber?: number;
  status?: "open" | "done" | "dismissed";
  owner?: string | null;
  dueDate?: string | null;
  market?: string;
}

export interface OpportunitiesSyncConflict {
  rowNumber: number;
  actionId: string;
  reason: "stale" | "invalid";
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Pure validation helper used by the importer and focused unit tests. */
export function parseOpportunitySheetRows(values: SheetValue[][], siteId: number): {
  valid: ParsedReview[];
  conflicts: OpportunitiesSyncConflict[];
} {
  const headers = (values[0] ?? []).map(String);
  const at = (name: string) => headers.indexOf(name);
  if (["Site ID", "Action ID", "Version", "Owner", "Status", "Due Date", "Market"].some((name) => at(name) < 0)) {
    throw new Error("The Opportunities sheet headers were changed");
  }
  const valid: ParsedReview[] = [];
  const conflicts: OpportunitiesSyncConflict[] = [];
  for (const [index, row] of values.slice(1).entries()) {
    if (row.every((cell) => String(cell ?? "").trim() === "")) continue;
    const rowNumber = index + 2;
    const actionId = String(row[at("Action ID")] ?? "").trim();
    const rowSite = Number(row[at("Site ID")]);
    const id = Number(actionId);
    const expectedVersion = Number(row[at("Version")]);
    const status = String(row[at("Status")] ?? "").trim();
    const ownerRaw = String(row[at("Owner")] ?? "").trim();
    const dueRaw = String(row[at("Due Date")] ?? "").trim();
    const market = String(row[at("Market")] ?? "").trim();
    if (
      rowSite !== siteId ||
      !Number.isInteger(id) ||
      id <= 0 ||
      !Number.isInteger(expectedVersion) ||
      expectedVersion <= 0 ||
      !EDITABLE_STATUSES.has(status) ||
      (dueRaw !== "" && !validCalendarDate(dueRaw)) ||
      !market ||
      ownerRaw.length > 200 ||
      market.length > 100
    ) {
      conflicts.push({ rowNumber, actionId, reason: "invalid" });
      continue;
    }
    valid.push({
      id,
      expectedVersion,
      rowNumber,
      status: status as ParsedReview["status"],
      owner: ownerRaw || null,
      dueDate: dueRaw || null,
      market,
    });
  }
  return { valid, conflicts };
}

async function applyActionReviewsWithConflicts(
  siteId: number,
  reviews: ParsedReview[],
  invalidConflicts: OpportunitiesSyncConflict[] = [],
) {
  let updated = 0;
  const conflicts = [...invalidConflicts];
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${BASE_KEY}:site:${siteId}`}))`);
    for (const review of reviews) {
      const [current] = await tx
        .select({
          version: actionItemsTable.version,
          status: actionItemsTable.status,
          owner: actionItemsTable.owner,
          dueDate: actionItemsTable.dueDate,
          market: actionItemsTable.market,
        })
        .from(actionItemsTable)
        .where(and(eq(actionItemsTable.siteId, siteId), eq(actionItemsTable.id, review.id)))
        .limit(1);
      if (!current || current.version !== review.expectedVersion) {
        conflicts.push({
          rowNumber: review.rowNumber ?? 2,
          actionId: String(review.id),
          reason: "stale",
        });
        continue;
      }
      const nextStatus = review.status ?? current.status;
      const nextOwner = review.owner === undefined ? current.owner : review.owner;
      const nextDueDate = review.dueDate === undefined ? current.dueDate : review.dueDate;
      const nextMarket = review.market ?? current.market;
      if (
        current.status === nextStatus &&
        current.owner === nextOwner &&
        current.dueDate === nextDueDate &&
        current.market === nextMarket
      ) {
        continue;
      }
      const now = new Date();
      const statusChanged = current.status !== nextStatus;
      const timestamps = !statusChanged
        ? {}
        : nextStatus === "done"
          ? { completedAt: now, dismissedAt: null, resolution: "manual" }
          : nextStatus === "dismissed"
            ? { dismissedAt: now, completedAt: null, resolution: "manual" }
            : { completedAt: null, dismissedAt: null, resolution: null };
      const changed = await tx
        .update(actionItemsTable)
        .set({
          status: nextStatus,
          owner: nextOwner,
          dueDate: nextDueDate,
          market: nextMarket,
          ...(statusChanged ? { pinnedOpen: nextStatus === "open" } : {}),
          ...timestamps,
          version: sql`${actionItemsTable.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(actionItemsTable.siteId, siteId),
            eq(actionItemsTable.id, review.id),
            eq(actionItemsTable.version, review.expectedVersion),
          ),
        )
        .returning({ id: actionItemsTable.id });
      if (changed.length) updated++;
      else {
        conflicts.push({
          rowNumber: review.rowNumber ?? 2,
          actionId: String(review.id),
          reason: "stale",
        });
      }
    }
  });
  return {
    updated,
    stale: conflicts.filter((conflict) => conflict.reason === "stale").length,
    invalid: conflicts.filter((conflict) => conflict.reason === "invalid").length,
    conflicts,
  };
}

export async function applyActionReviews(siteId: number, reviews: ParsedReview[]) {
  const { updated, stale, invalid } = await applyActionReviewsWithConflicts(siteId, reviews);
  return { updated, stale, invalid };
}

async function syncOpportunitiesSheetInner(siteId: number) {
  const spreadsheetId = await readState(siteId, "id");
  if (!spreadsheetId) return null;
  const data = await sheetsRequest<ValueRange>(
    `/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${TAB}'!A:Z`)}`,
  );
  const parsed = parseOpportunitySheetRows(data.values ?? [], siteId);
  const result = await applyActionReviewsWithConflicts(siteId, parsed.valid, parsed.conflicts);
  const importedAt = new Date().toISOString();
  await Promise.all([
    writeState(siteId, "imported", importedAt),
    writeState(siteId, "conflicts", JSON.stringify(result.conflicts)),
  ]);
  return { ...result, importedAt };
}

export async function syncOpportunitiesSheet(siteId: number) {
  return withOpportunitiesSheetLock(siteId, () =>
    syncOpportunitiesSheetInner(siteId),
  );
}