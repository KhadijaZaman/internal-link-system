---
name: SSE streaming through the Replit proxy
description: How server-sent-events must be shaped/consumed so they survive Replit's buffering proxy in this app.
---

# SSE streaming through the Replit proxy

The GSC chatbot streams model tokens over SSE (`POST /api/gsc/chat/stream`). Two non-obvious
constraints make streaming actually work end-to-end here:

**Server side must defeat proxy buffering.** Replit's reverse proxy buffers chunked responses
until a threshold is crossed, so a naive SSE stream appears to "hang" then dump all at once. The
endpoint works around this by writing a ~16KB SSE comment (`: <spaces>\n\n`) up front to cross the
buffer threshold, plus periodic `: keep-alive\n\n` comments and the `x-accel-buffering: no` header.

**Why:** without the upfront padding the user sees nothing until the whole answer is ready, which
defeats the point of streaming.

**Client side must tolerate SSE comments and chunk boundaries.** Any browser consumer reading the
stream via `fetch` + `ReadableStream` must:
- Ignore lines starting with `:` (the padding + keep-alives), not treat them as data.
- Buffer across reads and split on `\n\n` — a single `delta` event can span two network chunks.
- Flush the `TextDecoder` and process any trailing non-`\n\n`-terminated event at EOF.
- Guard streamed state updates by request identity (compare the live `AbortController`), or a
  superseded stream (range/filter change) can append stale tokens into the new conversation.

**How to apply:** reuse this same shape for any future streaming endpoint in this repo (e.g. other
AI features). EventSource can't POST a JSON body, so streaming endpoints here are POST + manual
SSE parsing, not the native `EventSource` API.
