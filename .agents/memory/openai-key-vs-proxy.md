---
name: OpenAI direct key exhausted — prefer AI-integrations proxy
description: Which OpenAI credential path works for chat completions in this project
---
The user's direct OPENAI_API_KEY ran out of credits (429 credit_balance_exhausted, 2026-07-30). Chat-completion callers should prefer the Replit AI-integrations proxy (`AI_INTEGRATIONS_OPENAI_API_KEY` + `AI_INTEGRATIONS_OPENAI_BASE_URL` as baseURL) with fallback to the direct key. gscChat.ts already does this; other callers (openaiBrief, openaiClusterLabels, openaiArticleAnalysis, semanticPipeline, content.ts, openaiEmbed) still use the direct key and will fail until migrated or the key is topped up.
**How to apply:** any new OpenAI client — use proxy-first pattern from gscChat.ts getOpenAI().
