import { Router, type IRouter } from "express";
import OpenAI from "openai";
import { requireAuth } from "../lib/auth";
import {
  ContentResearchBody,
  ContentWriteBody,
  ContentAuditEntitiesBody,
  ContentAuditNlpBody,
  ContentAuditNgramsBody,
} from "@workspace/api-zod";
import { fetchPageHtmlInHouse, fetchPageInHouse, type FetchedHtml } from "../integrations/htmlFetch";
import {
  SEMANTIC_MODEL,
  extractOutlineFromHtml,
  extractNgramSet,
  generateEntities,
  extractEntitiesFromText,
  generateNlpKeywords,
  generateSkipGrams,
  generateGrammar,
  type OutlineNode,
  type NgramHit,
} from "../integrations/semanticPipeline";
import {
  KHADIJA_SYSTEM_PROMPT,
  KORAY_SEO_RULES,
  runQualityGate,
} from "../integrations/voice/khadija";

const router: IRouter = Router();

function getOpenAI(): OpenAI {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  return new OpenAI({ apiKey: key });
}

async function fetchManyHtml(urls: string[], cap = 5): Promise<FetchedHtml[]> {
  const sliced = urls.slice(0, cap).filter((u) => u && u.trim().length > 0);
  const results = await Promise.allSettled(sliced.map((u) => fetchPageHtmlInHouse(u)));
  const ok: FetchedHtml[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") ok.push(r.value);
  }
  return ok;
}

interface ApiNgramHit {
  gram: string;
  count: number;
}
interface ApiNgramBuckets {
  unigrams: ApiNgramHit[];
  bigrams: ApiNgramHit[];
  trigrams: ApiNgramHit[];
  fourgrams: ApiNgramHit[];
}
function toApiHits(hits: NgramHit[]): ApiNgramHit[] {
  return hits.map((h) => ({ gram: h.phrase, count: h.count }));
}
function ngramsToBuckets(set: Record<string, NgramHit[]>): ApiNgramBuckets {
  return {
    unigrams: toApiHits(set["1gram"] ?? []),
    bigrams: toApiHits(set["2gram"] ?? []),
    trigrams: toApiHits(set["3gram"] ?? []),
    fourgrams: toApiHits(set["4gram"] ?? []),
  };
}

function require400(res: import("express").Response, msg: string): void {
  res.status(400).json({ error: msg });
}

async function runResearch(keyword: string, competitorUrls: string[]) {
  const pages = await fetchManyHtml(competitorUrls);
  const competitorOutlines = pages.map((p) => ({
    url: p.url,
    title: p.title ?? null,
    headings: extractOutlineFromHtml(p.rawHtml) as OutlineNode[],
  }));
  const competitorText = pages.map((p) => p.bodyText).filter((t) => t && t.length > 0);
  const ngrams = ngramsToBuckets(extractNgramSet(competitorText));
  const joined = competitorText.join("\n\n").slice(0, 12_000);
  const [aiEntities, competitorEntities, nlpKeywords, skipGrams, grammar] = await Promise.all([
    generateEntities(keyword),
    joined.length > 0 ? extractEntitiesFromText(joined) : Promise.resolve([]),
    generateNlpKeywords(keyword),
    generateSkipGrams(keyword),
    generateGrammar(keyword),
  ]);
  return {
    keyword,
    competitorOutlines,
    ngrams,
    aiEntities,
    competitorEntities,
    nlpKeywords,
    skipGrams,
    grammar,
  };
}

router.post("/content/research", requireAuth, async (req, res) => {
  const parsed = ContentResearchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
    return;
  }
  try {
    const result = await runResearch(parsed.data.keyword.trim(), parsed.data.competitorUrls ?? []);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "content/research failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Research failed" });
  }
});

