---
name: BOFU page taxonomy
description: How Wellows BOFU pages are defined when asked to classify pages site-wide.
---

The user's BOFU (bottom-of-funnel) definition for the Wellows site, used when asked to identify "all BOFU pages".

**BOFU = product / commercial-intent, product-tied pages:**
- Money/product pages: `/pricing/`, `/about-us/`, `/contact-us/`, `/book-a-demo/`, `/switch-to-wellows/`, `/brand-story/`, `/case-study/*`, all `/features/*`, all `/solutions/*`, all `/alternatives/*`.
- Branded product tools ONLY: AI-visibility trackers (chatgpt / perplexity / ai-overviews). Generic free tools (`query-fan-out`, `content-decay`, `free-ai-humanizer`) are NOT BOFU.
- Competitor comparisons: `wellows-vs-X` / `X-vs-wellows`.
- Commercial "best/top TOOLS" listicles where Wellows competes (`ai-visibility-tools`, `ai-seo-tools`, `best-ai-content-optimization-tools`).
- Product-tied agency sales-enablement: `ai-visibility-for-<vertical>-marketing-agencies`, AI-visibility `*-checklist-for-agencies`, `how-agencies-deliver/find/monitor...`, `generative-engine-optimization-agencies`, `can-agencies-use-llm-audits`, `why-agencies-cant-guarantee...`.

**NOT BOFU:**
- Generic agency listicles not tied to the AI-visibility product (`content-marketing-agencies`, `technical-seo-agencies`, `top-ai-seo-agencies`, `digital-marketing-agencies`, `social-media-marketing-agencies`).
- Generic checklists (`technical-seo-checklist-for-agencies`, `audit-checklist-for-agencies`).
- Informational/educational content incl. GEO concept explainers (`generative-engine-optimization-kpis`, `generative-engine-visibility-factors`), how-to, what-is, trends, statistics.

**Authoritative override:** the user's explicit BOFU list MINUS their NOT-BOFU list is ground truth; only extrapolate to unlabeled pages.

**Borderline family — always flag for review:** the ~25 `/blog/ai-search-visibility-for-<industry>-brands/` pages (automotive, banking, beauty, gaming, legal, etc.). Structurally parallel to the BOFU "for-marketing-agencies" pages but they target brands, and the user knew of them yet did not list them. Classify as BOFU but mark "Review", never silently in or out.

**Why / how to apply:** the on/off-funnel boundary is semantic and the user iterates with corrections. Deliver classification with a Confidence column (Your label / High / Review) so borderline calls are filterable rather than hidden, and call out the Review families in chat.

## Query intent (Commercial vs BOFU)

When asked to label the *queries* (not pages) by funnel intent into two buckets:
- **BOFU** = transactional / navigational / ready-to-use: brand & `site:` queries (wellows, aiclicks), a SINGULAR tool/product to use now ("ai overview checker", "chatgpt visibility tracker", "ai visibility audit"), or conversion intent (demo / trial / signup / pricing / buy / login).
- **Commercial** = investigation / comparison: superlatives & comparisons (best / top / vs / alternatives / review / comparison), PLURAL category browsing ("ai visibility tools", "ai seo tools"), agency / consultant / service / vendor / startup evaluation, and buying-research questions ("what's a good tool to…", "what is the best platform…").

Apply in this precedence order: `site:`/brand → comparison/superlative → service/agency → question → plural-category → else BOFU. The key fine line: singular "X tool" = BOFU, plural "X tools" = Commercial.

**Why rule-based:** direct OpenAI API calls (api.openai.com) hung repeatedly in this environment (both gpt-4o and gpt-4o-mini, even with an AbortController), so a deterministic rule-based classifier is the reliable path here — and it is transparent for the user to audit and correct. If an LLM is needed, prefer the AI-integrations proxy over direct api.openai.com and always set a fetch timeout.
