---
name: Tracked submissions checklist
description: The "My Submissions" page model and the cost rule for manually tracked URLs.
---

# Tracked submissions / "My Submissions"

The "My Submissions" page is a unified, day-grouped timeline that merges THREE
sources into one `SubmissionItem` list: Suggest Links lookups (`link_lookups`),
Optimizer queue items (`optimize_queue`), and user-curated tracked URLs
(`tracked_submissions`).

## Rule: tracked URLs are a manual checklist only — never process them

`tracked_submissions` is a plain CRUD checklist. Adding/listing/marking-done/
deleting a tracked URL must NEVER fetch the page, crawl, or call an AI model.

**Why:** The operator explicitly asked for a no-cost tracking list after
declining to run their URLs through Suggest Links or the Optimizer (both incur
paid HTTP fetch + Anthropic spend). Wiring tracked URLs into those pipelines
would silently reintroduce the cost they rejected.

**How to apply:** If asked to "process", "enrich", "score", or "auto-suggest"
for tracked URLs, confirm intent first — it crosses the cost boundary. Keep the
tracked-submissions route free of fetch/crawl/A/I calls.

## Other durable choices

- Still-open tracked items (status `tracking`) are exempt from the page's
  day-window filter so the checklist never silently hides open items; everything
  else respects the selected window.
- POST is batch (`urls: string[]`) and enforces http(s)-only URLs (mirrors the
  `link-lookups` protocol check) because the UI renders each URL as a clickable
  `<a href>`.
