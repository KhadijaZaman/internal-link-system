/**
 * Persistent Google Sheets export for the Link Map.
 *
 * The spreadsheet id is stored in app_state (key: link_map_sheet_id:<siteId>)
 * and the same spreadsheet is updated in-place on every export.
 *
 * In-place update strategy — preserves user-added tabs:
 *   - Only the "Link Map" tab is touched.
 *   - If the tab exists: clear its contents, expand the grid if needed, write
 *     the new data, and reformat the header.
 *   - If the tab is missing: add it, write, format.
 *   - All other tabs in the spreadsheet are left untouched.
 *
 * Placement filter:
 *   - content links are always included.
 *   - nav links included when showNav = true.
 *   - footer links included when showFooter = true.
 *   This mirrors the placement toggles on the Table view so the sheet matches
 *   exactly what the user sees on screen.
 */

import { db, linkGraphTable, appStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sheetsRequest, shareSheetWithAnyone } from "../integrations/googleSheets";

// ─── App-state helpers ────────────────────────────────────────────────────────

const BASE_KEY = "link_map_sheet_id";

function sheetStateKey(siteId: number): string {
  return `${BASE_KEY}:${siteId}`;
}

function sharedStateKey(siteId: number): string {
  return `${sheetStateKey(siteId)}:shared`;
}

function syncedAtStateKey(siteId: number): string {
  return `${BASE_KEY}:${siteId}:synced_at`;
}

async function storeLinkMapSheetSyncedAt(siteId: number, at: Date): Promise<void> {
  await db
    .insert(appStateTable)
    .values({ key: syncedAtStateKey(siteId), value: at.toISOString(), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appStateTable.key,
      set: { value: at.toISOString(), updatedAt: new Date() },
    });
}

/**
 * ISO timestamp of the last time exportLinkMapSheet completed a successful
 * write for this site, or null if no export has ever succeeded.
 */
export async function getStoredLinkMapSheetSyncedAt(siteId: number): Promise<string | null> {
  const [row] = await db
    .select()
    .from(appStateTable)
    .where(eq(appStateTable.key, syncedAtStateKey(siteId)))
    .limit(1);
  return row?.value ?? null;
}

async function loadStoredSheetId(siteId: number): Promise<string | null> {
  const [row] = await db
    .select()
    .from(appStateTable)
    .where(eq(appStateTable.key, sheetStateKey(siteId)))
    .limit(1);
  return row?.value ?? null;
}

async function storeSheetId(id: string, siteId: number): Promise<void> {
  await db
    .insert(appStateTable)
    .values({ key: sheetStateKey(siteId), value: id, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appStateTable.key,
      set: { value: id, updatedAt: new Date() },
    });
}

async function loadSharedSheetId(siteId: number): Promise<string | null> {
  const [row] = await db
    .select()
    .from(appStateTable)
    .where(eq(appStateTable.key, sharedStateKey(siteId)))
    .limit(1);
  return row?.value ?? null;
}

async function storeSharedSheetId(id: string, siteId: number): Promise<void> {
  await db
    .insert(appStateTable)
    .values({ key: sharedStateKey(siteId), value: id, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appStateTable.key,
      set: { value: id, updatedAt: new Date() },
    });
}

/**
 * URL of the site's persistent link-map sheet, or null when no export has
 * created one yet. Pure DB read — no Sheets API call.
 */
export async function getStoredLinkMapSheetUrl(siteId: number): Promise<string | null> {
  const id = await loadStoredSheetId(siteId);
  return id ? `https://docs.google.com/spreadsheets/d/${id}/edit` : null;
}

/** Whether the stored link-map sheet is known to be link-viewable. */
export async function isLinkMapSheetShared(siteId: number): Promise<boolean> {
  const [sheetId, sharedId] = await Promise.all([
    loadStoredSheetId(siteId),
    loadSharedSheetId(siteId),
  ]);
  return sheetId != null && sheetId === sharedId;
}

/** Best-effort: make the sheet readable by anyone with the link. Never throws. */
async function ensureSheetShared(
  spreadsheetId: string,
  siteId: number,
): Promise<boolean> {
  const alreadyShared = await loadSharedSheetId(siteId);
  if (alreadyShared === spreadsheetId) return true;
  const ok = await shareSheetWithAnyone(spreadsheetId);
  if (ok) await storeSharedSheetId(spreadsheetId, siteId);
  return ok;
}

// ─── Sheets API helpers ───────────────────────────────────────────────────────

interface SheetProperties {
  sheetId?: number;
  title?: string;
  gridProperties?: { rowCount?: number; columnCount?: number };
}

