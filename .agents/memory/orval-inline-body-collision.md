---
name: Orval inline body collision
description: Why OpenAPI requestBody schemas in this repo must be $ref'd named components, not inline objects.
---
Rule: every `requestBody` schema in `lib/api-spec/openapi.yaml` must be a `$ref` to a named component (e.g. `ConnectGa4Input`), never an inline object.

**Why:** orval emits a zod const `<OperationId>Body` (generated/api.ts) AND, for inline schemas, a TS type with the same `<OperationId>Body` name (generated/types/) — the `export *` barrel in lib/api-zod then fails with TS2308 "already exported a member". Named components give the TS type the component name, so no clash. Also: the spec rejects duplicate schema keys (js-yaml "duplicated mapping key") with an opaque orval "Failed to resolve input" error — check for duplicate component names when codegen fails to parse.

**How to apply:** when adding endpoints, define `XxxInput` under components/schemas and $ref it; after codegen failures, parse the yaml with js-yaml to see the real error.
