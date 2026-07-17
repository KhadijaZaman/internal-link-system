---
name: E2E testing auth bridge
description: How to get the Playwright testing subagent past the password-only admin login.
---

The testing subagent cannot read env secrets (no `process.env` in its browser/notebook context), so it can never type `ADMIN_PASSWORD` itself, and it navigates the app via the **public dev domain** (`*.replit.dev`), not localhost.

**How to apply:**
1. Mint a session from bash: `node -e` fetch → `POST /api/auth/login` with `process.env.ADMIN_PASSWORD.trim()`, write `{name, value}` of the set-cookie to a `/tmp` JSON file (never print the value).
2. In the code_execution sandbox, read that file and interpolate the cookie into the `runTest` test plan, instructing the agent to add it with Playwright `context.addCookies([{ name, value, url: "<the exact https base URL it navigates to>" }])` — the `url` form is mandatory. Scoping to `domain: "localhost"` silently fails because the agent browses the public domain.
3. After the test, invalidate: `POST /api/auth/logout` with that cookie, and delete the `/tmp` file.

**Why:** first attempt scoped the cookie to localhost → agent stayed on /login; second attempt with `url`-scoped cookie worked immediately.

Also: for toggle buttons (click once = on, again = off), the tester may double-click and report a false "doesn't reset" bug. Instruct it to click exactly ONCE, wait, re-locate elements fresh (stale aria-refs after React re-render), and report the observed state before further clicks.