interface SpreadsheetMeta {
  spreadsheetUrl?: string;
  sheets?: Array<{ properties?: SheetProperties }>;
}

/**
 * Fetch spreadsheet metadata. Returns null on 403/404 (deleted/unshared);
 * rethrows everything else so a transient error never silently spawns a
 * duplicate spreadsheet.
 */
async function fetchSpreadsheetMeta(id: string): Promise<SpreadsheetMeta | null> {
  try {
    return await sheetsRequest<SpreadsheetMeta>(
      `/v4/spreadsheets/${id}?fields=spreadsheetUrl,sheets.properties(sheetId,title,gridProperties)`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/failed \((403|404)\)/.test(msg)) return null;
    throw e;
  }
}

const TAB_TITLE = "Link Map";
const HEADERS = ["Source", "Destination", "Position", "Links", "Anchor text"];

const POSITION_LABEL: Record<string, string> = {
  content: "In-content",
  nav: "Navigation",
  header: "Header",
  footer: "Footer",
  sidebar: "Sidebar",
};

// ─── Main export ─────────────────────────────────────────────────────────────

export interface LinkMapSheetOptions {
  showNav?: boolean;
  showFooter?: boolean;
}

export async function exportLinkMapSheet(
  site: { id: number; displayName: string; host: string },
  options: LinkMapSheetOptions = {},
): Promise<{ url: string; title: string; rowCount: number; sheetShared: boolean }> {
  const { id: siteId } = site;
  const { showNav = false, showFooter = false } = options;
  const sheetTitle = `Link Map — ${site.displayName || site.host}`;

  // 1. Load all edges for this site.
  const allEdges = await db
    .select({
      sourceUrl: linkGraphTable.sourceUrl,
      targetUrl: linkGraphTable.targetUrl,
      placement: linkGraphTable.placement,
      anchorText: linkGraphTable.anchorText,
    })
    .from(linkGraphTable)
    .where(eq(linkGraphTable.siteId, siteId));

  // 2. Apply placement filter (mirrors the Table view toggles).
  const allowedPlacements = new Set(["content"]);
  if (showNav) { allowedPlacements.add("nav"); allowedPlacements.add("header"); }
  if (showFooter) allowedPlacements.add("footer");

  const edges = allEdges.filter((e) => allowedPlacements.has(e.placement));

  if (edges.length === 0) {
    throw new NoLinkDataError();
  }

  // 3. Aggregate: (source, target, placement) → { links, anchors }
  const rowMap = new Map<
    string,
    { source: string; target: string; position: string; links: number; anchors: Set<string> }
  >();
  for (const e of edges) {
    const key = `${e.sourceUrl}\x00${e.targetUrl}\x00${e.placement}`;
    let row = rowMap.get(key);
    if (!row) {
      row = {
        source: e.sourceUrl,
        target: e.targetUrl,
        position: e.placement,
        links: 0,
        anchors: new Set(),
      };
      rowMap.set(key, row);
    }
    row.links++;
    if (e.anchorText) row.anchors.add(e.anchorText);
  }

  const dataRows = Array.from(rowMap.values()).map((r) => [
    r.source,
    r.target,
    POSITION_LABEL[r.position] ?? r.position,
    r.links,
    [...r.anchors].join(" · ") || "",
  ]);

  const neededRows = 1 + dataRows.length; // header + data
  const columnCount = HEADERS.length;

  // 4. Resolve the spreadsheet (reuse or create).
  const storedId = await loadStoredSheetId(siteId);
  let spreadsheetId: string;

  if (storedId) {
    const meta = await fetchSpreadsheetMeta(storedId);
    if (meta) {
      // Reuse the existing spreadsheet — only touch the "Link Map" tab.
      spreadsheetId = storedId;
      const existingTab = (meta.sheets ?? []).find(
        (s) => s.properties?.title === TAB_TITLE,
      );

      if (existingTab?.properties?.sheetId != null) {
        const tabSheetId = existingTab.properties.sheetId;
        const currentRows = existingTab.properties.gridProperties?.rowCount ?? 0;
        const currentCols = existingTab.properties.gridProperties?.columnCount ?? 0;

        const batchRequests: unknown[] = [];

        // Expand grid if the new data exceeds the current size.
        if (currentRows < neededRows || currentCols < columnCount) {
          batchRequests.push({
            updateSheetProperties: {
              properties: {
                sheetId: tabSheetId,
                gridProperties: {
                  rowCount: Math.max(currentRows, neededRows + 10),
                  columnCount: Math.max(currentCols, columnCount),
                },
              },
              fields: "gridProperties.rowCount,gridProperties.columnCount",
            },
          });
        }

        if (batchRequests.length > 0) {
          await sheetsRequest(`/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
            method: "POST",
            body: { requests: batchRequests },
          });
        }

        // Clear the existing data range before writing fresh data.
        await sheetsRequest(
          `/v4/spreadsheets/${spreadsheetId}/values/'${TAB_TITLE}'!A1:${columnLetter(columnCount)}${Math.max(currentRows, neededRows)}:clear`,
          { method: "POST", body: {} },
        );
      } else {
        // Tab is missing from this spreadsheet — add it.
        const existingSheetIds = (meta.sheets ?? []).map(
          (s) => s.properties?.sheetId ?? 0,
        );
        const newSheetId = Math.max(0, ...existingSheetIds) + 1;
        await sheetsRequest(`/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
          method: "POST",
          body: {
            requests: [
              {
                addSheet: {
                  properties: {
                    sheetId: newSheetId,
                    title: TAB_TITLE,
                    gridProperties: {
                      rowCount: Math.max(neededRows + 10, 100),
                      columnCount,
                      frozenRowCount: 1,
                    },
                  },
                },
              },
            ],
          },
        });
      }
    } else {
      // 403/404 — spreadsheet deleted; create a fresh one.
      spreadsheetId = "";
    }
  }

  if (!spreadsheetId!) {
    // Create a brand-new spreadsheet with only the "Link Map" tab.
    const created = await sheetsRequest<{ spreadsheetId: string; spreadsheetUrl?: string }>(
      "/v4/spreadsheets",
      {
        method: "POST",
        body: {
          properties: { title: sheetTitle },
          sheets: [
            {
              properties: {
                sheetId: 1,
                title: TAB_TITLE,
                gridProperties: {
                  rowCount: Math.max(neededRows + 10, 100),
                  columnCount,
                  frozenRowCount: 1,
                },
              },
            },
          ],
        },
      },
    );
    spreadsheetId = created.spreadsheetId;
  }

  // Persist the (new or unchanged) spreadsheet ID.
  await storeSheetId(spreadsheetId, siteId);

  // 5. Write header + data rows in chunks to stay within the Sheets API
  //    10 MB per-request payload limit.  Each chunk targets an explicit A1
  //    range so rows land in the right place even when a previous chunk
  //    wrote fewer cells than expected.
  const WRITE_CHUNK_SIZE = 1000; // rows per API call (≈ safe payload size)
  const allRows: unknown[][] = [HEADERS, ...dataRows];

  for (let start = 0; start < allRows.length; start += WRITE_CHUNK_SIZE) {
    const chunk = allRows.slice(start, start + WRITE_CHUNK_SIZE);
    const startRow = start + 1; // 1-based row index
    const endRow = startRow + chunk.length - 1;
    const range = `'${TAB_TITLE}'!A${startRow}:${columnLetter(columnCount)}${endRow}`;
    await sheetsRequest(`/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
      method: "POST",
      body: {
        valueInputOption: "RAW",
        data: [{ range, values: chunk }],
      },
    });
  }

  // 6. Bold the header and auto-resize columns.
  // Need the current sheetId of the tab we just wrote.
  const metaAfter = await sheetsRequest<SpreadsheetMeta>(
    `/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(sheetId,title)`,
  );
  const tabSheet = (metaAfter.sheets ?? []).find(
    (s) => s.properties?.title === TAB_TITLE,
  );
  if (tabSheet?.properties?.sheetId != null) {
    const tabSheetId = tabSheet.properties.sheetId;
    await sheetsRequest(`/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId: tabSheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: columnCount,
              },
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: "userEnteredFormat.textFormat.bold",
            },
          },
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId: tabSheetId,
                dimension: "COLUMNS",
                startIndex: 0,
                endIndex: columnCount,
              },
            },
          },
        ],
      },
    });
  }

  // 7. Best-effort share (anyone with the link can view).
  const sheetShared = await ensureSheetShared(spreadsheetId, siteId);

  // 8. Record the successful write time. This is only reached when the sheet
  //    was actually written — failed or skipped runs never get here.
  await storeLinkMapSheetSyncedAt(siteId, new Date());

  const cleanUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  return { url: cleanUrl, title: sheetTitle, rowCount: dataRows.length, sheetShared };
}

/** Convert a 1-based column number to a column letter (1→A, 5→E). */
function columnLetter(n: number): string {
  let result = "";
  while (n > 0) {
    result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

export class NoLinkDataError extends Error {
  constructor() {
    super("No link graph data found for this site");
  }
}
