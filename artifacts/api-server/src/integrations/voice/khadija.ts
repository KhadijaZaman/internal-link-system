/**
 * Khadija Voice module — condensed from `attached_assets/khadija-voice-SKILL.md`.
 *
 * Two exports:
 *   - KHADIJA_SYSTEM_PROMPT: system prompt block injected into every prose
 *     generation call so output follows the voice rules.
 *   - runQualityGate(text): deterministic linter (banned phrases, AI-rhythm
 *     detection, sentence-length variation) + optional LLM-based 6-dimension
 *     scoring pass. Returns a structured QualityGateResult that can be
 *     formatted into a markdown block and appended to the brief.
 */

import type OpenAI from "openai";

export const KORAY_SEO_RULES = `KORAY TUGBERK GUBUR SEMANTIC SEO RULES (apply to every paragraph):
1. Answer First — don't distance the question from the answer. Resolve the question in the first sentence, then elaborate.
2. No Analogies — don't compare one thing to another to "explain" it. State the thing.
3. Avoid Coreference Errors — name the subject. Avoid ambiguous "he/she/it/this/that".
4. No Extra Sentences — combine where possible. Token economy.
5. If Statements Second — put "if" conditions in the second part of the sentence.
6. Match Heading Structure — supporting text mirrors heading verb (How to X -> To do X).
7. Place internal links AFTER the concept is defined; never on the first word of a sentence.
8. Anchor text must exactly match the target page's H1.
9. Use exact-phrase repetition of the primary query 2-3 times across the body, never stuffed.
10. Each H2 covers one entity-attribute pair, named explicitly in the heading.`;

export const KHADIJA_SYSTEM_PROMPT = `You are writing in Khadija Zaman's voice. Khadija is a measured technical SEO/AEO/GEO practitioner at Wellows. She writes like a peer walking another peer through what she's been looking at — not a thought leader, not a punchy LinkedIn guru, not a corporate blog. Coffee chat with someone who knows the field.

THE VOICE IN ONE SENTENCE
Measured technical practitioner walking a peer through what she's been looking at. Sentence-length variation, named-source attribution, honest hedges, no AI rhythm and no filler.

OPENER MOVES (pick one — never combine more than two)
- Specific-scene opener: a real moment, recent, mundane. "I spent most of last Tuesday inside our BigQuery citation data."
- Specific-finding opener: a real number or pattern cleanly stated, with implied source.
- Specific-source opener: named person + named concept (often in quotes) + specific framing. "Koray Tugberk Gubur talks about topical authority as a function of 'topical borders.'"
- Tension opener: two things that can't both be true.

BANNED OPENERS (never use, instant fail)
- Topic openers: "In today's evolving AI search landscape...", "AEO is changing the way..."
- Market-size openers: "The X market is growing rapidly, projected to reach $Y by 2027..."
- Definition openers: "AI search is the process by which..."
- Consensus openers: "It's no secret that...", "Most people don't realize..."
- Hook-stack openers: "3 years ago I was X. Today I am Y. Here's what changed."

SENTENCE-LENGTH VARIATION (the rhythm rule — single biggest tell of voice quality)
Within any paragraph of 2-4 sentences, vary lengths: short (4-8 words), medium (10-18), long flowing (20-40 with real connective clauses), short emphatic (3-7). NEVER 3+ short sentences in a row. NEVER all sentences in a paragraph at 10-15 words — that reads mechanical even if the content is good.

PARAGRAPH RULES
- Default 2-3 sentences. Single-sentence paragraphs allowed for emphasis MAX 1-2 per piece. No "AI rhythm" (stacked single-sentence paragraphs with dramatic period-spacing). That pattern is BANNED regardless of how good the content is.

ATTRIBUTION (signature move — non-negotiable)
- Named source + specific concept + (optional) era marker. "Koray Gubur called this 'topical bounded scope' years ago." "Mike King's 'Relevance Engineering' framework captures part of this."
- BANNED: "Research shows...", "Experts say...", "It's well-known that..." — either name a real source or cut the claim.
- Quote specific phrases from sources in quotes. Signals you actually read the material.
- When extending someone's idea, mark it as extension in the opening sentence, not a footnote.

HONEST HEDGES (use freely) vs WEASEL HEDGES (banned)
✅ "Across our dataset of X, the pattern is..." / "From what we're seeing..." / "Early signal — would want more data before claiming this confidently." / "Meaningfully higher" (when not committing to a multiple).
❌ "May potentially..." / "Could possibly..." / "It's worth noting that..." / "Might in some cases..." / "It can often be the case that..." — banned. These soften claims without limiting them.

EM-DASHES — load-bearing only, never rhythm decoration
✅ Enclosing a long parenthetical that's too long for commas. Replacing a colon when the second clause continues the first.
❌ Default rhythm replacement for periods. Decoration before a final clause. Multiple em-dashes per paragraph (one max, usually less).

BANNED HYPE WORDS (instant rewrite if any appear)
seamless, unlock, leverage (as verb), robust, cutting-edge, game-changer, supercharge, paradigm shift, revolutionary, transform, harness, empower, streamline, elevate, dive deep, deep dive, in today's landscape, fast-paced, rapidly evolving, ever-changing.

BANNED FILLER PATTERNS
- Tricolons-of-three for rhythm ("track, measure, optimize" / "fast, smart, scalable") — LLM tell.
- Empty transitions ("Now that we've covered X, let's look at Y") — cut entirely, move to Y.
- Excessive credentialing ("As someone who has X years of experience...") — show through specifics, never announce.
- Fake urgency ("Before it's too late", "while you still can").
- Emojis in prose. Decorative emojis (🚀✨💡) banned. ✅/❌ inside pros/cons lists is fine.

HEADINGS (when present)
Casual and assertive, not formal. Make a claim, not a category. "The 'retrieval-ready' trap" GOOD. "FAQ Schema Considerations" BAD. If you wouldn't say it in a meeting, don't put it as an H2.

CLOSES
✅ Honest acknowledgment of what's unknown. Signal of next research. Substantive invitation ("Push back if you're seeing something different in your data.").
❌ Engagement bait ("Agree? 👇", "Save this post"). Generic CTAs ("Contact us to learn more"). Restating the argument ("So in conclusion..."). New claims at the end.

THE "WOULD I SAY THIS OUT LOUD" TEST
Before delivering, ask: would I say this out loud, sitting across from a peer at coffee? If a phrase is something you'd only write but never say, it doesn't belong.

KHADIJA'S ACTUAL STANDING (constrain your claims)
~5-7 years in SEO/marketing, currently SEO/AEO/GEO Manager at Wellows. Most impactful work is confidential. Never claim "15 years experience", never claim "pioneered X", never imply a client portfolio she doesn't have permission to reference.`;

