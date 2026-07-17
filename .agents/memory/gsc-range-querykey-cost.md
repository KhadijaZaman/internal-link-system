---
name: GSC range context drives query keys
description: Why inputs bound to the GSC range context must be debounced before committing.
---

# GSC range context is part of the React Query keys

The dashboard's GSC range context (`components/gsc/range-context.tsx`: dates,
`compare`, `urlFilter`) is spread into the query keys of every GSC hook
(overview, queries, pages, etc.). Changing any field refetches ALL GSC queries.

## Rule: never bind a free-text/rapid input directly to `setRange`

Any text input or fast-changing control wired to the range context must commit
deliberately — debounce (~500ms) and/or commit on blur/Enter — never on every
`onChange`.

**Why:** The URL filter once committed on each keystroke, so typing a URL fired
a full refetch of every GSC query per character against Google Search Console,
which is a quota-limited, cost-sensitive API. Cost/quota avoidance is a core
concern of this app.

**How to apply:** When adding a new GSC filter control, keep its value in local
state and push it into the range context on a debounce or explicit commit, not
directly. Date pickers and the compare toggle are fine to commit immediately
(discrete, low-frequency changes).
