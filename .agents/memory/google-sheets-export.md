---
name: Google Sheets export
description: How to create/write Google Sheets for this project, and the connector's status history.
---

# Google Sheets export

The Google Sheets connector (`google-sheet`) is **authorized and healthy**. The user dismissed
the connection prompt early on (so for a while the standing instruction was "deliver as .xlsx,
don't re-propose"), but they later **explicitly asked to create a Google Sheet**, completed the
OAuth, and it now works.

**Why this matters:** do not treat Google Sheets as off-limits. The old "never re-propose" note is
stale. Only fall back to `.xlsx` if `listConnections('google-sheet')` returns nothing / 401, or the
user asks for a file.

**Preferred path (in-app):** the api-server now has a server-side Sheets client —
`artifacts/api-server/src/integrations/googleSheets.ts` wraps `@replit/connectors-sdk`'s
`connectors.proxy("google-sheet", path)`, which handles identity + token refresh in both dev and
deployments (`REPL_IDENTITY` → `WEB_REPL_RENEWAL` fallback). Reuse it for any new server-side
sheet work instead of re-deriving the raw credential-proxy approach. The "Target Keyword Daily
Movement" workbook is PERSISTENT: its spreadsheet id is stored in `app_state`
(`keyword_movement_sheet_id`) and every export / daily `sync_keyword_sheet` job run rewrites the
SAME sheet — never create per-run snapshot spreadsheets for it again (that was a user complaint).

**In-place tab replacement pattern (Sheets v4):** one atomic `:batchUpdate` — rename all old tabs
to `__old_<sheetId>` (avoids title collisions), `addSheet` the new tabs with fresh sheetIds
(max old id + 1..n) and sized grids, `deleteSheet` the old ids, `updateSpreadsheetProperties`
title. Add-before-delete keeps the doc from ever having zero sheets. Only fall back to creating a
new spreadsheet on 403/404 of the stored id (deleted from Drive) — rethrow other errors or a
transient failure spawns duplicates.

**How to create/write a sheet (one-off from the sandbox, no app wiring or npm install):**
- In the `code_execution` sandbox: `const c = (await listConnections('google-sheet'))[0]`.
- Token: `c.settings.access_token` (also at `c.settings.oauth.credentials.access_token`). Fetch it
  fresh each run; never cache or print it.
- Call the Sheets v4 REST API with `fetch` + `Authorization: Bearer <token>`:
  - `POST /v4/spreadsheets` with `{properties:{title}, sheets:[{properties:{sheetId,title,gridProperties:{rowCount,columnCount,frozenRowCount}}}]}` → returns `spreadsheetId` + `spreadsheetUrl`.
  - `POST /v4/spreadsheets/{id}/values:batchUpdate` with `{valueInputOption:'RAW', data:[{range:"'Tab Name'!A1", values:[[...]]}]}`. Quote tab names with spaces/special chars in single quotes.
  - `POST /v4/spreadsheets/{id}:batchUpdate` for formatting (repeatCell bold header, autoResizeDimensions).
- Set `gridProperties.rowCount`/`columnCount` big enough for the data up front (tabs default to 1000 rows).
- **Gotcha — writing beyond the grid 400s:** writing/formatting a cell outside the tab's current `rowCount`/`columnCount` fails with `400 "Range ... exceeds grid limits. Max rows: N, max columns: M"`. Tabs created with a tight `columnCount` (e.g. 9) won't accept a new column J. First expand via `:batchUpdate` `updateSheetProperties` `{gridProperties:{columnCount:N}}` (fields `gridProperties.columnCount`), then write values + formatting.
- The sheet is created in the connected user's Drive; they own it. The returned URL carries an
  account-specific `ouid` param — hand the user the clean `/edit` URL.

**Gotcha — the persistent sheet id can silently rotate:** the export treats any `failed (403|404)`
on the stored spreadsheet id as "deleted from Drive" and creates a REPLACEMENT spreadsheet, storing
the new id. A transient 403 (e.g. token hiccup) therefore orphans the user's bookmarked sheet: prod
keeps updating the new copy while the old link goes stale. When the user reports "my sheet isn't
updating", first compare their link's spreadsheet id against `app_state.keyword_movement_sheet_id`
(check PROD, not dev — prod runs the daily cron).

**Recovery when `listConnections('google-sheet')` returns 0 but the connection exists:**
- The sandbox binding can go stale even while `searchIntegrations` shows the connection as `added`
  and the platform reports it healthy. `addIntegration` alone does NOT fix it (it returns
  `success:false, connectionAlreadyAdded:true` and listConnections stays empty) — the platform-side
  re-bind (proposeIntegration flow) is what restores it.
- Even after re-bind, the sandbox `listConnections` may still return 0. Working fallback: from
  **bash node**, hit the credential proxy directly:
  `https://$REPLIT_CONNECTORS_HOSTNAME/api/v2/connection?include_secrets=true` with header
  `X_REPLIT_TOKEN: "repl " + $REPL_IDENTITY`, then pick the item whose `connector_name` is
  `google-sheet` and use `settings.access_token`.
- **Gotcha:** adding `&connector_names=google-sheet` to that URL returns 0 items even when the
  connection is healthy — fetch unfiltered and filter client-side.
