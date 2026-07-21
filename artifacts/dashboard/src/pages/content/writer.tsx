import { useState } from "react";
import { useContentWrite, type ContentWriteResult, type ContentWriteInputMode, type ContentNgramHit } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { HowThisWorks } from "@/components/how-this-works";
import { InfoTip } from "@/components/info-tip";
import { Loader2, Sparkles, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function parseUrlList(raw: string): string[] {
  return raw
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function NgramTable({ hits }: { hits: ContentNgramHit[] }) {
  if (hits.length === 0) {
    return <p className="text-xs text-muted-foreground italic">No n-grams extracted.</p>;
  }
  return (
    <div className="max-h-64 overflow-y-auto rounded border border-border/40">
      <table className="text-xs w-full">
        <thead className="sticky top-0 bg-muted/60">
          <tr><th className="text-left px-2 py-1 font-medium">Phrase</th><th className="text-right px-2 py-1 font-medium w-16">Count</th></tr>
        </thead>
        <tbody>
          {hits.slice(0, 40).map((h, i) => (
            <tr key={i} className="border-t border-border/30"><td className="px-2 py-1">{h.gram}</td><td className="px-2 py-1 text-right font-mono">{h.count}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BadgeCloud({ items, tone }: { items: string[]; tone: "primary" | "muted" }) {
  if (items.length === 0) return <p className="text-xs text-muted-foreground italic">None extracted.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.slice(0, 60).map((e, i) => (
        <Badge key={i} variant={tone === "primary" ? "secondary" : "outline"} className="text-xs font-normal">{e}</Badge>
      ))}
    </div>
  );
}

export default function ContentWriter() {
  const { toast } = useToast();
  const writeMutation = useContentWrite();
  const [keyword, setKeyword] = useState("");
  const [mode, setMode] = useState<ContentWriteInputMode>("express");
  const [wordCount, setWordCount] = useState<number>(2400);
  const [competitorUrlsRaw, setCompetitorUrlsRaw] = useState("");
  const [notes, setNotes] = useState("");
  const [result, setResult] = useState<ContentWriteResult | null>(null);

  const handleGenerate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyword.trim()) {
      toast({ title: "Enter a keyword", variant: "destructive" });
      return;
    }
    writeMutation.mutate(
      {
        data: {
          keyword: keyword.trim(),
          mode,
          wordCount,
          competitorUrls: parseUrlList(competitorUrlsRaw),
          notes: notes.trim() || undefined,
        },
      },
      {
        onSuccess: (data) => {
          setResult(data);
          toast({ title: "Article generated", description: `${data.wordCount} words · ${data.qualityGate.verdict.replace(/-/g, " ")}` });
        },
        onError: (err: unknown) => {
          const msg = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : "Generation failed";
          toast({ variant: "destructive", title: "Couldn't generate", description: msg });
        },
      },
    );
  };

  const copyArticle = () => {
    if (!result?.article) return;
    void navigator.clipboard.writeText(result.article).then(() => toast({ title: "Copied markdown to clipboard" }));
  };

  const research = result?.research ?? null;
  const combinedEntities = research
    ? Array.from(new Set([...(research.aiEntities ?? []), ...(research.competitorEntities ?? [])]))
    : [];

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div>
        <h2 className="text-3xl font-display text-foreground flex items-center gap-2">
          <Sparkles className="h-7 w-7 text-primary" />
          Content Writer
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Generate net-new SEO articles in Khadija's voice, with Koray-style semantic SEO discipline, a 6-dimension quality gate, and competitor research (entities, NLP, n-grams) pulled live from competitor HTML.
        </p>
      </div>

      <HowThisWorks
        summary="Give the AI a keyword and a few competitor links, and it writes a full, SEO-ready article draft for you to review and edit."
        steps={[
          {
            title: "Enter your keyword",
            body: "Type the main phrase you want the article to rank for, like \"how to build an internal linking strategy\".",
          },
          {
            title: "Add competitor links (optional)",
            body: "Paste a few web addresses of top-ranking articles on the same topic. The AI reads them to learn what to cover.",
          },
          {
            title: "Choose mode and length",
            body: "Pick how deep the research goes and roughly how many words you want, then click Generate article.",
          },
          {
            title: "Review the draft and scores",
            body: "Read the article, check the quality scores and any flagged issues, then copy the markdown to use it.",
          },
        ]}
        faqs={[
          {
            title: "What's the difference between Quick and Express?",
            body: "Quick only reads the competitor pages you paste. Express does deeper research (key concepts, related keywords, grammar) for a more thorough draft, but takes longer.",
          },
          {
            title: "What is the quality gate score?",
            body: "An automatic rating out of 30 across 6 writing checks. Higher is better — it flags weak spots so you can fix them before publishing.",
          },
          {
            title: "What are 'entities' and 'n-grams'?",
            body: "Entities are the people, places, and concepts a topic should mention. N-grams are common word phrases competitors use (e.g. 2-word or 3-word combos). Both hint at what to include.",
          },
          {
            title: "Is the draft ready to publish?",
            body: "Treat it as a strong first draft. Always fact-check, edit it into your own voice, and add real examples before publishing.",
          },
        ]}
        tips={[
          "Add 3–5 strong competitor URLs for the best research — only the first 5 are used.",
          "Use the Editorial notes box to steer tone, angle, or things to include or avoid.",
        ]}
      />

      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="text-lg">Brief</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleGenerate} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-[2fr,1fr,1fr] gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  Primary keyword
                  <InfoTip>The main search phrase you want this article to rank for on Google.</InfoTip>
                </label>
                <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="e.g. how to build internal linking strategy" required />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  Mode
                  <InfoTip>
                    Quick reads only the competitor pages you paste. Express does deeper
                    research for a richer draft, but takes longer.
                  </InfoTip>
                </label>
                <Select value={mode} onValueChange={(v) => setMode(v as ContentWriteInputMode)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="quick">Quick (research from competitor HTML only)</SelectItem>
                    <SelectItem value="express">Express (full semantic research)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  Word target
                  <InfoTip>Roughly how long you want the article, in words. The AI aims for this length.</InfoTip>
                </label>
                <Input type="number" min={300} max={6000} step={100} value={wordCount} onChange={(e) => setWordCount(Number(e.target.value))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                Competitor URLs (one per line, max 5 used)
                <InfoTip>
                  Links to top-ranking articles on the same topic. The AI reads them to see
                  what to cover, so the draft matches or beats what's already out there.
                </InfoTip>
              </label>
              <Textarea rows={3} value={competitorUrlsRaw} onChange={(e) => setCompetitorUrlsRaw(e.target.value)} placeholder="https://example.com/article-1&#10;https://example.com/article-2" />
              <p className="text-[11px] text-muted-foreground">Entities, NLP keywords and n-grams are extracted from these pages' HTML and shown after generation.</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                Editorial notes (optional)
                <InfoTip>
                  Free-text instructions to steer the AI — tone, angle, audience, and anything
                  to be sure to include or avoid.
                </InfoTip>
              </label>
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Tone, angle, audience, things to include or avoid" />
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={writeMutation.isPending} className="bg-primary text-primary-foreground">
                {writeMutation.isPending ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Generating…</>
                ) : (
                  <><Sparkles className="h-4 w-4 mr-2" />Generate article</>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {result && (
        <Card className="border-border/50">
          <CardHeader>
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <CardTitle className="text-lg">{result.keyword}</CardTitle>
                <div className="flex gap-2 mt-2 flex-wrap">
                  <Badge variant="outline" className="capitalize">{result.mode}</Badge>
                  <Badge variant="secondary">{result.wordCount} words</Badge>
                  <Badge className="bg-primary/10 text-primary">{result.qualityGate.total}/30 · {result.qualityGate.verdict.replace(/-/g, " ")}</Badge>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={copyArticle}><Copy className="h-4 w-4 mr-2" />Copy markdown</Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 lg:grid-cols-[3fr,1fr] gap-6">
              <article className="prose prose-slate dark:prose-invert prose-blue max-w-none prose-headings:font-headers">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.article}</ReactMarkdown>
              </article>
              <aside className="space-y-4">
                <div>
                  <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
                    Quality scores
                    <InfoTip>
                      Automatic ratings out of 5 for each writing check. Higher means the draft
                      is stronger on that dimension — low scores show where to edit.
                    </InfoTip>
                  </h3>
                  <table className="text-xs w-full">
                    <tbody>
                      {Object.entries(result.qualityGate.scores).map(([k, v]) => (
                        <tr key={k} className="border-b border-border/40"><td className="py-1 capitalize text-muted-foreground">{k.replace(/([A-Z])/g, " $1").trim()}</td><td className="py-1 text-right font-mono">{v}/5</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {result.qualityGate.violations.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium mb-2 text-red-600">Violations</h3>
                    <ul className="text-xs list-disc pl-4 space-y-1">
                      {result.qualityGate.violations.map((v, i) => <li key={i}>{v}</li>)}
                    </ul>
                  </div>
                )}
                {result.qualityGate.notes.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium mb-2 text-muted-foreground">Notes</h3>
                    <ul className="text-xs list-disc pl-4 space-y-1 text-muted-foreground">
                      {result.qualityGate.notes.map((v, i) => <li key={i}>{v}</li>)}
                    </ul>
                  </div>
                )}
              </aside>
            </div>
          </CardContent>
        </Card>
      )}

      {research && (
        <Card className="border-border/50">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-1.5">
              Competitor research
              <InfoTip>
                What the AI learned from the competitor pages you provided — the topics,
                phrases, and structure they use. Use it as a checklist of what your article
                should cover.
              </InfoTip>
            </CardTitle>
            <p className="text-xs text-muted-foreground">Pulled from {research.competitorOutlines.length} competitor HTML page{research.competitorOutlines.length === 1 ? "" : "s"}.</p>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="entities">
              <TabsList>
                <TabsTrigger value="entities">Entities</TabsTrigger>
                <TabsTrigger value="nlp">NLP / LSI</TabsTrigger>
                <TabsTrigger value="ngrams">N-grams</TabsTrigger>
                <TabsTrigger value="outlines">Outlines</TabsTrigger>
                {mode === "express" && <TabsTrigger value="grammar">Grammar</TabsTrigger>}
              </TabsList>

              <TabsContent value="entities" className="space-y-4 mt-4">
                <div>
                  <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
                    Combined ({combinedEntities.length})
                    <InfoTip>
                      Entities are the key people, places, brands, and concepts a thorough
                      article on this topic should mention. Try to work the relevant ones into
                      your draft.
                    </InfoTip>
                  </h4>
                  <BadgeCloud items={combinedEntities} tone="primary" />
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">AI-generated for keyword</h4>
                    <BadgeCloud items={research.aiEntities ?? []} tone="muted" />
                  </div>
                  <div>
                    <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">Extracted from competitor HTML</h4>
                    <BadgeCloud items={research.competitorEntities ?? []} tone="muted" />
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="nlp" className="space-y-4 mt-4">
                <div>
                  <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
                    NLP / LSI keywords ({research.nlpKeywords.length})
                    <InfoTip>
                      Related words and phrases that naturally go with your topic (NLP / LSI
                      just means "words search engines expect to see together"). Sprinkling
                      them in makes your article read as more complete.
                    </InfoTip>
                  </h4>
                  <BadgeCloud items={research.nlpKeywords} tone="primary" />
                </div>
                <div>
                  <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">Skip-grams</h4>
                  <BadgeCloud items={research.skipGrams} tone="muted" />
                </div>
              </TabsContent>

              <TabsContent value="ngrams" className="mt-4">
                <Tabs defaultValue="2">
                  <TabsList>
                    <TabsTrigger value="1">1-grams</TabsTrigger>
                    <TabsTrigger value="2">2-grams</TabsTrigger>
                    <TabsTrigger value="3">3-grams</TabsTrigger>
                    <TabsTrigger value="4">4-grams</TabsTrigger>
                  </TabsList>
                  <TabsContent value="1" className="mt-3"><NgramTable hits={research.ngrams.unigrams} /></TabsContent>
                  <TabsContent value="2" className="mt-3"><NgramTable hits={research.ngrams.bigrams} /></TabsContent>
                  <TabsContent value="3" className="mt-3"><NgramTable hits={research.ngrams.trigrams} /></TabsContent>
                  <TabsContent value="4" className="mt-3"><NgramTable hits={research.ngrams.fourgrams} /></TabsContent>
                </Tabs>
              </TabsContent>

              <TabsContent value="outlines" className="space-y-4 mt-4">
                {research.competitorOutlines.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">No competitor outlines available.</p>
                ) : research.competitorOutlines.map((o, i) => (
                  <div key={i} className="border border-border/40 rounded p-3">
                    <a href={o.url} target="_blank" rel="noreferrer" className="text-sm text-primary hover:underline break-all">{o.url}</a>
                    {o.title && <p className="text-xs text-muted-foreground mt-0.5">{o.title}</p>}
                    <ul className="mt-2 space-y-0.5">
                      {o.headings.slice(0, 20).map((h, j) => (
                        <li key={j} className="text-xs font-mono" style={{ paddingLeft: `${Math.max(0, h.level - 2) * 12}px` }}>
                          <span className="text-muted-foreground mr-1">H{h.level}</span>{h.text}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </TabsContent>

              {mode === "express" && (
                <TabsContent value="grammar" className="mt-4">
                  <div className="grid md:grid-cols-2 gap-4">
                    {([
                      ["properNouns", "Proper nouns"],
                      ["commonNouns", "Common nouns"],
                      ["synonyms", "Synonyms"],
                      ["antonyms", "Antonyms"],
                      ["hyponyms", "Hyponyms (narrower)"],
                      ["hypernyms", "Hypernyms (broader)"],
                      ["meronyms", "Meronyms (parts of)"],
                      ["holonyms", "Holonyms (whole of)"],
                    ] as const).map(([key, label]) => (
                      <div key={key}>
                        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">{label}</h4>
                        <BadgeCloud items={research.grammar[key]} tone="muted" />
                      </div>
                    ))}
                  </div>
                </TabsContent>
              )}
            </Tabs>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