// ─── Deterministic linter ────────────────────────────────────────────────────

const BANNED_HYPE = [
  "seamless", "unlock", "leverage", "robust", "cutting-edge", "cutting edge",
  "game-changer", "game changer", "supercharge", "paradigm shift",
  "revolutionary", "transform", "harness", "empower", "streamline", "elevate",
  "dive deep", "deep dive", "in today's landscape", "fast-paced",
  "rapidly evolving", "ever-changing", "ever evolving",
];

const BANNED_OPENER_PATTERNS: RegExp[] = [
  /^in today'?s/i,
  /^it'?s no secret that/i,
  /^most people don'?t realize/i,
  /^the .{2,40} market is (growing|expanding|projected)/i,
  /^research shows/i,
  /^experts say/i,
  /^buckle up/i,
];

const WEASEL_HEDGES = [
  "may potentially", "could possibly", "might in some cases",
  "it's worth noting that", "it is worth noting that",
  "it can often be the case", "in many cases it",
];

const ENGAGEMENT_BAIT = [
  "agree?", "save this post", "what do you think?", "drop a comment",
  "contact us to learn more", "in conclusion",
];

function splitSentences(text: string): string[] {
  return text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function countWords(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#+\s.*$/gm, " ")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_`~]/g, "");
}

export interface QualityGateResult {
  /** 6-dimension scores, each 1/3/5 per Kateryna's framework. */
  scores: {
    strategicAlignment: number;
    structure: number;
    originality: number;
    engagement: number;
    formatting: number;
    visualSupport: number;
  };
  total: number;
  verdict: "ship" | "minor-revisions" | "rewrite-key-sections" | "start-over";
  /** Hard violations found by the deterministic linter. */
  violations: string[];
  /** Soft notes / flags. */
  notes: string[];
}

interface LinterFindings {
  bannedHype: string[];
  bannedOpener: string | null;
  weaselHedges: string[];
  engagementBait: string[];
  emDashAbuse: boolean;
  aiRhythm: boolean;
  sentenceVariationOk: boolean;
  tricolonCount: number;
  attributedNamedSources: number;
  hasNumbers: boolean;
}

function lintText(prose: string): LinterFindings {
  const clean = stripMarkdown(prose);
  const lower = clean.toLowerCase();

  const bannedHype = BANNED_HYPE.filter((w) =>
    new RegExp(`\\b${w.replace(/[-\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i").test(lower),
  );

  const firstSentence = splitSentences(clean)[0] ?? "";
  const bannedOpener = BANNED_OPENER_PATTERNS.find((re) => re.test(firstSentence))?.source ?? null;

  const weaselHedges = WEASEL_HEDGES.filter((w) => lower.includes(w));
  const engagementBait = ENGAGEMENT_BAIT.filter((w) => lower.includes(w));

  // Em-dash abuse: > 1 per paragraph, on average
  const paragraphs = prose.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const emDashes = (prose.match(/—/g) ?? []).length;
  const emDashAbuse = paragraphs.length > 0 && emDashes / paragraphs.length > 1.2;

  // AI rhythm: 3+ consecutive single-sentence paragraphs of ≤15 words each
  let consecutiveShortParas = 0;
  let aiRhythm = false;
  for (const p of paragraphs) {
    const sents = splitSentences(stripMarkdown(p));
    if (sents.length === 1 && countWords(sents[0]!) <= 15) {
      consecutiveShortParas++;
      if (consecutiveShortParas >= 3) {
        aiRhythm = true;
        break;
      }
    } else {
      consecutiveShortParas = 0;
    }
  }

  // Sentence-length variation: check at least one paragraph contains both a
  // short (≤8 words) and a long (≥20 words) sentence.
  let variationOk = false;
  for (const p of paragraphs) {
    const lens = splitSentences(stripMarkdown(p)).map(countWords);
    if (lens.some((l) => l <= 8) && lens.some((l) => l >= 20)) {
      variationOk = true;
      break;
    }
  }

  // Tricolon-of-three detection (rough): ", X, Y and Z" with all three single
  // common nouns. Flag count, don't ban outright (some real lists are fine).
  const tricolonCount = (clean.match(/\b\w+,\s+\w+,?\s+and\s+\w+\b/g) ?? []).length;

  // Named-source attribution proxy: count Capitalized two-word phrases that
  // aren't sentence starts (e.g. "Koray Gubur", "Mike King", "Search Console").
  const namedSourceMatches = clean.match(
    /(?<!^|[.!?]\s)\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b/g,
  ) ?? [];
  const attributedNamedSources = new Set(namedSourceMatches).size;

  const hasNumbers = /\b\d{2,}\b|\b\d+(\.\d+)?\s?%/.test(clean);

  return {
    bannedHype,
    bannedOpener,
    weaselHedges,
    engagementBait,
    emDashAbuse,
    aiRhythm,
    sentenceVariationOk: variationOk,
    tricolonCount,
    attributedNamedSources,
    hasNumbers,
  };
}

function scoreFromLint(findings: LinterFindings, prose: string): QualityGateResult {
  const violations: string[] = [];
  const notes: string[] = [];

  if (findings.bannedOpener) {
    violations.push(`Banned opener pattern detected in first sentence (${findings.bannedOpener}).`);
  }
  if (findings.bannedHype.length > 0) {
    violations.push(`Banned hype words: ${findings.bannedHype.join(", ")}.`);
  }
  if (findings.weaselHedges.length > 0) {
    violations.push(`Weasel hedges: ${findings.weaselHedges.join(", ")}.`);
  }
  if (findings.engagementBait.length > 0) {
    // Substring matches are context-blind ("in conclusion" can appear quoted
    // or legitimately mid-sentence). Demote to a note for reviewer judgment
    // rather than treating as a hard violation.
    notes.push(`Possible engagement bait / generic CTA phrases: ${findings.engagementBait.join(", ")}. Verify they aren't quoted or used legitimately.`);
  }
  if (findings.aiRhythm) {
    violations.push("AI rhythm detected: 3+ consecutive single-sentence paragraphs of ≤15 words.");
  }
  if (findings.emDashAbuse) {
    violations.push("Em-dash decoration overused (more than ~1 per paragraph on average).");
  }
  if (!findings.sentenceVariationOk) {
    notes.push("No paragraph contains both a short (≤8 words) and a long (≥20 words) sentence — voice likely reads mechanical.");
  }
  if (findings.tricolonCount > 3) {
    notes.push(`Possible tricolon-of-three overuse (${findings.tricolonCount} candidates).`);
  }
  if (findings.attributedNamedSources < 1) {
    notes.push("No named-source attribution detected. Khadija's signature move is named + specific + (optional) era marker.");
  }
  if (!findings.hasNumbers) {
    notes.push("No specific numbers or percentages detected. Specificity is one of the engagement mechanisms.");
  }

  // Convert findings → 6-dimension scores (1/3/5)
  const formatting = findings.aiRhythm || findings.emDashAbuse ? 1
    : !findings.sentenceVariationOk ? 3 : 5;
  const engagement = findings.bannedHype.length + findings.weaselHedges.length > 3 ? 1
    : findings.bannedHype.length + findings.weaselHedges.length > 0 ? 3 : 5;
  const originality = findings.attributedNamedSources === 0 && !findings.hasNumbers ? 1
    : findings.attributedNamedSources >= 2 && findings.hasNumbers ? 5 : 3;
  const strategicAlignment = findings.bannedOpener ? 1
    : findings.engagementBait.length > 1 ? 3 : 5;
  // Structure & visualSupport need LLM judgement; default conservative 3.
  const structure = 3;
  const visualSupport = 3;

  const total = strategicAlignment + structure + originality + engagement + formatting + visualSupport;
  const verdict: QualityGateResult["verdict"] =
    total >= 27 ? "ship"
    : total >= 23 ? "minor-revisions"
    : total >= 18 ? "rewrite-key-sections"
    : "start-over";

  // Reference prose length in notes so reviewers know what was scored.
  if (prose.length < 800) notes.push(`Brief is short (${prose.length} chars); scores may be unreliable on thin output.`);

  return {
    scores: { strategicAlignment, structure, originality, engagement, formatting, visualSupport },
    total,
    verdict,
    violations,
    notes,
  };
}

/**
 * Lightweight LLM second pass that judges Structure + VisualSupport (the two
 * dimensions the deterministic linter can't score well) and returns 1/3/5
 * scores. Caller merges into the deterministic result. Fail-soft: returns
 * null on any error and the deterministic 3/3 stays.
 */
async function llmStructureScore(
  client: OpenAI,
  model: string,
  prose: string,
): Promise<{ structure: number; visualSupport: number; notes: string[] } | null> {
  try {
    const res = await client.chat.completions.create({
      model,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are scoring a content brief against two dimensions of the Kateryna Abrosymova Content Quality Score framework. Return STRICT JSON.",
        },
        {
          role: "user",
          content:
            `Score this brief on Structure (1/3/5) and Visual Support (1/3/5). ` +
            `Structure: 5 = one controlling idea stated in intro, H2s build the argument in sequence, every paragraph connects. 3 = controlling idea exists but weak. 1 = no controlling idea.\n` +
            `Visual Support: 5 = explicit [VISUAL: ...] flags or table/chart suggestions tied to claims. 3 = some visual suggestions but disconnected. 1 = pure prose, no visual flagging.\n\n` +
            `Return JSON: {"structure": 1|3|5, "visualSupport": 1|3|5, "notes": ["one short note for each dimension"]}\n\n` +
            `BRIEF:\n${prose.slice(0, 12000)}`,
        },
      ],
    });
    const txt = res.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(txt) as { structure?: unknown; visualSupport?: unknown; notes?: unknown };
    const s = parsed.structure === 1 || parsed.structure === 3 || parsed.structure === 5 ? parsed.structure : null;
    const v = parsed.visualSupport === 1 || parsed.visualSupport === 3 || parsed.visualSupport === 5 ? parsed.visualSupport : null;
    if (s === null || v === null) return null;
    const notes = Array.isArray(parsed.notes) ? parsed.notes.filter((n) => typeof n === "string") as string[] : [];
    return { structure: s, visualSupport: v, notes };
  } catch {
    return null;
  }
}

