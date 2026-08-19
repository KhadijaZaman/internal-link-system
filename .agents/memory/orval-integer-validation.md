---
name: Orval integer validation
description: Generated Zod schemas do not currently preserve OpenAPI integer validation.
---

Treat OpenAPI `type: integer` as insufficient runtime validation in generated Zod schemas; explicitly reject fractional values at the API boundary.

**Why:** The current Orval/Zod generator emits coercing numeric schemas with min/max constraints but no integer constraint, so values such as `10.5` pass generated validation even though the contract declares an integer.

**How to apply:** Whenever an integer query parameter, path parameter, or request field affects limits, cost, IDs, or persisted state, inspect the generated schema and add `Number.isInteger` validation until codegen preserves integer-ness.