router.post("/content/write", requireAuth, async (req, res) => {
  const parsed = ContentWriteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
    return;
  }
  const { keyword, mode, competitorUrls, wordCount, notes } = parsed.data;
  const targetWords = wordCount ?? (mode === "quick" ? 1200 : 2400);
  try {
    const client = getOpenAI();
    let researchBlock = "";
    let research: Awaited<ReturnType<typeof runResearch>> | null = null;
    const hasCompetitors = (competitorUrls ?? []).length > 0;

    if (mode === "express" || hasCompetitors) {
      research = await runResearch(keyword.trim(), competitorUrls ?? []);
    }

    if (mode === "express" && research) {
      const top = (hits: ApiNgramHit[], n: number) => hits.slice(0, n).map((h) => `${h.gram} (${h.count})`).join(", ");
      const outlineBlock = research.competitorOutlines
        .map((o) =>
          [
            `- ${o.url}${o.title ? ` — ${o.title}` : ""}`,
            ...o.headings.slice(0, 12).map((h) => `  ${"  ".repeat(Math.max(0, h.level - 2))}H${h.level}: ${h.text}`),
          ].join("\n"),
        )
        .join("\n");
      researchBlock = `
COMPETITOR OUTLINES (use to inform your H2/H3 structure; do NOT copy verbatim):
${outlineBlock || "(no competitor outlines available)"}

TOP N-GRAMS from competitors (cover these naturally; do NOT keyword-stuff):
- 1-grams: ${top(research.ngrams.unigrams, 15)}
- 2-grams: ${top(research.ngrams.bigrams, 15)}
- 3-grams: ${top(research.ngrams.trigrams, 10)}
- 4-grams: ${top(research.ngrams.fourgrams, 8)}

ENTITIES TO COVER (AI-generated + extracted from competitors):
${[...new Set([...research.aiEntities, ...research.competitorEntities])].slice(0, 40).join(", ")}

NLP / LSI KEYWORDS to weave in: ${research.nlpKeywords.slice(0, 20).join(", ")}
SKIP-GRAM PAIRS to suggest associations: ${research.skipGrams.slice(0, 15).join("; ")}
GRAMMAR ONTOLOGY:
- proper nouns: ${research.grammar.properNouns.slice(0, 10).join(", ")}
- synonyms: ${research.grammar.synonyms.slice(0, 10).join(", ")}
- hyponyms (narrower): ${research.grammar.hyponyms.slice(0, 8).join(", ")}
- hypernyms (broader): ${research.grammar.hypernyms.slice(0, 6).join(", ")}
- meronyms (parts of): ${research.grammar.meronyms.slice(0, 6).join(", ")}
- holonyms (whole of): ${research.grammar.holonyms.slice(0, 6).join(", ")}
`;
    } else if (research) {
      const outlineBlock = research.competitorOutlines
        .map((o) => {
          const h = o.headings.slice(0, 10);
          return `- ${o.url}\n${h.map((x) => `  H${x.level}: ${x.text}`).join("\n")}`;
        })
        .join("\n");
      researchBlock = `\nCOMPETITOR OUTLINES (light reference):\n${outlineBlock || "(none)"}\n`;
    }

    const userPrompt = `Write a publish-ready SEO article in MARKDOWN about: "${keyword}"

TARGET LENGTH: approximately ${targetWords} words.
MODE: ${mode}
${notes ? `EDITORIAL NOTES (user-supplied): ${notes}\n` : ""}
${researchBlock}

REQUIREMENTS:
- Start with an H1 that includes the primary keyword naturally.
- Open with a Khadija-voice opener (no banned moves — see system prompt).
- Use a clear H2/H3 structure. Each H2 should map to a distinct user intent. 6–10 H2s for ${targetWords}+ words.
- Include at least one comparison table OR bulleted breakdown of options.
- Include at least two paragraphs that cite specific numbers, dates, or named tools.
- Avoid every banned phrase, opener, and weasel hedge listed in the system prompt.
- Do NOT include a closing "Conclusion" section that just summarises. End on a forward-looking practical paragraph.
- Do NOT include any meta commentary, frontmatter, or "Here is the article" preamble. Output the article markdown only.

${KORAY_SEO_RULES}
`;

    const completion = await client.chat.completions.create({
      model: SEMANTIC_MODEL,
      temperature: 0.7,
      max_tokens: 6000,
      messages: [
        { role: "system", content: KHADIJA_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });
    const article = completion.choices[0]?.message?.content?.trim() ?? "";
    if (!article) throw new Error("OpenAI returned empty article");

    const qg = await runQualityGate(article, client, SEMANTIC_MODEL);
    const wc = article.split(/\s+/).filter((w) => w.length > 0).length;
    res.json({
      keyword,
      mode,
      article,
      wordCount: wc,
      qualityGate: {
        scores: qg.scores,
        total: qg.total,
        verdict: qg.verdict,
        violations: qg.violations,
        notes: qg.notes,
      },
      research,
    });
  } catch (err) {
    req.log.error({ err }, "content/write failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Write failed" });
  }
});

