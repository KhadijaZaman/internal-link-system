---
name: Audit payload passthrough & operator-facing exports
description: Where untrusted external strings reach the operator, and which layer must sanitize them.
---

# Audit report payload is an unvalidated passthrough

Audit reports store a generic JSON `payload` array, and the audits route returns it to the
dashboard **without Zod validation / codegen typing**. Adding a new field to an audit item
(e.g. broken-links `redirectTo`) needs **no OpenAPI/codegen/contract change** — just add it on
the producer side and render it.

**Why:** the route trusts the job's output shape. That speed comes with a security cost: there
is no schema gate between an external response and the operator's browser.

**How to apply:** sanitize at the **producing job**, not the route. Concretely, when a value
comes from an external HTTP response (headers, body) and will become a clickable href or be
shown verbatim, validate it before storing — e.g. broken-links only stores a redirect `Location`
when the parsed URL is `http:`/`https:` (blocks `javascript:` etc.), and drops unparseable input
rather than storing the raw string.

# Operator-facing spreadsheet/clipboard exports must be formula-safe

The dashboard's shared copy affordance (`rowsToTsv` in `lib/clipboard.ts`, used by
`CopyButton`) intentionally **formula-escapes** any cell starting with `= + - @` by prefixing a
single quote. The whole point of the export is "paste into Excel/Sheets", and some columns
(notably GSC query strings) are externally influenceable.

**Why:** without it, a searched query like `=HYPERLINK(...)` becomes a live formula on paste —
classic CSV/TSV injection.

**How to apply:** never hand-roll TSV/clipboard output for a new table; reuse `rowsToTsv` +
`CopyButton` so the escaping is automatic. Copy the **rendered/filtered slice**, not the raw
fetch, so "copy" matches what the operator sees.

# Inbound counts and "pages to edit" measure different things

A broken/redirect target's `inboundCount` comes from link_stats, which counts **content-placement
links only**. The list of source pages to edit (broken-links `linkingPages`) deliberately includes
**all placements** (content + nav/footer/chrome). So a target linked solely from chrome reports
`inboundCount: 0` yet still has real pages to fix.

**Why:** ranking broken-link work by `inboundCount` alone buries chrome-only breakage at the
bottom even though it's genuine work, defeating the "prioritize by impact" goal.

**How to apply:** when sorting audit issues by impact, rank by the actual work to do —
`max(inboundCount, linkingPages.length)` — not by `inboundCount` alone. Keep showing the raw
inbound number (it's a defined, meaningful metric), but don't let it drive ordering by itself.
