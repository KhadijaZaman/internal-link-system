---
name: Body-parser limit vs request-body contract cap
description: Why a route's OpenAPI/Zod body cap above 100KB silently 413s unless the express.json limit matches.
---

# Body-parser limit must match the request-body contract cap

When a route's OpenAPI/Zod contract allows a request body larger than ~100KB
(e.g. a knowledge-base upload capped at 500K chars of `content`), the global
`express.json()` parser still rejects it with a raw **413 before the route ever
runs**, because body-parser's default limit is 100KB. Typecheck passes, small
e2e payloads pass, and the failure only shows up on real large inputs.

**Why:** the contract (Zod max length, UI copy) and the transport limit
(`express.json({ limit })`) are two independent gates. Raising one without the
other creates a promise the server silently breaks.

**How to apply:** whenever you add a route whose body contract exceeds the
global JSON limit, raise the parser limit for *that path only* by mounting a
larger parser BEFORE the global one — body-parser sets `req._body` and the
default parser then skips re-parsing, so the rest of the API stays tight:

```ts
app.use("/api/<bigPath>", express.json({ limit: "600kb" }));
app.use(express.json()); // global default stays 100KB
```

Always verify with an e2e upload **larger than 100KB**, not a token-sized one.
