---
name: User-supplied outbound URLs need SSRF guards
description: Any feature where the server fetches a URL a tenant typed in (CMS base URLs, webhooks) must pass the SSRF guard.
---
Rule: whenever the API server fetches a user-supplied host (e.g. the WordPress publishing base URL), validate before EVERY request, not just at save time: HTTPS-only, no custom port, no creds in URL, hostname must be a public domain, and DNS must resolve to only public IPs (re-resolved per request to close rebinding). Also set `redirect: "error"` on the fetch.

**Why:** Architect review flagged that a syntactically-valid URL check alone lets an authenticated tenant point the server at cloud metadata (169.254.169.254) or internal services. This codebase is multi-tenant, so one tenant's config becomes server-side requests.

**How to apply:** Reuse the existing guard (`assertSafeWpBaseUrl` / `ipIsPrivate` in the WordPress publish integration) for any new outbound-fetch-to-tenant-URL feature instead of writing a new check.
