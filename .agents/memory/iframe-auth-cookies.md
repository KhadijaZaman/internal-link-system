---
name: Auth cookies in the Replit canvas iframe
description: Why session login fails inside the embedded preview iframe and the cookie/CORS combo that fixes it safely
---

# Session cookies must be CHIPS-compatible to work in the Replit canvas iframe

The dashboard is embedded as a third-party iframe (`*.replit.dev` inside the Replit
workspace). Modern Chrome blocks third-party cookies by default, so a `SameSite=Lax`
session cookie is never stored/sent on requests made from inside that iframe — login
succeeds server-side but the user bounces straight back to the login screen.

**Fix (must apply together):**
- Session cookie: `SameSite=None; Secure; Partitioned` (CHIPS). Set the same attributes
  on the clear-cookie call so logout actually clears it.
- The generated API client (`customFetch`) must send `credentials: "include"` on every
  request, not rely on per-route overrides.

**Why the security guard matters:** `SameSite=None` lets the browser attach the auth
cookie to cross-site requests. With the old permissive CORS (`origin: true,
credentials: true`) that opened a CSRF / cross-site-read hole (flagged in the threat
model). The dashboard calls the API **same-origin** (same proxy host), so CORS should be
an explicit allowlist built from `REPLIT_DOMAINS` + `REPLIT_DEV_DOMAIN`, allowing requests
with no Origin header (same-origin / curl). Because all mutating endpoints are JSON, a
cross-origin attacker triggers a CORS preflight that the allowlist rejects — that is the
CSRF defense.

**How to apply:** any time auth/session works in a standalone tab but fails in the
embedded preview, check the cookie's SameSite/Partitioned attributes first, then confirm
CORS is still locked to the allowlist (never loosen CORS to `origin: true` while
`SameSite=None`).
