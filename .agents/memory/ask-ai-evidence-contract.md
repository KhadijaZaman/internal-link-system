---
name: Ask AI evidence contract
description: Durable rules for auditable SEO answers and why model text must be validated before users see it.
---

SEO answers must be validated before display, not streamed optimistically and checked afterward. Model output uses structured claims: each claim declares its type, capability, metric, exact evidence record, and exact row field; calculations also declare their inputs. The server validates and renders only accepted claims. Copilot citations, Bing Webmaster performance, Bing indexing, URL indexing, sitemap indexing, CrUX, and GA4 AI referrals are separate capabilities.

**Why:** Prompt instructions and record-level citations still allow a real record to be cited for a claim it cannot prove, such as using Bing traffic as Bing indexing evidence. Once a token is streamed it cannot be retracted safely, so unvalidated output breaks the auditability guarantee.

**How to apply:** Add new Ask AI data sources with explicit allowed claim fields, metrics, and capabilities. Buffer output until structured validation passes; on failure, return one fixed disclosure and keep validation diagnostics only in server logs.