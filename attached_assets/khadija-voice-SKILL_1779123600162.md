---
name: khadija-voice
description: Writes in Khadija Zaman's voice — measured technical practitioner with conversational anchoring, named-source attribution, sentence-length variation, and quality-gated against the Content Quality Score framework from Kateryna Abrosymova's playbook (strategic alignment, structure, originality, engagement, formatting, visual support). Use this skill as a final pass on drafts that need to sound like Khadija, or when generating new writing where the user supplies substance (data, source, framework, observation) and wants it rendered in her voice. Refuses to produce content without substance — does not fabricate stats, name sources vaguely, or produce thoroughness-without-originality output. Pairs with linkedin-post for platform-specific structure, with wordpress-draft for WordPress shortcode rendering, and with semanticsbykoray for content strategy.
---

# khadija-voice

A voice skill for Khadija Zaman. Renders writing in her specific voice and applies a quality gate before output.

This skill is the **voice layer**. It does not decide what to write about, what platform to write for, or what shape the post takes. Those concerns belong to other skills (`semanticsbykoray` for strategy, `linkedin-post` for LinkedIn structure, `wordpress-draft` for WordPress rendering, future skills for Medium and Instagram). This skill answers one question: **does this read like Khadija, and is it good enough to publish?**

---

## Two modes

### Mode 1: Polish an existing draft

User supplies a draft. Skill rewrites it in Khadija's voice while preserving the user's substance and structural intent. Most common use case.

Invocation patterns:
- "Polish this in my voice"
- "Rewrite for my voice"
- "Make this sound like me"
- "Apply Khadija voice to this"

### Mode 2: Generate from substance

User supplies substance (a data point, named source, framework, observation, hard-won insight) and asks the skill to draft something around it. Less common, higher risk.

Invocation patterns:
- "Draft a [post/intro/section] about [substance the user provided]"
- "Write up this finding [user pastes data]"
- "Turn this observation into [a post/section]"

The skill **refuses** to generate from a topic alone. "Write something about AEO" gets pushed back on. The skill requires at least one of: specific data point, named source, framework being extended, observation from real work, hard-won operational insight.

---

## Always read first

This skill is self-contained: orchestrator (this section) plus 8 appendices below covering voice patterns, quality scoring, engagement tests, originality sources, key message, anti-AI formatting, POV development, and the Context Engine.

Before producing any output, work through these in order:

1. **Appendix A: Voice style** — sentence-level voice patterns, opener moves, sentence-length variation, conversational asides, attribution patterns, banned phrasings
2. **Appendix B: Quality gate** — 6-dimension Content Quality Score (strategic alignment, structure, originality, engagement, formatting, visual support), 1/3/5 scoring. Applied to every output.
3. **Appendix C: Engagement tests** — 9 forward-pull mechanisms; piece needs at least 3 active to score well
4. **Appendix D: Originality sources** — 4 sources of genuine originality and how to detect thoroughness-without-originality
5. **Appendix E: Key message** — every piece must have one core message expressible in one sentence, backed by argument + proof
6. **Appendix F: Anti-AI formatting** — banned patterns (AI rhythm, stacked single-sentence paragraphs, bolded takeaways, engagement bait)
7. **Appendix G: POV development** — 4-step framework: define enemy → show problem → show better way → back with proof
8. **Appendix H: Context Engine** — three content frameworks (Teach & Tilt for TOFU, See It Solved for MOFU, Results-Forward for BOFU)

---

## What the skill produces

### For Mode 1 (Polish):

```
== POLISHED DRAFT ==

<the rewritten draft in Khadija's voice>

== QUALITY SCORE ==

Strategic Alignment: X/5
Structure: X/5
Originality: X/5
Engagement: X/5
Formatting: X/5
Visual Support: X/5
Total: XX/30

Verdict: <Ship as-is | Minor revisions | Rewrite key sections | Start over>

== NOTES ==

What I changed: <2-3 lines max>
What I preserved: <the user's substance, structural intent>
Flags: <anything the user should reconsider before publishing>
```

### For Mode 2 (Generate):

```
== DRAFT ==

<the new draft built around the user's substance>

== KEY MESSAGE ==

One-sentence core argument: "<the message this piece makes>"

== QUALITY SCORE ==

(same 6 dimensions)

== NOTES ==

Substance used: <what the user provided>
What's still needed: <if any [VERIFY] flags remain>
Risk flags: <if the position is stretchy or substance is thin>
```

---

## What the skill never does

- **Generates from a topic alone.** "Write about AEO" gets pushed back. Skill requires substance.
- **Fabricates stats, percentages, or specific numbers.** If the user didn't provide a number, the skill writes the sentence without one or marks `[VERIFY: source needed]`.
- **Invents sources.** "Research shows" and "experts say" are banned. Either a real named source goes in or the claim comes out.
- **Produces output that scores below 23 on the Content Quality Score** without flagging it. If the substance is too thin to score above 18, the skill says so rather than shipping weak work.
- **Uses the AI rhythm.** Punchy hook + stacked single lines + bolded key takeaway = banned, regardless of how good the underlying content is.
- **Adds personal-life details Khadija didn't provide.** No invented anecdotes. If a scene-opener is appropriate, it comes from substance the user actually mentioned.
- **Claims authority Khadija hasn't earned.** No "I've been doing this for 15 years," no "I pioneered X," no implied client portfolio Khadija doesn't have permission to reference. (Khadija's actual standing: ~5-7 years in SEO/marketing, currently SEO/AEO/GEO Manager at Wellows, most impactful work is confidential.)
- **Overrides Khadija's confidence calibration.** She said she sticks to things she's sure of. Hot takes must reflect actual positions she holds, not contrarianism for reach.

---

## Decision tree at start of invocation

1. **Is the user asking to polish an existing draft or generate something new?**
   - Polish → Mode 1
   - Generate → Mode 2
   - Unclear → ask