async function resolveDraftText(input: { url?: string; text?: string }): Promise<string> {
  if (input.text && input.text.trim().length > 0) return input.text;
  if (input.url && input.url.trim().length > 0) {
    const fetched = await fetchPageInHouse(input.url);
    return fetched.bodyText;
  }
  throw new Error("Provide either `text` or `url`");
}

function scoreCoverage(presentLower: Set<string>, expected: string[]): {
  present: string[];
  missing: string[];
  score: number;
} {
  const present: string[] = [];
  const missing: string[] = [];
  for (const e of expected) {
    const needle = e.toLowerCase();
    if (presentLower.has(needle) || [...presentLower].some((p) => p.includes(needle) || needle.includes(p))) {
      present.push(e);
    } else {
      missing.push(e);
    }
  }
  const score = expected.length === 0 ? 0 : Math.round((present.length / expected.length) * 100);
  return { present, missing, score };
}

router.post("/content/audit/entities", requireAuth, async (req, res) => {
  const parsed = ContentAuditEntitiesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
    return;
  }
  if (!parsed.data.text?.trim() && !parsed.data.url?.trim()) {
    require400(res, "Provide either `text` or `url`");
    return;
  }
  try {
    const text = await resolveDraftText(parsed.data);
    const keyword = parsed.data.keyword.trim();
    const [expected, foundInText] = await Promise.all([
      generateEntities(keyword),
      extractEntitiesFromText(text.slice(0, 12_000)),
    ]);
    const foundLower = new Set(foundInText.map((s) => s.toLowerCase()));
    const { present, missing, score } = scoreCoverage(foundLower, expected);
    res.json({ keyword, score, present, expected, missing });
  } catch (err) {
    req.log.error({ err }, "content/audit/entities failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Audit failed" });
  }
});

router.post("/content/audit/nlp", requireAuth, async (req, res) => {
  const parsed = ContentAuditNlpBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
    return;
  }
  if (!parsed.data.text?.trim() && !parsed.data.url?.trim()) {
    require400(res, "Provide either `text` or `url`");
    return;
  }
  try {
    const text = await resolveDraftText(parsed.data);
    const keyword = parsed.data.keyword.trim();
    const expected = await generateNlpKeywords(keyword);
    const lower = text.toLowerCase();
    const present: string[] = [];
    const missing: string[] = [];
    for (const k of expected) {
      if (lower.includes(k.toLowerCase())) present.push(k);
      else missing.push(k);
    }
    const score = expected.length === 0 ? 0 : Math.round((present.length / expected.length) * 100);
    res.json({ keyword, score, present, expected, missing });
  } catch (err) {
    req.log.error({ err }, "content/audit/nlp failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Audit failed" });
  }
});

router.post("/content/audit/ngrams", requireAuth, async (req, res) => {
  const parsed = ContentAuditNgramsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
    return;
  }
  if (!parsed.data.text?.trim() && !parsed.data.url?.trim()) {
    require400(res, "Provide either `text` or `url`");
    return;
  }
  try {
    const draftText = await resolveDraftText(parsed.data);
    const competitorPages = await fetchManyHtml(parsed.data.competitorUrls);
    const draft = ngramsToBuckets(extractNgramSet([draftText]));
    const competitor = ngramsToBuckets(
      extractNgramSet(competitorPages.map((p) => p.bodyText).filter((t) => t.length > 0)),
    );
    const draftAll = new Set(
      [...draft.unigrams, ...draft.bigrams, ...draft.trigrams, ...draft.fourgrams].map((h) =>
        h.gram.toLowerCase(),
      ),
    );
    const compAll: ApiNgramHit[] = [
      ...competitor.bigrams,
      ...competitor.trigrams,
      ...competitor.fourgrams,
    ].sort((a, b) => b.count - a.count);
    const gaps = compAll
      .filter((h) => !draftAll.has(h.gram.toLowerCase()))
      .slice(0, 30)
      .map((h) => h.gram);
    res.json({ draft, competitor, gaps });
  } catch (err) {
    req.log.error({ err }, "content/audit/ngrams failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Audit failed" });
  }
});

export default router;
