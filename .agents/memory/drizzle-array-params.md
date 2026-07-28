---
name: Drizzle array params
description: Passing a JS array into a drizzle sql template breaks = any(); use inArray.
---

Interpolating a JS array into a drizzle ``sql`` template (e.g. ``sql`${col} = any(${paths})` ``) spreads it into a parenthesized tuple `($2, $3, ...)`, which is invalid for `any()` and fails the query.

**Why:** hit in the SEO report route — two sections silently degraded to "unavailable" because the clicks-join query failed this way.

**How to apply:** use `inArray(col, values)` for membership tests; reserve raw `= any(...)` for a genuine single array parameter cast explicitly.