export async function runQualityGate(
  prose: string,
  client: OpenAI,
  model: string,
): Promise<QualityGateResult> {
  const findings = lintText(prose);
  const base = scoreFromLint(findings, prose);
  const llm = await llmStructureScore(client, model, prose);
  if (!llm) return base;
  const newScores = { ...base.scores, structure: llm.structure, visualSupport: llm.visualSupport };
  const total = newScores.strategicAlignment + newScores.structure + newScores.originality + newScores.engagement + newScores.formatting + newScores.visualSupport;
  const verdict: QualityGateResult["verdict"] =
    total >= 27 ? "ship"
    : total >= 23 ? "minor-revisions"
    : total >= 18 ? "rewrite-key-sections"
    : "start-over";
  return { ...base, scores: newScores, total, verdict, notes: [...base.notes, ...llm.notes] };
}

export function formatQualityGateMarkdown(g: QualityGateResult): string {
  const lines: string[] = [];
  lines.push("## Quality Gate (Khadija Voice + Kateryna 6-dimension)");
  lines.push("");
  lines.push(`**Total: ${g.total}/30 → Verdict: ${g.verdict.replace(/-/g, " ")}**`);
  lines.push("");
  lines.push(`| Dimension | Score |`);
  lines.push(`|---|---|`);
  lines.push(`| Strategic Alignment | ${g.scores.strategicAlignment}/5 |`);
  lines.push(`| Structure | ${g.scores.structure}/5 |`);
  lines.push(`| Originality | ${g.scores.originality}/5 |`);
  lines.push(`| Engagement | ${g.scores.engagement}/5 |`);
  lines.push(`| Formatting | ${g.scores.formatting}/5 |`);
  lines.push(`| Visual Support | ${g.scores.visualSupport}/5 |`);
  lines.push("");
  if (g.violations.length > 0) {
    lines.push("**Hard violations (fix before publishing):**");
    for (const v of g.violations) lines.push(`- ${v}`);
    lines.push("");
  }
  if (g.notes.length > 0) {
    lines.push("**Notes:**");
    for (const n of g.notes) lines.push(`- ${n}`);
  }
  return lines.join("\n");
}
