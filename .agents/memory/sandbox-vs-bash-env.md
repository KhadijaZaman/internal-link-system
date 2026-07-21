---
name: Sandbox vs bash env access
description: Where project secrets (process.env) are and aren't available, and how to bridge the two.
---

# code_execution sandbox vs bash: secret access

- The `code_execution` JS notebook sandbox does **not** expose project secrets via `process.env` — `process.env` is effectively undefined there (by design, to keep secrets out of the notebook). Connector credentials come via `listConnections()` instead.
- **bash-run Node scripts DO** see secrets as `process.env` (e.g. `GSC_*`, `GA4_*`, `OPENAI_API_KEY`).

**Bridge pattern** when one job needs both a secret AND a connector (e.g. pull GA4/GSC with a service-account secret, then write to Google Sheets via the `google-sheet` connector):
1. Do the secret-using part in a bash Node script (`/tmp/*.mjs`), write results to `/tmp/<name>.json`.
2. In `code_execution`, read that `/tmp` file (filesystem is shared) and do the connector write there.

**Why:** secrets are deliberately withheld from the sandbox; don't try `process.env` there, and don't try to read connector tokens from bash.

**Also applies to the Playwright testing subagent:** `runTest()` cannot read env vars either — a login test against the ADMIN_PASSWORD gate returns "unable". Bridge the same way: bash writes the secret to a `/tmp` JSON file, `code_execution` reads it and interpolates it into the `testPlan` string (never `console.log` it), then deletes the file after the run.