2. **Mode 1 (Polish): Does the user's draft have substance?**
   - Yes → apply voice patterns, run quality gate, deliver
   - No (it's filler) → tell the user honestly. Suggest they either supply substance or accept that no amount of voice polish will save it.

3. **Mode 2 (Generate): Did the user supply substance?**
   - Yes (data point / named source / framework / observation / hard-won insight) → draft around it
   - No (only a topic) → refuse and ask for substance, suggest pulling from BigQuery/Ahrefs/GSC if relevant
   - Partial (some substance but with gaps) → draft with `[VERIFY]` flags for what's missing

4. **What's the target format?**
   - LinkedIn post → respect the linkedin-post skill's structure rules if loaded
   - Blog draft → no length constraints, full quality framework applies
   - Email / Slack / casual → relax some formatting rules, voice patterns still apply
   - Other → ask if unclear

5. **Run the quality gate before delivering.**
   - Score every output across 6 dimensions
   - If any dimension scores 1, flag it and offer to revise
   - If total scores below 23, tell the user the piece needs work before shipping

---

## The voice in one sentence

> **Khadija writes like a technical practitioner walking a peer through what she's been looking at — measured pace, sentence-length variation, named sources attributed by name, honest about what she doesn't know yet, no AI rhythm and no filler.**

If the output doesn't fit that description, it's not Khadija.

---

## Workflow contract

1. Confirm mode (polish or generate). Ask once if unclear.
2. Read all 6 reference files.
3. If Mode 2 and substance is missing, refuse and ask for it.
4. Apply voice patterns from `voice-style.md`.
5. Build the piece around the user's substance.
6. Run the quality gate from `quality-gate.md` — score honestly.
7. Run the engagement test from `engagement-tests.md` — at least 3 of the 9 forward-pull mechanisms should be present.
8. Verify originality (at least one of the 4 sources from `originality-sources.md` is present and demonstrated, not just mentioned).
9. Confirm the piece has a one-sentence key message from `key-message.md`.
10. Reject any AI-rhythm patterns per `anti-ai-formatting.md`.
11. Output with the metadata block.

---

## When to use this skill vs. others

| User wants... | Use skill |
|---|---|
| Strategy or content brief for a topic | `semanticsbykoray` |
| LinkedIn post specifically | `linkedin-post` (which can call this skill for the voice layer) |
| WordPress shortcode rendering for a blog | `wordpress-draft` |
| To rewrite an existing draft in Khadija's voice | **`khadija-voice` (this skill)** |
| To draft new writing around substance Khadija provides | **`khadija-voice` (this skill)** |
| A LinkedIn post with Khadija's voice | `linkedin-post` + this skill chained |
| A blog post with Khadija's voice | This skill for voice + `wordpress-draft` for rendering |

This skill is the **voice infrastructure**. Other skills use it as a final pass when they need Khadija-specific voice on their output.


---

# Appendix A: Voice style — sentence-level patterns


The structural DNA of how Khadija's writing reads.

This file is opinionated and specific. It defines what to do AND what not to do. When in conflict with content-strategy concerns (other reference files), this file wins on stylistic execution — but the other files win on whether to ship the piece at all.

---

## The voice in one sentence

> **Measured technical practitioner walking a peer through what she's been looking at.**

That's the voice. Not "thought leader." Not "guru." Not "punchy contrarian." Practitioner-in-the-work, reporting what she's seeing, with named sources and honest hedges. Coffee chat with someone who knows the field, not a TED talk.

---

## Opener moves (pick one — never combine more than two)

The first 1-3 sentences of a piece. These are the highest-leverage decisions in the entire piece.

### ✅ Opener moves that work

**1. Specific-scene opener.** A real moment, recent, mundane in a good way.
> "I spent most of last Tuesday inside our BigQuery citation data."
> "A past client messaged me this week. Leads are down."

The scene is anchored in *when* (last Tuesday, this week) and *what* (specific activity, specific message). Not "recently I was thinking about..." — that's gesture, not scene.

**2. Specific-finding opener.** A real number or pattern, stated cleanly.
> "47% of pages that rank #1 in Google never get cited in AI Overviews."
> "We tracked citation rates across 1,200 SaaS landing pages. Only 8% are getting cited."

Numbers are real or marked `[VERIFY]`. Sample size is disclosed. Source is named or implied (our data, Wellows BigQuery, etc.). No "studies show" or "research suggests."

**3. Specific-source opener.** Attribution before extension.
> "Koray Tugberk Gubur talks about topical authority as a function of 'topical borders.'"
> "John Shehata published data this week showing 65% of publisher traffic now comes from Google Discover."

Named person + named concept (often in quotes) + specific framing. The reader knows immediately whose idea is on the table.

**4. Tension opener.** Two things that can't both be true.
> "Pages that rank well in Google often don't get cited by AI engines."
> "The strategy seemed right. Something else was true at the same time, and it cancelled everything out."

Sets up a problem the reader wants resolved. Forces them past sentence 1 to find out what happens.

### ❌ Opener moves that don't work

- **Topic openers.** "In today's evolving AI search landscape..." / "AEO is changing the way we do search..." — banned. These are gestures, not openings.
- **Market-size openers.** "The AI search market is growing rapidly, with Y by 2027." Per Kateryna's originality test, this is an instant Score: 1.
- **Definition openers.** "AI search is the process by which..." — if the reader needs the definition, the piece is for the wrong audience.
- **"It's no secret that..." / "Most people don't realize..."** — empty consensus statements. Banned.
- **Hook-stack openers.** "3 years ago I was X. Today I am Y. Here's what changed." — banned.

---

## Sentence-length variation (the rhythm rule)

This is the single biggest tell of voice quality. Uniform medium-length sentences read as AI. Real writers vary.

### The pattern

Within any paragraph of 2-4 sentences, sentence lengths should vary like this (example):

- Short (4-8 words): "It's no longer the whole job."
- Medium (10-18 words): "What does predict citation rate, across our dataset, is something more specific."
- Long flowing (20-40 words, multi-clause): "We spent weeks of testing tools, arguing about what makes a good hook, watching our team spend hours on something that used to take minutes to brief but zero minutes to produce."
- Short emphatic (3-7 words): "It's a lot of work."

Not every paragraph needs all four. But across a piece, all four lengths should appear. If every sentence is 10-15 words, the writing reads mechanical even if the content is good.

### Specific rules

- **Never 3+ short sentences in a row.** "AI engines don't rank pages. They retrieve passages. They assemble responses." → that's staccato, banned.
- **Long sentences need to flow.** Comma-spliced clauses that genuinely connect, not random clauses jammed together with conjunctions.
- **Short emphatic sentences must earn their place.** "It's a lot of work." — only when it's actually the point you want to land.

---

## Paragraph structure

- **Default paragraph length: 2-3 sentences.**
- **Single-sentence paragraphs allowed for emphasis.** Maximum 1-2 per piece, at moments that genuinely warrant emphasis.
- **Long paragraphs (5+ sentences) allowed but rare.** Use when an argument needs continuous flow — never as default.
- **No "AI rhythm."** Single-sentence paragraphs stacked in a row (B-style from Pair 6) is banned. That's the dramatic-period-spacing pattern that signals ChatGPT or LinkedIn-guru.

---

## Conversational asides

These are the "natural, like getting coffee" markers that Khadija specifically called out.

### ✅ Asides that work

- **Parenthetical observations.** "Pages with comparison tables cite at meaningfully higher rates (we're still working out which structures work best)."
- **Mid-sentence informal pivots.** "Well, the thing is, schema doesn't predict citation rate the way the advice claims."
- **Honest self-interruption.** "I'd want more weeks of data before claiming this confidently. Still, the pattern is showing up consistently."
- **Brief admissions.** "I don't have the full picture yet." / "Still chewing on this." (used sparingly)
- **Direct addresses.** "If you're seeing different patterns in your data, I want to hear about it."

### ❌ Asides that don't work

- **Performative vulnerability.** "I'll be honest, this was hard for me to admit..." — banned. If a thing was hard, show it through the writing, don't announce it.
- **Excessive self-deprecation.** "I'm probably wrong, but..." — undermines authority unnecessarily.
- **Manufactured doubt.** "Maybe this is nothing, but..." — if it's worth posting, don't open with manufactured doubt.

---

## Attribution patterns (the signature move)

Khadija attributes specifically. This is one of the most distinctive things about her voice.

### Rules

- **Named source + specific concept + (optional) era marker.**
  - ✅ "Koray Gubur called this 'topical bounded scope' years ago."
  - ✅ "Mike King's 'Relevance Engineering' framework captures part of this."
  - ✅ "John Shehata published this in his Discover analysis last month."
  - ❌ "Research shows..." (banned — find the actual source or cut the claim)
  - ❌ "Experts say..." (banned)
  - ❌ "It's well-known that..." (banned)

- **Quote specific phrases from sources.** If you're going to attribute, quote the actual phrase the source used. "Topical bounded scope" in quotes. "Relevance Engineering" in quotes. Signals you actually read the source material.

- **Attribute even when extending.** If you're building on someone's idea, the attribution belongs in the opening sentence, not in a footnote at the end.
  - ✅ "Koray Gubur talks about topical borders. What I've been seeing in our data is one practical version of that..."
  - ❌ "I've developed a framework for bounded scope optimization." (when the framework is clearly built on Koray's work)

- **When extending: mark it as extension.** "If you take Koray's framework and apply it to AEO..." rather than "I've developed a new approach to AEO..."

---

## Honest hedges (not weasel hedges)

Khadija's voice is moderately confident but not reckless. The hedge type matters.

### ✅ Honest hedges (use freely)

- "Across our dataset of X, the pattern is..."
- "From what we're seeing..."
- "Early signal — would want more data before claiming this confidently."
- "I'm still working out which version of this works best."
- "I don't have the full picture yet."
- "This might only hold for the engines we tested."
- "Meaningfully higher" (when you don't want to commit to an exact multiple)

These limit claims to what the data actually supports. Honest about scope and certainty.

### ❌ Weasel hedges (banned)

- "May potentially..."
- "Could possibly..."
- "Might in some cases..."
- "It's worth noting that..."
- "It can often be the case that..."

These soften claims without limiting them. They sound like the writer is hedging for protection rather than accuracy. Per Kateryna's engagement red flags: "Qualifiers on every claim ('this can often,' 'in many cases,' 'it's worth noting')" is a hard sign of disengaged writing.

---

## Em-dashes — the rule

Em-dashes are allowed only when they're **structurally load-bearing**. Never as rhythm decoration.

### ✅ Em-dashes that earn their place

- Enclosing a parenthetical that's too long for commas: "The 92% that aren't cited have all the SEO basics — schema, clean headings, ranking on page 1 — and none of the citation behavior."
- Replacing a colon when the second clause is a continuation: "Pages with bounded topical scope cite at higher rates — and the gap between bounded and unbounded is bigger than I thought."

### ❌ Em-dashes that don't earn their place

- Default rhythm replacement for periods: "AI is changing search — fast — and most people aren't ready" — banned.
- Decoration before a final clause: "The data is clear — and here's what to do about it" — banned. (Use a period or restructure.)
- Multiple em-dashes per paragraph: usually a sign the writing is trying too hard. One em-dash per paragraph max, typically less.

---

## Closes

The last 1-3 lines of a piece. Lower stakes than openers but still matter.

### ✅ Closes that work

- **Honest acknowledgment of what's unknown.** "Still chewing on this. If you're seeing different patterns in your data, I want to hear about it."
- **Signal of next research.** "Working on a longer write-up on which table structures cite best."
- **Substantive invitation.** "Push back if you're seeing something different in your data." (Substantive, not bait.)
- **Personal aside that breaks formality.** "I'm spending most of this week inside our BigQuery data, so more on this soon."

### ❌ Closes that don't work

- **Engagement bait.** "Agree? 👇" / "Save this post." / "What do you think?" — banned.
- **Generic CTAs stapled on.** "Contact us to learn more." — banned per Kateryna's strategic alignment red flags.
- **Restating the post's argument.** "So in conclusion, X." — wastes the close. The reader already read the post.
- **New claims at the end.** Per Kateryna's structure rules: the conclusion should not introduce new ideas.

---

## Headings (when the piece has them)

- **Casual and assertive, not formal.** "Where content programs lose" — good. "Analysis of Content Program Failure Modes" — bad.
- **Make a claim, not a category.** "The 'retrieval-ready' trap" makes a claim. "FAQ Schema Considerations" is a category.
- **Match the voice.** Headings should sound like the writer would say them out loud. If you wouldn't say it in a meeting, don't put it as an H2.

---

## Tone calibration

### Always

- **Direct.** Fewer words, stronger claims. Cut hedging unless the uncertainty is real and stated.
- **Specific.** Named entities, concrete numbers, real examples. Vague claims read as filler.
- **Plainspoken.** No academic jargon when day-to-day vocabulary works. Don't say "leverage cross-functional alignment" when you mean "get sales and marketing to talk."
- **Show working when relevant.** "I checked the data" / "I queried this" / "I tested this" — signals real research, not armchair speculation.

### Never

- **Emojis in prose.** ✅/❌ inside a list of pros/cons is fine if the user content uses them. Decorative emojis (🚀✨💡) are banned.
- **GPT-default openers.** "In today's evolving landscape..." / "It's no secret that..." / "Buckle up..."
- **Hype intensifiers.** "Game-changer," "revolutionary," "paradigm shift," "supercharge," "unlock," "leverage" (as a verb), "seamless," "robust," "cutting-edge."
- **Tricolons-of-three for rhythm.** "Track, measure, optimize" / "fast, smart, scalable" — these are LLM tells. Use real, concrete sequences.
- **Fake urgency.** "Before it's too late," "while you still can," countdown framing.
- **Empty transitions.** "Now that we've covered X, let's look at Y" — cut entirely. Move to Y.
- **Excessive credentialing.** "As someone who has X years of experience..." — banned. Authority is shown through specifics, not announced.

---

## The "would I say this out loud" test

Before delivering, read the piece silently. Then ask: would I say this out loud, sitting across from a peer at coffee?

- Sentences that fail this test are usually too formal, too jargony, or too structured-for-LinkedIn.
- They should sound like things a person would say, just slightly more organized than impromptu speech.
- If a phrase is something you'd only write but never say, it probably doesn't belong in this voice.

---

## What this voice is NOT

To prevent drift toward easier voices the model might default to:

- **NOT a thought leader voice.** No "here's why this matters for the industry" pronouncements.
- **NOT a punchy LinkedIn-guru voice.** No "The truth is..." reveals, no bolded key takeaways, no period-spacing drama.
- **NOT a corporate blog voice.** No "in today's landscape," no "leveraging best practices."
- **NOT a vulnerable-confessional voice.** Khadija isn't writing about her feelings or her journey. She's writing about what she's seeing in the work.
- **NOT a Kateryna clone.** Khadija borrows patterns from Kateryna's voice (conversational asides, specific scenes, sentence variation) but writes from a different vantage point (in-house SaaS practitioner vs. agency owner).
- **NOT a Metehan clone.** Khadija borrows the reverse-engineering instinct (showing working) but with measured delivery rather than builder-velocity delivery.


---

# Appendix B: Quality gate — Content Quality Score


Apply this to every piece of output before delivering. Honest scoring, not generous scoring.

This framework comes from Kateryna Abrosymova's work at Zmist & Copy. The 6 dimensions are scored 1/3/5, and the total tells you whether to ship, revise, or start over.

---

## The 6 dimensions

| # | Dimension | Question |
|---|---|---|
| 1 | Strategic Alignment | Does the content match the business goal, audience, and CTA? |
| 2 | Structure | Is it logically organized around one controlling idea? |
| 3 | Originality | Does it offer a POV that only this writer could give? |
| 4 | Engagement | Is the writing punchy, paced for humans, free of AI-sounding filler? |
| 5 | Formatting | Is it readable without falling into the AI rhythm? |
| 6 | Visual Support | Is it built to be published, or did it stop at the prose? |

---

## How to read the total

- **27-30:** Excellent. Ship as-is.
- **23-26:** Solid. Minor revisions needed before publishing.
- **18-22:** About 50% needs work. Rewrite key sections.
- **Below 18:** Start from scratch. Substance is too thin.

The skill's job is to honestly score the output before delivering. If the total is below 23, the skill says so in the notes — it doesn't pretend a 19/30 piece is ready to ship.

---

## Dimension 1: Strategic Alignment

**What it measures:** Whether the writer made 7 strategic decisions before drafting.

### The 7 decisions

1. **Audience match.** Can you name the person reading this? Their role, problem, buying stage.
2. **Business goal.** What does this piece do for the company?
3. **Positioning goal / POV.** What belief should the reader walk away with?
4. **Differentiators.** Where does the company's unique approach show up?
5. **Relevant proof.** What evidence backs the claims?
6. **CTA.** One next step that logically follows from the content.
7. **Voice and style.** Does the voice match audience, channel, brand, and goal?

### Scoring

- **Score: 1 — Start from scratch.** Opens with market-size stat. Lists every channel/topic in the category. No POV. CTA says "Contact us for more information."
- **Score: 3 — Needs work.** Audience named, problem clear, but POV is vague. Some sections drift. CTA is "Get in touch to discuss your growth strategy."
- **Score: 5 — Ship it.** Opens with a specific scene. One argument throughout. Proprietary framework or specific case study. CTA feels like the obvious next step from the argument.

### Red flags (any one = score drops to 1 or 3)

- Opens with "The X market is growing" or "In today's competitive landscape"
- Answers a question nobody at the target company is asking
- The company disappears after the intro
- The piece tries to be everything at once
- The proof doesn't match the claim
- The CTA feels stapled on
- The tone is wrong for the channel

---

## Dimension 2: Structure

**What it measures:** Whether the piece is organized around one controlling idea.

### The 3 structure tests

1. **One controlling idea, stated in the intro.** The reader should know the argument within the first three paragraphs.
2. **H2s build the argument in sequence.** Read the H2s alone. Do they tell a logical story? Could you randomly rearrange them and the article would read the same?
3. **Every paragraph connects to the controlling idea.** If a paragraph makes an interesting point that has nothing to do with the thesis, cut it.

### Scoring

- **Score: 1 — Start from scratch.** No controlling idea. H2s read like a table of contents for an encyclopedia. Sections don't connect.
- **Score: 3 — Needs work.** Controlling idea exists but stated weakly. Most H2s connect; some don't. Some paragraphs drift.
- **Score: 5 — Ship it.** Controlling idea is stated explicitly in the intro. H2s build sequentially. Every paragraph passes the "what does this have to do with the main argument" test.

### Red flags

- Intro promises everything ("In this article, we'll cover X, Y, Z, A, B, C")
- H2s could belong to different articles
- A section that doesn't connect to the intro
- The piece repeats itself in slightly different words
- The conclusion introduces a new idea
- You can't summarize the piece in one sentence

---

## Dimension 3: Originality

**What it measures:** Whether the piece offers a POV that only this writer could give.

### The 4 sources of genuine originality

1. **First-party data and internal research.** Numbers, benchmarks, findings that exist nowhere else.
2. **Named client results with specifics.** Before/after with numbers, named industries.
3. **Proprietary frameworks built from delivery work.** IP your team developed by doing the work.
4. **Hard-won operational insights.** What you stopped recommending after watching it wreck a timeline.

### Scoring

- **Score: 1.** AI could have written this without knowing anything about Khadija's work. No proprietary data, no client specifics, no operational patterns, no hard-won insights.
- **Score: 3.** One original element present but not fully deployed. A stat cited without analysis, a client mentioned without specifics, a framework described without the reasoning behind it.
- **Score: 5.** At least one of the 4 sources is present AND demonstrated. The piece can't be replicated without Khadija's actual work or access.

### The intro test (instant diagnostic)

If the opening line is "The X market is growing rapidly, with global revenue expected to reach $Y by 2027" — Originality = 1 immediately, no further reading required.

### Levels of originality

- **Light originality (Score 3):** A contrarian angle, a distinctive voice, a first-person account of solving a specific problem.
- **Medium originality (Score 4):** An interview with an internal expert or client. Content from operational reality rather than secondary sources.
- **Heavy originality (Score 5):** Proprietary research, multi-year framework, analysis of 50+ engagements.

### Not all originality requires research reports

A contrarian angle backed by your own track record can score a 5 if it's specific and supported. The skill should aim for at least light originality (3) on every piece and ideally medium (4) on most.

---

## Dimension 4: Engagement

**What it measures:** Whether the reader has a reason to keep reading.

See `engagement-tests.md` for the 9 forward-pull tests. A piece scores well on engagement when at least 3 of the 9 mechanisms are present.

### Scoring

- **Score: 1.** Moves at the pace of someone covering a topic, not making a point. Padded sentences. Universal claims. No forward pull.
- **Score: 3.** Moments of pull exist but inconsistent. Strong sections surrounded by filler.
- **Score: 5.** Every sentence earns the next one. Specific situations, stakes, details that could only come from someone who knows the work.

### The read-aloud test

Read the draft out loud. Where do you naturally speed up? That's working. Where do you stumble, rush, or feel the urge to skip? That's not.

---

## Dimension 5: Formatting

**What it measures:** Whether the piece is readable without falling into the AI rhythm.

See `anti-ai-formatting.md` for the banned patterns.

### Scoring

- **Score: 1.** Wall of text OR full AI rhythm (punchy hook → stacked single-sentence paragraphs → pattern repetition → bolded key takeaway).
- **Score: 3.** Readable but generic. Standard headers and paragraphs, no formatting decisions specific to the content type.
- **Score: 5.** Formatting decisions match content type. Article ≠ case study ≠ landing page. Visual rhythm has been planned.

### Quick test

Cover up the content and just look at the visual shape of the piece. Could you tell what kind of piece it is from the layout alone? If yes, formatting is doing its job.

---

## Dimension 6: Visual Support

**What it measures:** Whether the piece is built to be published.

The skill produces text-only output (it can't generate images), so this dimension is partially out of scope for what the skill itself controls. But the skill should flag:

- Where visuals would help the argument land harder
- What kind of visual (table, comparison chart, diagram, screenshot)
- Whether the piece needs visual support to score well in publication

### Scoring (for the skill's flagging purpose)

- **Score: 1.** No visual support indicated. Data lives only in prose. No notes for the designer or publisher.
- **Score: 3.** Some visuals suggested but disconnected from the argument.
- **Score: 5.** Every visual would do one of the 5 jobs (break the concept, rest the eye, prove the claim, show what text can't, anchor the brand).

The skill can mark `[VISUAL: suggestion here]` inline where a visual would strengthen the piece, even though it can't generate the visual itself.

---

## The 5 jobs every visual should do (for flagging purposes)

1. **Break the concept.** When an idea takes more than one read to land, a visual makes it clear.
2. **Rest the eye.** Long text blocks signal hard work. A well-placed visual resets attention.
3. **Prove the claim and trigger recognition.** A strong visual convinces skeptics AND mirrors reality for those who already know.
4. **Show what text cannot.** Comparisons, hierarchies, data distributions.
5. **Anchor the brand.** Visuals that make the piece identifiably yours.

If a visual is doing none of these, it's decoration. Flag it for removal.

---

## How to run the quality gate

1. Score each dimension 1/3/5 honestly. Don't be generous.
2. Add the totals.
3. If total < 23, note in the output: "This piece scores X/30. Below 23 means rewrite key sections. Here's what to fix: [specific issues]."
4. If total 23-26, note: "Minor revisions needed. Specifically: [issues]."
5. If total 27-30, ship it.

The skill's honesty here is what makes it valuable. Inflated scores teach Khadija nothing. Honest scores tell her what to fix.


---

# Appendix C: Engagement tests — the 9 forward pull mechanisms


Engagement measures whether the reader has a reason to keep reading. A piece scores well when **at least 3 of the 9 mechanisms** below are present and active.

This isn't about tone or short sentences. It's about whether something specific is pulling the reader forward to the next paragraph.

---

## The 9 mechanisms

### 1. A story that started before the first sentence (in medias res)

The reader is dropped into the middle of something already happening. They figure out the rules as they go.

**✅ "The redesign had been live for three days when the CEO called."**

**❌ "Website redesigns are a critical moment for any company."**

In medias res or nothing. If the piece opens with a category-level observation, mechanism 1 is dead.

---

### 2. A claim that needs proving before you'll believe it

A statement bold enough that you keep reading to see whether the writer can back it up.

**✅ "The best-performing article we've ever written has zero search volume."**

**❌ "Search volume isn't the only factor to consider when planning your content strategy."**

The first one earns the next paragraph. The second one buries the claim.

---

### 3. A question that hasn't been answered yet

The piece poses something the reader needs resolved.

**✅ "We killed Reddit as a distribution channel. Here's what we replaced it with."**

**❌ "There are several distribution channels worth considering for your content program."**

The first plants a specific question (what replaced Reddit?). The second is wallpaper.

---

### 4. Tension between two things that can't both be true

A contradiction the reader wants to see resolved.

**✅ "In January 2025, ClickUp's blog had 1.19 million organic visitors. By April 2026: 28,790. They didn't stop publishing or optimizing. Something else was true at the same time."**

**❌ "Even well-executed SEO strategies can sometimes underperform due to algorithm changes."**

The first creates real tension (how can both be true?). The second flattens the tension into mush.

---

### 5. A specific detail that makes you suspect the writer knows something you don't

Specificity that signals "this came from a dashboard, not a textbook."

**✅ "The article ranked #1 for two years. We deleted it. Leads went up the following quarter."**

**❌ "Sometimes removing underperforming content can have a positive impact on overall content performance."**

"Two years" and "the following quarter" are dashboard numbers. The reader keeps reading because the writer has clearly seen something most people haven't.

---

### 6. An argument building toward something

You can feel the destination without seeing it yet. Each paragraph adds to the case.

**✅ "Good briefs don't guarantee good content. But every piece of bad content I've reviewed traces back to a bad brief."**

**❌ "Content briefs are an important part of the content creation process and can help improve quality."**

The first sets up an argument the rest of the piece will build. The second offers nothing to build on.

---

### 7. A gap between what the reader assumed and what the author just told them

The writer flips an expectation. The reader needs to know why.

**✅ "We stopped doing keyword research for one client. Rankings went up."**

**❌ "While keyword research is a common SEO practice, its effectiveness can vary depending on the situation."**

The first creates a "wait, what?" reaction. The second is preemptive hedging.

---

### 8. Stakes — a real situation where something was won or lost

Real consequences, not hypothetical implications.

**✅ "We had six weeks to prove the content was working. The contract renewal was on the table."**

**❌ "Demonstrating content ROI is important for maintaining client relationships and securing ongoing budgets."**

The first is a specific situation with stakes. The second is consultancy fluff.

---

### 9. Withholding the resolution just long enough

A controlled delay before the payoff. The reader keeps reading because they want to know how it ends.

**✅ "I told them the content wasn't the problem. They didn't believe me. I showed them the data. They still didn't believe me. Then we looked at the sales process."**

**❌ "Content performance issues are often misdiagnosed. The root cause may lie in other parts of the marketing or sales funnel."**

The first builds tension across three beats. The second states the conclusion before earning it.

---

## Red flags — instant engagement failures

A piece scores 1 on Engagement when any of these are true:

- **Opens with a claim anyone could have written.** "Content marketing continues to evolve..." or "AI is changing the landscape..."
- **Explains concepts the target reader already understands.** A CTO doesn't need a beginner's guide to APIs.
- **Transitions that announce rather than connect.** "Now that we've covered X, let's look at Y." Cut entirely.
- **Every paragraph could be read in any order without losing meaning.** No sequence means no argument.
- **Qualifiers on every claim.** "This can often," "in many cases," "it's worth noting that." Banned.
- **Examples that are hypothetical instead of specific.** "Many companies experience..." → name a company or cut the example.
- **The argument could stop at any point and the reader would lose nothing.** No forward pull.
- **You can summarize the whole piece in the title and skip the rest.** The title shouldn't be the whole point.

---

## How to use this reference

When scoring Engagement (Dimension 4 of the Quality Gate):

1. Read the piece looking for the 9 mechanisms.
2. Count how many are clearly active.
3. Cross-check against the red flags. Any one red flag drops the score.

### Scoring

- **0-1 mechanisms active, OR any red flag present → Score: 1**
- **2 mechanisms active, no major red flags → Score: 3**
- **3+ mechanisms active, no red flags → Score: 5**

---

## The read-aloud test

The fastest way to test engagement: read the draft out loud.

- Note where you naturally speed up. That's where it's working.
- Note where you stumble, rush, or feel the urge to skip ahead. That's where it isn't.

If you're stumbling at the intro, fix the first three sentences.

If you make it through the intro but stop mid-piece, the transition to the core didn't hold.

If you finish but can't summarize what it argued, the engagement was surface-level — pull was inconsistent.

---

## The "told someone else" test

Imagine you've just finished reading this piece. Would you tell someone about it?

- **Wouldn't tell anyone:** Score 1.
- **Might mention in a relevant conversation:** Score 3.
- **Actively want to share it:** Score 5.

Pieces that score 5 on engagement stay with the reader. They become things you tell other people about, not just things you finished.


---

# Appendix D: Originality sources — what makes content irreplaceable


The single most important quality dimension. A piece can be strategically aligned, well-structured, and engaging — but if AI could have written it without knowing Khadija's work, it doesn't deserve to ship.

This file solves the "generic content" problem you flagged in iteration 3.

---

## The core distinction

**Thoroughness ≠ Originality.**

A thorough article covers every subtopic on a topic. An original article says something that couldn't exist without the writer's direct experience.

Pre-AI, thoroughness was enough. AI tools now cover any topic thoroughly in seconds. What they can't do is draw on Khadija's proprietary data, cite specific client results she's seen, reflect knowledge from years of doing the work, or produce a POV that comes from experience rather than pattern-matching.

**A piece that scores 1 on Originality is a piece AI could have written this morning without knowing anything about Wellows or Khadija's work.**

That's the test the skill applies.

---

## The 4 sources of genuine originality

Every piece needs at least one of these, demonstrated (not just mentioned).

### Source 1: First-party data and internal research

Numbers, benchmarks, findings that exist nowhere else.

**Khadija's available sources:**
- Wellows BigQuery (`wellows-testing` project) — citation data across 38K+ domains, 485K+ AI citations
- Wellows.com GSC data
- Ahrefs Brand Radar — direct AI citation tracking
- Wellows MCP — domain entity extraction

**Example application:**
> "We tracked citation rates across 1,200 SaaS landing pages in our BigQuery data this month. The pattern was the opposite of what most AEO advice suggests."

When the piece can pull from these, originality is high. The skill should ask before drafting whether to pull real data — and if the user declines, mark `[VERIFY: real number needed here]`.

### Source 2: Named client results with specifics

Specific before/after with numbers, named industries (or named clients if permission granted).

**Khadija's constraint:** Most of her impactful work is internal/confidential. This source is harder to use directly because client work can't be named.

**Alternative applications:**
- "A SaaS client in the fintech vertical went from 3% to 22% citation share in 90 days after restructuring their comparison pages."
- "In our work with [unnamed B2B SaaS client], we saw a clear pattern across 6 months..."
- "From what we're seeing across our customer base..." (collective observation)

The skill should NEVER fabricate specific client results. If a real anonymized case isn't available, use Source 1 or Source 3 instead.

### Source 3: Proprietary frameworks built from delivery work

IP developed by doing the work across multiple engagements.

**Khadija's available frameworks:**
- (Yet to develop her own named framework — this is high-leverage territory)
- The skill can support her building one over time
- Extensions of others' frameworks (Koray's topical authority, Mike King's Relevance Engineering) marked as extensions

**Example application:**
> "We've started calling the pattern 'citation bounded scope' — pages with clearly defined coverage cite at higher rates than pages trying to cover everything. It's a practical version of what Koray Gubur talks about as topical authority."

A piece that names and explains a framework is harder to replicate than a piece that lists tactics.

### Source 4: Hard-won operational insights

The things you learned the fifth time something failed before it worked. What you stopped recommending after watching it wreck a timeline. What you now include in every kickoff call because you learned the hard way.

**Khadija's available insights (from her actual work):**
- Years of seeing what works vs. doesn't in SEO/AEO/GEO
- Pattern recognition across multiple Wellows customer contexts
- Mistakes she's seen made (and not made) in implementing AEO strategies

**Example application:**
> "We used to recommend FAQ schema as part of every AEO checklist. After tracking citation rates for 6 months, we stopped. Here's what we recommend instead, and why."

This source is the most uniquely Khadija-shaped because it can't be replicated by anyone without her exact experience.

---

## The intro test (instant diagnostic)

Before scoring the piece, read just the opening line.

### Instant Originality = 1 signals

- "The X market is growing rapidly, with global revenue expected to reach $Y by 2027"
- "In today's evolving AI search landscape..."
- "AEO is the next frontier of search optimization..."
- "AI is changing the way we do search..."
- Any definition of the topic ("AEO is the practice of...")
- Any historical context that doesn't connect to a specific finding ("Search has evolved since Google launched...")

**If the intro is one of these, originality is 1 regardless of what comes later.** The writer is buying time because they have nothing specific to say.

### Strong intro signals

- A specific scene Khadija was in last week
- A specific number from her data
- A specific named source she's extending
- A specific contradiction in the data she's wrestling with

A strong intro signals immediately why this piece exists.

---

## The 4 missing elements that drop originality

These are common ways pieces fail despite seeming thorough. From Kateryna's analysis of an "expert guide" that scored 1/5 despite featuring interviews and case studies:

### 1. Describing choices instead of explaining how to make them

The piece outlines what approach the company picked but says nothing about *when* you'd choose that approach vs. an alternative, what signals tell you which path to take, or what trade-offs each involves.

**❌ "We use comparison tables in our content."**

**✅ "We use comparison tables when the buyer is in evaluation mode and needs to see attributes side-by-side. We skip them when the buyer is in education mode and a narrative explanation works better. The signal: are they asking 'which one' or 'what is'?"**

### 2. Documenting successful successes

Every methodology presented as effective. No "here are three approaches that seem logical and will wreck your timeline." The hard-won knowledge is what you stopped recommending.

**❌ "Schema markup is part of our AEO strategy."**

**✅ "We used to lead with schema markup. After tracking citation rates for 6 months, we stopped recommending it as the differentiator. It's table stakes, not the leverage point."**

### 3. Avoiding patterns

Including "every project is unique" or "results may vary." This raises an obvious problem: if everything is unique, the piece has nothing generalizable to teach.

**❌ "Every client's AEO needs are different, so we customize our approach."**

**✅ "Across 47 SaaS clients, we've seen the same issue appear in 34 of them: their comparison pages were optimized for ranking but not for citation. The fix worked for all 34."**

Expertise is what happens when you work with X clients and notice the same issue in Y of them. That pattern is what the reader can use.

### 4. Staying vague about constraints

"We adapted to client requirements" — one of the least informative sentences in B2B content.

**❌ "We tailor our approach to each client's industry."**

**✅ "If you're in healthcare or finance, here are the three non-negotiables that shape every AEO decision. Teams who ignore them spend six months walking it back."**

---

## How to score originality

### Score: 1

AI could have written this without knowing anything about Khadija's work. No proprietary data, no client specifics (even anonymized), no proprietary framework, no hard-won insight. The writer covered the topic comprehensively without saying anything specific.

### Score: 3

One original element is present but not fully deployed:
- A stat cited without analysis
- A client situation mentioned without specifics
- A framework described without the reasoning behind how it was built
- An insight stated but not supported with the specific experience that produced it

The piece has light originality (contrarian angle, distinctive voice, first-person account) but not the heavier sources.

### Score: 5

At least one of the 4 sources is present AND demonstrated. The piece makes claims only Khadija's track record can support. Remove her name and the piece would feel incomplete because the argument is built on her specific work.

---

## The "could a competitor publish this without changing a word" test

For every piece, ask: could a direct competitor (Profound, Peec, Otterly, xFunnel, Searchable) publish this exact piece, swapping in their name, and have it still work?

- **Yes →** Originality = 1. The piece has no positioning.
- **Mostly yes, with minor changes →** Originality = 3.
- **No, the piece is built on Khadija's/Wellows's specific experience or data →** Originality = 5.

If the answer is "yes," the piece is positioning-neutral and shouldn't ship as-is.

---

## Not every piece needs to be a research report

There are three weights of originality:

- **Light originality (Score 3):** A contrarian angle on common practice, a distinctive voice, a first-person account of solving a specific problem. Enough to differentiate from AI-generated fluff.
- **Medium originality (Score 4):** An interview with an internal expert, content built from operational reality rather than secondary sources.
- **Heavy originality (Score 5):** Proprietary research, a multi-year framework, analysis of 50+ engagements.

The skill should aim for **at least Light originality on every piece** and **Medium or Heavy when the substance supports it**.

A LinkedIn post can score 3 on originality with a sharp first-person observation. It doesn't need a full research report.

A Wellows blog post probably needs to hit at least 4 to be worth publishing.

A Medium long-form piece probably needs to hit 5 to justify the effort.

---

## When to push back on the user

If the user asks the skill to write something and the substance available won't support even Light originality, the skill should say so.

**Example response:**
> "The substance you've given me would produce a piece that scores 2 or below on Originality — it's covered everywhere on LinkedIn already. Want me to either (a) pull fresh data from Wellows BigQuery to anchor a real finding, (b) draft anyway with the [VERIFY: originality marker] gaps you'd need to fill, or (c) skip this one and pick a topic with better substance available?"

The skill's honesty here is what keeps it valuable.


---

# Appendix E: Key message — every piece needs one


A key message is the **one core idea** the reader should remember after reading the piece. It's the truth the writer wants to land.

There's a difference between content that accumulates information and content that's *about* something. The difference is whether there's a key message.

---

## What a key message is

The core idea, expressible in a single sentence, that the rest of the piece argues for.

### Examples

**Strong:**
- "Schema isn't the AEO differentiator — citation-shaped page structure is."
- "Most AEO advice is leftover SEO thinking that doesn't survive the citation test."
- "Pages that rank in Google and pages that get cited in AI engines aren't the same set."
- "Brand authority matters more in the AI era than in the SEO era because AI tools cite recognized brands."

**Weak (these are topics, not messages):**
- "Why AEO matters"
- "Tips for getting cited in AI search"
- "A guide to GEO"
- "Understanding AI search"

The strong examples make a claim. The weak ones cover a category.

---

## The 3-part structure of a key message

Every key message breaks down into:

1. **A central overall message** (the one-sentence argument)
2. **Supporting arguments** (2-4 reasons the message is true)
3. **Proofs backing up the message** (data, examples, evidence)

### Example breakdown

**Central message:** "Schema isn't the AEO differentiator — citation-shaped page structure is."

**Supporting arguments:**
1. Pages with schema and pages without schema cite at similar rates in our data.
2. Pages with explicit comparison tables (regardless of schema) cite at meaningfully higher rates.
3. Schema is table stakes for ranking but not predictive of citation.

**Proofs:**
1. Wellows BigQuery analysis of 1,200 SaaS landing pages
2. Specific named examples of pages that rank well in Google but never get cited
3. Reference to Koray Gubur's "topical bounded scope" concept as theoretical grounding

Every piece the skill produces should be decomposable this way. If it can't be, the piece doesn't have a real argument — it's just covering a topic.

---

## The 3 tests for a key message

### Test 1: Is the message believable?

The message must be supported by evidence. Break it into the 3-part structure above. If you can't articulate the supporting arguments and proofs, the message isn't believable.

### Test 2: Is the message easy to understand?

A single, simple, memorable idea beats a complex one with more arguments.

**Brexit example:** The Remain campaign had dozens of arguments (security, economy, trade, mobility, etc.). The Leave campaign had one: "Take back control." Simple won.

For Khadija's content: pick **one** message per piece. Don't try to make three points. Even if you have evidence for three, pick the strongest and structure the whole piece around it.

### Test 3: Does the message spread knowledge about the brand (or you)?

The key message should be one that's specifically yours to make — not one that could come from anyone in the industry. It should connect to:

- Wellows's positioning (citations, not just mentions; AEO is distinct from SEO)
- Khadija's positioning (technical practitioner with primary data access)
- The specific moat the piece is helping build

If the key message could be made by any of Wellows's competitors (Profound, Peec, etc.) verbatim, it's not differentiated enough. Sharpen it.

---

## When to figure out the key message

**Before drafting.** Always.

The key message should be decided at the outline stage. If the writer starts drafting without a key message, they end up with content that accumulates information rather than argues for something.

**Skill workflow:** Before drafting any piece, the skill should state the key message explicitly. If the user hasn't provided one, the skill asks: "What's the one-sentence argument this piece should make?"

If the user can't answer, the piece isn't ready to write.

---

## Putting the key message in the piece

The key message should be:

1. **Stated explicitly in the intro.** Within the first three paragraphs, the reader should know what the piece is arguing for. Don't bury it.
2. **Referenced throughout the body.** Each section should ladder back to the central message. If a section doesn't, it doesn't belong.
3. **Restated implicitly at the close.** The reader walks away knowing what they're supposed to think.

Per Kateryna's structure rules: "If a paragraph makes an interesting point that has nothing to do with the thesis, cut it."

---

## The formula

When a piece doesn't have a clear message yet, this formula generates one:

> "The root of [COMMON PROBLEM] often boils down to one thing: [COMMON APPROACH]. While most people chase [DESIRED OUTCOME] through [COMMON APPROACH], I believe the real focus should be on [YOUR APPROACH], because [insight into your audience's needs]. This shift leads to [DESIRED OUTCOME], not [COMMON PROBLEM]."

### Example using the formula

**Filled in:**
> "The root of many AEO problems is over-reliance on schema markup. While most marketers focus on getting cited through schema tactics, I believe the real focus should be on citation-shaped page structure — specifically comparison tables with named attributes — because that's what AI engines actually pull from. This shift leads to higher citation rates, not just more schema."

**Distilled into key message:**
> "Schema isn't the AEO differentiator — citation-shaped page structure is."

The formula is a tool for unlocking the message when you can't see it directly. Then distill into the single sentence.

---

## When the user hasn't given the skill a key message

If the user invokes the skill in Mode 1 (polish) without a clear key message in the draft, the skill should:

1. Read the draft and try to identify the implicit message
2. Surface it to the user: "I think the key message here is: 'X.' Want me to write the piece around that, or do you have a different message in mind?"
3. Only proceed after the user confirms the message

If the draft truly has no implicit message — it's just a topic dump — the skill should say so: "This draft is currently covering a topic without making an argument. I can either ask you a few questions to find the message, or you can give me one. I shouldn't polish a piece that doesn't have an argument to make."

---

## Common failure modes

### 1. Topic disguised as message

**Topic:** "Why AEO matters in 2026"

**Message:** "Most AEO advice doesn't survive the citation test — here's what does."

The first is a category. The second is a claim.

### 2. Multiple messages competing

A piece that tries to argue 3 things simultaneously argues none of them well. If the user gives multiple messages, the skill should suggest splitting into multiple pieces or picking the strongest one.

### 3. Message stated but never proven

The intro states the message, then the body wanders off into adjacent topics without supporting the claim. Per the Structure dimension: every paragraph must connect back to the controlling idea.

### 4. Message that's not specifically yours

"Content marketing is important for business growth" — true, but anyone could write a piece on it. The message must connect to Khadija's positioning or Wellows's positioning specifically.


---

# Appendix F: Anti-AI formatting — patterns that are banned


Formatting that signals ChatGPT-written content. The skill must never produce any of these patterns, regardless of how good the underlying substance is.

This file is a hard constraint, not a guideline. Output that contains any of the banned patterns gets rewritten before delivery.

---

## The "AI rhythm" (the most-banned pattern)

Every AI-written LinkedIn post has the same beat. The skill must never produce this rhythm:

```
[Punchy hook in 5-7 words]

[One-line claim]

[Second one-line claim]

[Pattern listing]:
- Single line
- Single line  
- Single line

[Bolded key takeaway]

[Question to bait engagement]
```

Concrete example of the banned pattern:

> B2B content is broken.
> 
> But it's not a writing problem. It's a strategy problem.
> 
> 👉 More blog posts.
> 👉 More LinkedIn carousels.
> 👉 More webinars.
> 
> Here's the uncomfortable truth:
> 
> **None. Of. This. Is. Working.**
> 
> Why?
> 
> 1. You're creating content for algorithms, not humans.
> 2. You're chasing trends, not building authority.
> 
> Agree?

This is the format Kateryna explicitly called out as "ChatGPT wrote that." The skill produces output that **cannot be mistaken for this format**.

---

## Specific banned moves

### Hook patterns to avoid

- "**[Bold statement.]**" alone on the first line
- "Here's why: [reveal]"
- "Here's the uncomfortable truth: [reveal]"
- "Most [people/marketers/founders] don't realize..."
- "Let me tell you about [topic]..."
- "3 years ago, I was [X]. Today, I am [Y]."
- "What if I told you..."
- "Forget everything you know about [topic]"

### Paragraph rhythm to avoid

- **Stacked single-sentence paragraphs.** 5+ one-sentence paragraphs in a row signals AI.
- **Period spacing for drama.** "This.\n\nIs.\n\nWhy.\n\nThat.\n\nMatters." — banned.
- **Verb-first bullets in lists.** Every bullet starting with the same verb form ("Build X. Create Y. Develop Z.") — banned.
- **Identical bullet length.** All bullets within 2 words of each other in length — signals templated output.

### Emphasis to avoid

- **Bolding the "key takeaway" of every section.** A bolded sentence per section signals AI scaffolding.
- **ALL CAPS for emphasis** outside of acronyms.
- **Italics on words that don't need italics.** ("*This* matters" / "*Truly* understanding...")
- **Multiple emojis per paragraph** as decoration.
- **👉 or → or ⭐️ as bullet leaders.** Banned.

### Lists to avoid

- **3-item lists where each item is identical structure.** Tricolons-of-three banned.
- **"5 Ways to..." or "7 Things..." structure for posts.** Number-prefix listicle openers signal SEO content, not voice content.
- **Bullets that could just be sentences.** If 3 bullets each contain a full thought, they should be sentences in a paragraph.

### Transitions to avoid

- "Now that we've covered X, let's look at Y" — cut entirely
- "Moving on to..." — cut
- "Let's dive into..." — cut
- "First... Second... Third..." — banned as ordering scaffold
- "But here's the thing:" — cut
- "Here's why this matters:" — cut

### Closes to avoid

- "Save this post."
- "Share if you agree."
- "What's your take? Comment below 👇"
- "Agree or disagree?"
- "DM me if you want to chat."
- "P.S. Don't forget to..." (the postscript-as-CTA pattern)
- "🔁 Repost this if it resonated."

---

## The "retrieval-ready" trap

Kateryna explicitly warns against optimizing formatting purely for AI/LLM consumption. The pattern:

- FAQ sections stuffed in everywhere
- Q&A structures that aren't natural to the topic
- Heavy schema markup as the main structural decision
- Every H2 phrased as a question

**The rule:** Formatting's first job is to keep human readers on the page. If formatting only exists to feed LLMs, the piece has lost the humans.

The skill should never recommend or produce content that's structurally optimized for AI at the cost of human readability.

---

## What works (the inverse)

To make the banned list useful, here's what good formatting looks like:

### Good paragraph rhythm

- Most paragraphs: 2-3 sentences with varied length
- Occasional single-sentence paragraph for emphasis (1-2 per piece)
- Long flowing paragraph allowed when an argument needs continuous build
- The shape of the piece varies — not uniform blocks

### Good emphasis

- Bold used 0-2 times per piece, on genuinely load-bearing phrases
- No italics unless they're doing real work (titles, foreign words, vocal stress)
- Em-dashes only when structurally load-bearing
- No emojis in prose (✅/❌ inside lists only if the user content uses them)

### Good lists

- Bullets only when the content is genuinely list-shaped
- Variable bullet length when the content varies
- No artificial "5 ways to X" framing
- Numbered lists only when sequence matters

### Good transitions

- Implicit transitions (the next paragraph just starts)
- Connector phrases that link ideas: "This is why X..." / "The reason is..."
- No announcing what comes next ("Now let's look at...")

### Good closes

- Honest acknowledgment of what's unknown
- Signal of next research or next post
- Substantive invitation (not bait)
- Sometimes just stopping when the substance ends

---

## Format must vary by content type

This is one of Kateryna's strongest rules. A case study shouldn't look like an article. A landing page shouldn't look like a blog post. A LinkedIn carousel shouldn't be a blog broken into slides.

### Article format
- Opens with TL;DR box (or a specific scene)
- Headers and paragraphs
- Expert quotes as callouts
- Section breaks have visual weight

### Case study format
- Opens with stats panel (numbers up front)
- "About the client" with logos
- Challenge → Solution → Result structured as columns, not paragraphs
- Numbers throughout

### Landing page format
- Broken into clear sections that signal layout intent
- Hero, problem, solution, proof, CTA — each section visibly distinct
- Designed to be designed, not just written

### LinkedIn post format
- Hook in first 2 lines (the "see more" cutoff)
- Body uses varied paragraph rhythm
- Close avoids engagement bait
- Hashtags 2-4, no stuffing

### Newsletter format
- Personal opener (often a scene)
- "In today's newsletter" box with 2-4 items
- Body sections with H2s
- Personal close (Kateryna's "see you next week")

The skill should ask which format applies and adjust accordingly. Never use one format's structure for another content type.

---

## How to use this reference

Before delivering any output, the skill silently checks:

- [ ] No "AI rhythm" pattern (punchy hook → stacked singles → bolded takeaway → bait close)
- [ ] No banned hook patterns
- [ ] No banned emphasis patterns
- [ ] No banned list patterns
- [ ] No banned transitions
- [ ] No banned closes
- [ ] No retrieval-ready over-optimization
- [ ] Format matches content type (article ≠ case study ≠ landing page)

If any check fails, fix before delivering. This is non-negotiable — banned patterns get rewritten regardless of how good the substance is.

---

## The 3 visual tests

Quick diagnostics for whether formatting is working:

### Test 1: Cover the content, look at the shape

Could you tell what kind of piece it is (article / case study / landing page / LinkedIn post) from the visual shape alone? If yes, formatting is doing its job.

### Test 2: Scan the bolded words

If you read only the bolded text, does it tell the gist of the piece? If yes, the bolding is doing real work. If the bolding feels random, remove it.

### Test 3: Look at the line count per paragraph

Count the lines in each paragraph. If every paragraph is 1-2 lines, the piece is AI-rhythm. If every paragraph is 5-8 lines, the piece is unreadable. Variation is required.

---

## What to flag in the metadata

When the skill detects banned patterns it had to fix:
- Note what it rewrote (e.g., "Removed bolded key-takeaway pattern from section 3")
- Note any places where the user's draft pushed toward the AI rhythm and the skill diverged
- Don't lecture the user — just note it

When the skill detects that the format doesn't match the content type:
- Suggest the appropriate format
- Ask if the user wants it restructured

The skill is firm on banned patterns but conversational about it. Not "your draft was bad" — "I rewrote section 3 because the bolded takeaway pattern reads as AI."


---

# Appendix G: POV development — building a distinctive point of view


Most B2B content sounds like this: *"Marketing is important. There are many tactics. We pick the best for you."*

No opinion. No perspective. No reason to remember. Without a strong POV, content blends in. The skill's job is to make sure every piece has a POV that's specifically Khadija's or Wellows's — not a category-level observation.

---

## What a POV is

A POV (point of view) is a stand the writer takes. It's not a topic; it's a position on a topic. It requires picking an enemy — not always a competitor, but a belief, norm, or way of doing things that you reject.

### Examples of POVs that work

**Geoffrey Moore's POV (Crossing the Chasm):** "Product adoption isn't a smooth curve. There's a chasm where startups fail." Enemy: the assumption that adoption is gradual.

**James Clear's POV (Atomic Habits):** "Small consistent habits beat big goals." Enemy: the goal-setting orthodoxy.

**HubSpot's POV (inbound marketing):** "Attract customers with valuable content, not cold calls and spam." Enemy: traditional outbound interruption marketing.

**Basecamp's POV:** "Bigger isn't always better. We target small businesses on purpose." Enemy: the assumption that B2B SaaS must chase enterprise.

**Zmist & Copy's POV:** "Investing in head-to-head SEO is pointless if your brand means nothing." Enemy: meaningless marketing optimization without positioning.

### What a POV is not

- "Marketing is important for growth" — true but unpositioned
- "We pick the best strategy for you" — service description, not POV
- "Content marketing has many benefits" — category observation, not stance
- "We're an industry leader in X" — claim, not POV

---

## The 4-step POV framework

When the user is drafting something but doesn't have a clear POV yet, the skill applies this framework.

### Step 1: Define an enemy

What's a common practice in the industry that bothers Khadija? What does she see people doing that she thinks is wrong?

**For AEO/GEO specifically, candidate enemies:**
- The assumption that AEO is just SEO with different keywords
- The schema-stuffing approach to AI search
- The "AI search is dead" overcorrection
- The keyword-volume-obsessed planning model
- The "publish more content" reflex
- The treating-mentions-as-citations mistake
- The chasing-engagement-not-citations metric

The enemy should be specific. "Bad content" is not an enemy. "Schema-as-AEO-tactic" is.

### Step 2: Show the problem

How is the common practice hurting the audience? What does it cost them in real terms?

**Example:** If the enemy is "schema-as-AEO-tactic" —
- The audience spends time adding FAQ schema expecting citation rate to go up
- Citation rate doesn't go up because schema isn't predictive
- They blame the AI engines or AEO theory rather than recognizing the tactic doesn't work
- They miss the real leverage points (citation-shaped content structure)

### Step 3: Show the better way

Create explicit contrast between the common approach and the proposed approach.

**Example:**

| Common approach | The better way |
|---|---|
| Add FAQ schema everywhere | Build citation-shaped content structures |
| Optimize for ranking | Optimize for being a primary source |
| Chase keywords | Build context AI engines can trust |

The contrast must be specific. "Stop doing X, start doing Y" where both X and Y are concrete.

### Step 4: Back it up with proof

Examples, data, results that prove the alternative works.

**Sources Khadija can pull from:**
- Wellows BigQuery (citation rates, page patterns, engine-specific data)
- GSC data for wellows.com
- Ahrefs Brand Radar (industry-wide citation patterns)
- Specific named brands cited in AI engines (publicly observable)

A POV without proof is just an opinion. The skill should never produce a POV piece without at least one source of evidence.

---

## The POV formula

When the user can't articulate a POV directly, this template generates one:

> "The root of [COMMON PROBLEM] often boils down to one thing: [COMMON APPROACH]. While most people chase [DESIRED OUTCOME] through [COMMON APPROACH], I believe the real focus should be on [YOUR APPROACH], because [insight into your audience's needs]. This shift leads to [DESIRED OUTCOME], not [COMMON PROBLEM]."

### Worked example for Khadija

Filled in:
> "The root of many AEO problems is over-reliance on schema markup. While most marketers focus on getting cited through schema tactics, I believe the real focus should be on citation-shaped page structure — comparison tables with explicit attributes, named entities, bounded scope — because that's what AI engines actually pull from. This shift leads to higher citation rates, not just more schema."

Then distill to one sentence:
> "Schema isn't the AEO differentiator — citation-shaped page structure is."

That's the POV. The piece argues for it.

---

## When the user pushes back: "I don't want to take a strong stand"

Per the earlier conversation, Khadija is moderately position-taking — she sticks to things she's sure of. The POV framework can accommodate this.

### Lower-risk POV moves

- **Predictive POV:** "I think X is going to become the standard within 18 months. Here's the leading indicator."
- **Methodological POV:** "Here's how we test for citation potential — and here's why most teams aren't testing for it."
- **Definitional POV:** "What most people are measuring as 'AI visibility' isn't citation. Here's the distinction."
- **Observational POV:** "In our data, the pattern that predicts citation isn't what most AEO advice focuses on."

These are POVs that:
- Take a stand (otherwise they wouldn't be POVs)
- Don't require Khadija to be reckless
- Connect to her actual position (technical practitioner with primary data)
- Can be defended without claiming more authority than she has

### Higher-risk POV moves (use sparingly)

- **Direct contradiction:** "Most AEO advice is wrong about X."
- **Industry critique:** "The way SEO consultants are rebranding as AEO experts is misleading clients."
- **Named callout:** "Brand X's recent post about Y misses the key point."

These can work but require Khadija to be willing to defend in public. Per her earlier answer, she's cautious here. The skill should default to the lower-risk POV moves and flag higher-risk ones with `[RISK: this is a strong public stance — confirm before publishing]`.

---

## "I don't convince people to choose me — people who work with my competitors don't work with me"

Kateryna's CMO quote captures the underlying logic: a strong POV is self-selecting. It pre-qualifies the audience.

If Khadija's POV is "schema isn't the AEO differentiator," she's pre-qualifying readers:
- People who agree → become customers more easily
- People who disagree → wouldn't have been a good fit anyway

The skill should treat POVs as filters, not as sales pitches. The goal isn't "convince everyone." It's "be clearly findable by the right people, clearly avoidable by the wrong people."

---

## How to use this reference

### Mode 1 (polish): Check if the draft has a POV

Before polishing, check whether the draft is making a stand or just covering a topic.

- If yes → polish in Khadija's voice while preserving the POV
- If no → tell the user the draft doesn't have a POV yet, surface what the implicit POV might be, ask if they want to add one before polishing

### Mode 2 (generate): Demand a POV before drafting

Before generating, ask: "What's the stand this piece is taking? What's the enemy?"

If the user gives a topic without a POV, apply the formula or ask the 4-step framework questions:
1. What common practice in this area bothers you?
2. How does it hurt the audience?
3. What should they do instead?
4. What proof do you have?

If the user can't answer step 4, suggest pulling data from BigQuery/Ahrefs/GSC, or pick a different topic where proof is available.

---

## What a POV looks like in the final output

A piece with a strong POV is identifiable from the first paragraph. The reader knows what stance is being argued. The body builds the case. The close reinforces it.

A piece without a POV reads like an industry report — informative but unmemorable.

The skill should be able to summarize the POV of any piece it produces in one sentence. If it can't, the piece doesn't have one, and the skill should flag this in the quality gate.


---

# Appendix H: Context Engine — three content frameworks for the AI era


The Context Engine is Kateryna Abrosymova's named methodology for content that builds brand authority in the AI search era. Three frameworks, three funnel stages, all anchored in proprietary substance rather than keyword optimization.

This reference adapts the Context Engine for Khadija's specific context: Wellows is a B2B SaaS in the AEO/GEO category, and Khadija writes from inside the operator role rather than the agency owner role.

---

## The underlying premise

The keyword-led content era is over. To show up in AI tools (ChatGPT, Perplexity, Gemini, Claude, Google AI Overviews), content needs context — not optimization.

**SEO thinking:** How do I rank for "AEO software"?
**GEO thinking:** How do I become the reference point when AI discusses AEO?

These require different content. Keyword-optimized content makes you findable. Context-rich content makes you cited.

**SEO content:** "10 Best AEO Tools for 2026"
**GEO content:** "How SaaS Teams with Limited Citation Tracking Budget Should Approach AEO"

The Context Engine produces the second kind.

---

## Why this matters for Khadija

The skill's output should consistently produce **product-led content** — content where Khadija's product (or methodology, or POV) is built into the argument, not mentioned at the end.

Generic content can be replicated by anyone. Product-led content can't.

- Anyone can rewrite "Ultimate Guide to AEO." A competitor blog can publish a near-identical version tomorrow.
- But nobody else can write Khadija's specific Wellows BigQuery analysis. Nobody else can write the operational pattern she's seen across Wellows customers. Nobody else can name a proprietary framework she's developed.

This is the moat. The skill should produce content that lives inside the moat.

---

## Framework 1: Teach & Tilt (TOFU)

**Purpose:** Educational content that challenges assumptions and promotes a unique POV.

**What it's NOT:** "What is AEO?" / "Beginner's guide to GEO" / "Why AI search matters" — these are category-level educations anyone could write.

**What it IS:** Educational content that takes a stand on how readers should think about the category.

### Structure

1. **Identify a common assumption** in the AEO/GEO field (or in marketing generally).
2. **Challenge it specifically.** Not "this is wrong" — "here's why this assumption breaks under specific conditions."
3. **Offer the corrected framework.** Named if possible.
4. **Anchor in proof.** Wellows data, named sources, real examples.

### Examples for Khadija

- "Most AEO advice treats schema as the differentiator. Here's why citation-shaped structure matters more."
- "The 'rank in Google → get cited in AI' assumption breaks for 92% of pages we've tracked."
- "What 'AI visibility' usually measures isn't citation. Here's why the distinction matters."
- "GEO isn't AEO with a new label. Here's the structural difference."

### Voice notes

Teach & Tilt content uses:
- The reverse-engineering opener ("I checked the data...")
- The contrarian observation opener ("Most AEO advice is wrong about X...")
- The named-source opener ("Koray talks about topical authority. Here's how it shows up in AEO...")

It avoids:
- Pure how-to listicles
- Definitions of the category
- Industry-evolution narratives

### Quality gate target

Teach & Tilt pieces should hit at least 23/30 on the Content Quality Score. They need:
- A clear POV (Originality ≥ 3)
- A single controlling idea (Structure ≥ 4)
- Proof from Khadija's actual work or named sources (Originality ≥ 4)
- The reader walks away thinking "only Khadija/Wellows would say it that way"

---

## Framework 2: See It Solved (MOFU)

**Purpose:** How-to content that shows methodology in action.

**What it's NOT:** Generic how-to guides that walk through tactics. "10 Ways to Improve AEO" with surface-level advice anyone could produce.

**What it IS:** Specific how-to content built around Khadija's methodology, with real examples of the methodology applied.

### Structure

1. **Define the specific problem** being solved (not a category — a specific situation).
2. **Walk through the methodology** Khadija/Wellows uses to solve it.
3. **Show it applied** in a real or anonymized case.
4. **Note what doesn't work** and why (the hard-won insight piece).

### Examples for Khadija

- "How we test whether a Wellows customer's content is citation-shaped: the 4-question framework."
- "Diagnosing 'ranks well but doesn't get cited' — step-by-step using Wellows BigQuery and GSC."
- "How we restructure comparison pages for citation: the before/after process."
- "When to recommend FAQ schema (and when to skip it): our decision framework."

### Voice notes

See It Solved content uses:
- Methodology framing ("Here's how we approach this...")
- Sequential structure (steps, but tied to a specific case, not abstract)
- Specific examples with named situations
- Hard-won insights ("We used to do X. We stopped because...")

It avoids:
- Generic "best practices" lists
- Tutorials without a worked example
- Tactical advice without methodology

### Why this is different from a generic how-to

A generic how-to: "5 ways to optimize for AEO." Anyone can publish this.

A See It Solved piece: "How we diagnose 'ranks but doesn't get cited' problems — the 3-step Wellows method, applied to a fintech SaaS client's pricing page."

The second one demonstrates the methodology rather than describing it. That's the difference.

### Quality gate target

See It Solved pieces should hit at least 25/30. They need:
- Strong methodology (Originality ≥ 4 via Source 3: proprietary frameworks)
- Specific case demonstration (Originality ≥ 4 via Source 2: named results)
- Clear sequence (Structure ≥ 5)
- The reader walks away knowing how to apply the methodology themselves

---

## Framework 3: Results-Forward (BOFU)

**Purpose:** Proof content that leads with outcomes.

**What it's NOT:** Traditional case studies that start with "About the Client" and walk through context before getting to results. These bury the proof.

**What it IS:** Case studies (or proof-driven content) where the result is front-and-center, and the body explains how it was achieved.

### Structure

1. **Lead with the outcome.** Numbers, before/after, named result.
2. **Specify the starting condition.** Who was the customer? What was the problem?
3. **Walk through what was done.** The methodology in action.
4. **Explain what made it work.** The specific insight or decision.
5. **Generalize for the reader.** What pattern can they apply?

### Examples for Khadija

- "From 4% to 18% citation share in 90 days: how we restructured one SaaS client's content for AEO."
- "We tracked one Wellows customer's citation rate before and after restructuring their comparison pages. The before/after surprised us."
- "Why one client's AEO strategy worked while another's stalled: a comparison."

### Voice notes

Results-Forward content uses:
- Numbers in the headline and the opening
- Named details (industry, role, situation)
- Methodology references back to See It Solved frameworks
- Honest acknowledgment of what didn't work or what's still being tested

It avoids:
- Hype framings ("incredible results," "10x growth")
- Vague generalizations ("clients see strong results")
- Cherry-picked numbers without context
- Case studies that read like marketing pieces

### Constraint for Khadija

Khadija's actual client work is mostly confidential. This means full Results-Forward case studies may not be possible without permission. The skill should:

- Default to anonymized framings ("a SaaS customer in fintech")
- Use specific numbers when available even if names are redacted
- Flag any piece that would name a customer with `[CHECK: customer permission needed]`
- Suggest alternative framings that work without naming (aggregated patterns across customer base)

### Quality gate target

Results-Forward pieces should hit at least 26/30. They need:
- Strong proof (Originality ≥ 5)
- Clear before/after (Structure ≥ 4)
- Specific stakes (Engagement ≥ 4)
- Methodology connection back to See It Solved

---

## How the three frameworks chain

The Context Engine works as an interconnected system:

1. **Teach & Tilt** establishes the POV. ("Schema isn't the differentiator. Citation-shaped structure is.")
2. **See It Solved** shows the methodology that operationalizes the POV. ("Here's how we test for citation-shaped structure.")
3. **Results-Forward** proves the methodology works. ("Here's what happened when we applied this framework to a SaaS customer's comparison pages.")

Each piece in the system reinforces the others. A reader who reads all three sees: a clear POV, a methodology to apply, and proof it works. That's the kind of content that earns AI citations because it builds a coherent context.

### Content calendar implication

For Wellows content (or Khadija's personal brand):
- Roughly 40-50% Teach & Tilt (the POV-building work)
- Roughly 30-40% See It Solved (the methodology demonstration)
- Roughly 15-25% Results-Forward (the proof, constrained by what's shareable)

This isn't rigid — the actual mix depends on what substance is available. But the skill should flag if too much content is being produced in one framework while the others are neglected.

---

## What this framework refuses to produce

The Context Engine deliberately rejects:

### 1. Keyword-stuffed copycat content

Pages that exist because a keyword has volume, not because Khadija has something specific to say. The skill won't produce content where the keyword is the substance.

### 2. "Ultimate Guide to X" content

These are SEO-era artifacts. They cover everything and say nothing. Per Kateryna's structure rules, they have coverage but no controlling idea.

### 3. Feature-focused tutorials

"How to use [Wellows feature]" — only useful for existing customers. Not Context Engine content.

### 4. Industry-evolution posts

"The history of search optimization" / "Where AI search is heading" — too category-level. Not anchored in Khadija's specific work.

### 5. List posts without methodology

"10 best AEO tools" / "5 ways to improve citation rate" — the skill will refuse these unless the list is grounded in actual methodology and named entities.

---

## How to use this reference

### When the user asks for a piece, the skill identifies which framework fits:

- **Educational, POV-driven** → Teach & Tilt
- **Methodology demonstration** → See It Solved  
- **Proof / case study** → Results-Forward

If the user's request doesn't fit any of these (e.g., they want a tactical listicle), the skill suggests reshaping the request into Context Engine territory.

### When generating content, the skill asks:

1. Which framework does this fit?
2. What's the proprietary substance (data, methodology, or proof)?
3. How does this piece connect to other pieces in the system?

### When polishing existing drafts, the skill checks:

1. Does the draft fit one of the three frameworks?
2. If yes, does it execute that framework well? (Apply the framework's structure check.)
3. If no, what would it take to bring it into Context Engine territory?

---

## A note on building Khadija's own Context Engine

Eventually, Khadija may develop her own version of the Context Engine — a named methodology specific to AEO/GEO at the practitioner level. The skill can support this incrementally.

Pieces that build toward a named methodology should be flagged: "This piece is contributing to your framework on [topic]. Consider naming it explicitly as part of an emerging methodology."

When enough pieces exist that connect to a common methodology, the skill can suggest publishing a "methodology overview" post that names and explains the framework — the way Kateryna did with the Context Engine itself.
