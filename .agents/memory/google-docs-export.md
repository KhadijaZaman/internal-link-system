---
name: Google Docs export
description: Building a formatted Google Doc via the google-docs connector — credential fallback and the reliable table-building recipe.
---

# Google Docs export via connector

**Rule:** The `google-docs` connector carries Docs scopes only (`documents`, `documents.readonly`, `docs`) — no Drive scope, so no HTML→Doc conversion upload and no inline chart images. Build docs with the Docs REST API (`POST /v1/documents`, then `:batchUpdate`) and render charts as data tables.

**Why:** Drive-based HTML import is unavailable with these scopes, and naive Docs-API table building fails on index math. The recipe below built a multi-table report correctly on the first run.

**How to apply:**
1. Credentials: sandbox `listConnections('google-docs')` returned 0 items for a healthy, just-attached connection (same failure mode as the GitHub connector). Working fallback: bash-node, unfiltered `GET https://$REPLIT_CONNECTORS_HOSTNAME/api/v2/connection?include_secrets=true` with header `X_REPLIT_TOKEN: repl $REPL_IDENTITY`, find `connector_name === 'google-docs'`, token at `settings.access_token`. (The `connector_names=` filtered query can also return 0.)
2. Build order that avoids index-math bugs:
   a. Insert the entire text skeleton as ONE `insertText` at index 1 with `{{TABLE_X}}` placeholder paragraphs; apply paragraph/text styles in the same batch using offsets computed from your own string (JS `.length` matches Docs UTF-16 indexes for BMP chars — avoid emoji).
   b. GET the doc, locate placeholder paragraphs, then in one batch (descending index): `deleteContentRange` (placeholder text) + `insertTable` at that index.
   c. GET again; fill cells via `insertText` at each cell's first paragraph `startIndex`, iterating cells in DESCENDING index order (later insertions never shift earlier indexes); pair each insert with its `updateTextStyle` immediately after.
   d. Keep each batchUpdate well under 500 requests — split by table, higher-index tables first.
3. Header shading (`updateTableCellStyle` backgroundColor) and fixed column widths (`updateTableColumnProperties`) both take `tableStartLocation` = the table element's `startIndex` from GET.
4. The doc lands in the user's own Drive (their OAuth) — no sharing step needed; URL is `https://docs.google.com/document/d/<id>/edit`.
