import { useMemo, useState } from "react";
import { HowThisWorks } from "@/components/how-this-works";
import { CopyButton } from "@/components/copy-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Search, Sparkles, X, AlertTriangle, Ban } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetLinkGraph,
  useGetLinkMapGenerationLatest,
  getGetLinkMapGenerationLatestQueryKey,
  useGenerateLinkMap,
} from "@workspace/api-client-react";

// The paste-ready prompt block (everything between INPUTS and WHAT NOT TO DO,
// verbatim). Kept as one string so "Copy prompt" hands over exactly what the
// reference page renders below.
const PROMPT_TEXT = `You are building an internal link map for a topical cluster. Work from the rules below, and for every link you propose, name the rule that justifies it. If a link cannot be justified by a rule, do not propose it.

### INPUTS

**Central entity:** \`<the single entity the cluster is about>\`
**Parent topic / canonical query of the hub:** \`<e.g. generative engine optimization>\`
**Hub URL:** \`<the category or pillar page, if one exists>\`

**Pages in scope** — one row per URL:

| URL | H1 (verbatim) | Canonical query this page answers | Layer | Intent | Inbound internal links (site-wide) | Existing outbound links to others in this set |
|---|---|---|---|---|---|---|
| | | | hub / core / outer / commercial | know / compare / do / buy | | |

**Constraints:**
- Max new links to add per page: \`<e.g. 4>\`
- Pages I cannot edit right now: \`<list>\`
- Anchor text already used on the site for each target (to avoid collisions): \`<list, or "unknown">\`

### RULES

Apply in this order. Earlier rules win when two conflict.

**R1 — Hierarchy before affinity.** Every page links up to its parent, and the parent links down to every child. Sibling-to-sibling links are added only where rule R4 can be satisfied. A cluster where children link up but the parent doesn't link down is a distribution failure, not a cluster.

**R2 — Asymmetry encodes structure.** Do not reciprocate every pair. Reciprocal links everywhere flatten the hierarchy and tell a crawler no page is more important than another. Parent↔child is bidirectional; sibling→sibling is usually one-directional, in the direction the reader's question actually travels.

**R3 — Anchor text lemmatizes to the target's H1.** The anchor must be the target's canonical query or a close morphological variant of its H1. Never "click here", "this post", "learn more", or the bare brand name. The anchor must also be *supported by content on the target page* — an anchor promising something the target doesn't deliver is a mismatch risk.

**R4 — Every link needs a bridge sentence.** The sentence containing the link must state the relationship between the two pages, so the link makes sense with the surrounding text removed. If you cannot write that sentence without padding, the link does not belong. Output the bridge sentence with each proposed link.

**R5 — Placement follows attention.** Main content beats sidebar beats footer. Earlier in the body beats later. A link inside a paragraph that argues for it beats a link in a list of links. Never propose a "Related posts" or "Read more" block — an undifferentiated list of links carries almost no weight and dilutes everything else on the page.

**R6 — Respect the link budget.** Each outbound link on a page divides that page's distributable authority. A page with 100 outbound links passes little through any one of them. Prioritise: on high-authority pages, propose *few, well-placed* links rather than many.

**R7 — Relevance gate.** Do not link between two pages whose topics only loosely touch. Off-topic internal links dilute the site's topical focus. Ask: would a reader mid-sentence actually want this next? If no, skip it.

**R8 — Depth ceiling.** Every page in scope should be reachable within 3 clicks of the hub or homepage. Flag any page that isn't.

**R9 — Anchor diversity across sources, consistency of meaning.** Use a different surface form of the anchor on each source page (singular/plural, with/without modifier), but keep the meaning identical. Do not use the same exact anchor from ten different pages, and do not use one anchor for two different targets.

**R10 — Commercial pages receive, informational pages send.** Comparison, pricing, agency, and tool pages should be net receivers from explainers and data pages. Do not route readers from a commercial page back into top-of-funnel content unless it answers an objection.

### OUTPUT

Produce these four sections, in order. No preamble.

**1. Current coverage matrix.** Rows = source, columns = target, ✓ / — for each pair. Include a "links out into cluster" and "links in from cluster" total per page.

**2. Proposed additions**, sorted by expected impact:

| # | From | To | Anchor text | Placement (section + before/after what) | Bridge sentence | Rule(s) | Why this one matters |
|---|---|---|---|---|---|---|---|

**3. Flags.** Only real problems, each with the specific page:
- Orphans (fewer than 3 inbound internal links)
- Hubs that hoard (high inbound, low outbound into their own cluster)
- Anchor collisions (one anchor pointing at two targets, or vice versa)
- Fully reciprocal pairs that should be directional
- Pages beyond the depth ceiling
- Link dumps to delete

**4. Do-not-link list.** Pairs that look plausible but fail R7, with the reason. This section is as valuable as section 2 — it stops the next person adding them.

### WHAT NOT TO DO

- Do not invent pages, URLs, or metrics that aren't in the INPUTS.
- Do not propose a link you can't write a bridge sentence for.
- Do not pad the map to look thorough. Ten justified links beat forty guesses.
- If the INPUTS are missing something you need (H1s, inbound counts), say which field and stop — don't estimate it.`;

const RULES: Array<{ id: string; title: string; body: string }> = [
  {
    id: "R1",
    title: "Hierarchy before affinity",
    body: "Every page links up to its parent, and the parent links down to every child. Sibling-to-sibling links are added only where R4 can be satisfied. A cluster where children link up but the parent doesn't link down is a distribution failure, not a cluster.",
  },
  {
    id: "R2",
    title: "Asymmetry encodes structure",
    body: "Don't reciprocate every pair — reciprocal links everywhere flatten the hierarchy and tell a crawler no page is more important than another. Parent↔child is bidirectional; sibling→sibling is usually one-directional, in the direction the reader's question actually travels.",
  },
  {
    id: "R3",
    title: "Anchor text lemmatizes to the target's H1",
    body: "The anchor must be the target's canonical query or a close morphological variant of its H1. Never \u201cclick here\u201d, \u201cthis post\u201d, \u201clearn more\u201d, or the bare brand name — and the anchor must be supported by content on the target page.",
  },
  {
    id: "R4",
    title: "Every link needs a bridge sentence",
    body: "The sentence containing the link must state the relationship between the two pages, so the link makes sense with the surrounding text removed. If you can't write that sentence without padding, the link doesn't belong.",
  },
  {
    id: "R5",
    title: "Placement follows attention",
    body: "Main content beats sidebar beats footer; earlier in the body beats later. A link inside a paragraph that argues for it beats a link in a list of links. Never propose a \u201cRelated posts\u201d block — undifferentiated link lists carry almost no weight.",
  },
  {
    id: "R6",
    title: "Respect the link budget",
    body: "Each outbound link divides the page's distributable authority — a page with 100 outbound links passes little through any one of them. On high-authority pages, propose few, well-placed links rather than many.",
  },
  {
    id: "R7",
    title: "Relevance gate",
    body: "Don't link two pages whose topics only loosely touch — off-topic internal links dilute the site's topical focus. Ask: would a reader mid-sentence actually want this next? If no, skip it.",
  },
  {
    id: "R8",
    title: "Depth ceiling",
    body: "Every page in scope should be reachable within 3 clicks of the hub or homepage. Flag any page that isn't.",
  },
  {
    id: "R9",
    title: "Anchor diversity across sources, consistency of meaning",
    body: "Use a different surface form of the anchor on each source page (singular/plural, with/without modifier) but keep the meaning identical. Never the same exact anchor from ten pages, and never one anchor for two different targets.",
  },
  {
    id: "R10",
    title: "Commercial pages receive, informational pages send",
    body: "Comparison, pricing, agency, and tool pages should be net receivers from explainers and data pages. Don't route readers from a commercial page back into top-of-funnel content unless it answers an objection.",
  },
];

const OUTPUT_SECTIONS: Array<{ n: number; title: string; body: string }> = [
  {
    n: 1,
    title: "Current coverage matrix",
    body: "Rows = source, columns = target, \u2713 / \u2014 for each pair, plus \u201clinks out into cluster\u201d and \u201clinks in from cluster\u201d totals per page.",
  },
  {
    n: 2,
    title: "Proposed additions",
    body: "Sorted by expected impact: From, To, Anchor text, Placement, Bridge sentence, Rule(s), and why this one matters.",
  },
  {
    n: 3,
    title: "Flags",
    body: "Only real problems, each with the specific page: orphans (<3 inbound), hubs that hoard, anchor collisions, fully reciprocal pairs that should be directional, pages beyond the depth ceiling, link dumps to delete.",
  },
  {
    n: 4,
    title: "Do-not-link list",
    body: "Pairs that look plausible but fail the relevance gate (R7), with the reason. As valuable as the additions — it stops the next person adding them.",
  },
];

const INPUT_FIELDS: Array<{ field: string; hint: string }> = [
  { field: "Central entity", hint: "The single entity the cluster is about." },
  {
    field: "Parent topic / canonical query of the hub",
    hint: "e.g. \u201cgenerative engine optimization\u201d.",
  },
  { field: "Hub URL", hint: "The category or pillar page, if one exists." },
  {
    field: "Pages in scope",
    hint: "One row per URL: URL, H1 (verbatim), canonical query it answers, layer (hub / core / outer / commercial), intent (know / compare / do / buy), inbound internal links site-wide, existing outbound links to others in the set.",
  },
  {
    field: "Constraints",
    hint: "Max new links per page, pages you can't edit right now, and anchor text already used for each target (to avoid collisions).",
  },
];

const FLAG_LABEL: Record<string, string> = {
  orphan: "Orphan",
  hub_hoards: "Hub hoards",
  anchor_collision: "Anchor collision",
  reciprocal_pair: "Reciprocal pair",
  depth: "Beyond depth ceiling",
  link_dump: "Link dump",
  other: "Other",
};

function shortPath(url: string): string {
  try {
    const p = new URL(url).pathname.replace(/\/$/, "") || "/";
    return p.length > 48 ? p.slice(0, 47) + "…" : p;
  } catch {
    return url;
  }
}

function GeneratorSection() {
  const queryClient = useQueryClient();
  const { data: graph, isLoading: graphLoading } = useGetLinkGraph();
  const { data: latest } = useGetLinkMapGenerationLatest({
    query: {
      queryKey: getGetLinkMapGenerationLatestQueryKey(),
      refetchInterval: (q) => (q.state.data?.status === "running" ? 3000 : false),
    },
  });
  const generateMutation = useGenerateLinkMap({
    mutation: {
      onSettled: () =>
        void queryClient.invalidateQueries({ queryKey: getGetLinkMapGenerationLatestQueryKey() }),
    },
  });

  const [centralEntity, setCentralEntity] = useState("");
  const [hubUrl, setHubUrl] = useState<string>("none");
  const [maxNewLinks, setMaxNewLinks] = useState(4);
  const [pageSearch, setPageSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const nodes = useMemo(
    () => [...(graph?.nodes ?? [])].sort((a, b) => (b.pagerank ?? 0) - (a.pagerank ?? 0)),
    [graph],
  );
  const matches = useMemo(() => {
    const q = pageSearch.trim().toLowerCase();
    const pool = q ? nodes.filter((n) => n.id.toLowerCase().includes(q)) : nodes;
    return pool.slice(0, 60);
  }, [nodes, pageSearch]);

  const toggle = (url: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else if (next.size < 30) next.add(url);
      return next;
    });

  const running = latest?.status === "running";
  const canGenerate =
    centralEntity.trim().length >= 2 && selected.size >= 2 && !running && !generateMutation.isPending;

  const generate = () => {
    generateMutation.mutate({
      data: {
        centralEntity: centralEntity.trim(),
        hubUrl: hubUrl === "none" ? null : hubUrl,
        pageUrls: [...selected],
        maxNewLinksPerPage: maxNewLinks,
      },
    });
  };

  const result = latest?.available && latest.status === "complete" ? latest : null;

  return (
    <div className="space-y-5">
      <Card className="border-primary/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Generate the link map in-app
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Pick the cluster pages — the INPUTS (H1s, canonical queries, inbound counts, existing
            links, used anchors) are filled from your crawl and Search Console data automatically,
            then the 10-rule prompt runs against the AI. Only runs when you click Generate.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Central entity</Label>
              <Input
                placeholder="e.g. AI visibility"
                value={centralEntity}
                onChange={(e) => setCentralEntity(e.target.value)}
                data-testid="input-central-entity"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Hub / pillar page (optional)</Label>
              <Select value={hubUrl} onValueChange={setHubUrl}>
                <SelectTrigger data-testid="select-hub">
                  <SelectValue placeholder="No hub page" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No hub page</SelectItem>
                  {[...selected].map((u) => (
                    <SelectItem key={u} value={u}>
                      {shortPath(u)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Max new links per page</Label>
              <Input
                type="number"
                min={1}
                max={10}
                value={maxNewLinks}
                onChange={(e) =>
                  setMaxNewLinks(Math.max(1, Math.min(10, Number(e.target.value) || 4)))
                }
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>
              Pages in scope{" "}
              <span className="text-muted-foreground font-normal">
                ({selected.size} selected, 2–30)
              </span>
            </Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Filter pages, e.g. /blog/ai-visibility"
                className="pl-9"
                value={pageSearch}
                onChange={(e) => setPageSearch(e.target.value)}
                data-testid="input-page-search"
              />
            </div>
            {graphLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
                <Spinner className="h-4 w-4" /> Loading pages…
              </div>
            ) : (
              <div className="max-h-56 overflow-y-auto rounded-md border divide-y">
                {matches.map((n) => (
                  <label
                    key={n.id}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-accent/50"
                  >
                    <Checkbox checked={selected.has(n.id)} onCheckedChange={() => toggle(n.id)} />
                    <span className="truncate flex-1" title={n.id}>
                      {shortPath(n.id)}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {n.inboundCount} in / {n.outboundCount} out
                    </span>
                  </label>
                ))}
                {matches.length === 0 && (
                  <p className="px-3 py-3 text-sm text-muted-foreground">
                    No pages match — run the link map crawl first if the list is empty.
                  </p>
                )}
              </div>
            )}
            {selected.size > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {[...selected].map((u) => (
                  <Badge key={u} variant="secondary" className="gap-1 font-normal">
                    {shortPath(u)}
                    <button onClick={() => toggle(u)} aria-label={`Remove ${u}`}>
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={generate} disabled={!canGenerate} data-testid="button-generate">
              {running || generateMutation.isPending ? (
                <>
                  <Spinner className="h-4 w-4 mr-1.5" /> Generating…
                </>
              ) : (
                "Generate link map"
              )}
            </Button>
            {latest?.status === "error" && (
              <p className="text-sm text-destructive">
                Last run failed: {latest.error ?? "unknown error"} — try again.
              </p>
            )}
            {generateMutation.isError && (
              <p className="text-sm text-destructive">
                {(generateMutation.error as { response?: { data?: { error?: string } } })?.response
                  ?.data?.error ?? "Could not start the generation"}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {result && (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                Coverage — {result.centralEntity}
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {result.finishedAt ? new Date(result.finishedAt).toLocaleString() : ""}
                </span>
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Current in-cluster linking, computed from your crawl data (updates as links go live).
              </p>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Page</TableHead>
                    <TableHead>Layer</TableHead>
                    <TableHead className="text-right">Inbound site-wide</TableHead>
                    <TableHead className="text-right">Out into cluster</TableHead>
                    <TableHead className="text-right">In from cluster</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.coverage.map((c) => (
                    <TableRow key={c.url}>
                      <TableCell className="max-w-xs">
                        <div className="truncate font-medium" title={c.url}>
                          {shortPath(c.url)}
                        </div>
                        {c.h1 && (
                          <div className="truncate text-xs text-muted-foreground">{c.h1}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {c.url === result.hubUrl ? "hub" : c.layer}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{c.inboundSiteWide}</TableCell>
                      <TableCell className="text-right">{c.outIntoCluster}</TableCell>
                      <TableCell className="text-right">{c.inFromCluster}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-base">
                  Proposed links ({result.proposals.length})
                </CardTitle>
                <CopyButton
                  getText={() =>
                    result.proposals
                      .map(
                        (p, i) =>
                          `${i + 1}. ${p.from} → ${p.to}\n   Anchor: "${p.anchorText}"\n   Placement: ${p.placement}\n   Bridge: ${p.bridgeSentence}\n   Rules: ${p.rules.join(", ")} — ${p.why}`,
                      )
                      .join("\n\n")
                  }
                  label="Copy all"
                />
              </div>
              <p className="text-sm text-muted-foreground">
                Sorted by expected impact. Each has the anchor, where to put it, and a ready
                bridge sentence.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {result.proposals.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No new links proposed — the cluster may already be fully linked.
                </p>
              )}
              {result.proposals.map((p, i) => (
                <div key={`${p.from}-${p.to}`} className="rounded-md border p-3 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-muted-foreground">#{i + 1}</span>
                    <span className="font-medium">{shortPath(p.from)}</span>
                    <span className="text-muted-foreground">→</span>
                    <span className="font-medium">{shortPath(p.to)}</span>
                    {p.rules.map((r) => (
                      <Badge key={r} variant="outline" className="font-mono text-xs">
                        {r}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-sm">
                    Anchor: <span className="font-medium">“{p.anchorText}”</span>
                    <span className="text-muted-foreground"> · {p.placement}</span>
                  </p>
                  <p className="text-sm text-muted-foreground italic">“{p.bridgeSentence}”</p>
                  <p className="text-xs text-muted-foreground">{p.why}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-500" /> Flags (
                  {result.flags.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {result.flags.length === 0 && (
                  <p className="text-sm text-muted-foreground">No structural problems flagged.</p>
                )}
                {result.flags.map((f, i) => (
                  <div key={i} className="text-sm">
                    <Badge variant="outline" className="mr-2">
                      {FLAG_LABEL[f.type] ?? f.type}
                    </Badge>
                    <span className="font-medium">{shortPath(f.page)}</span>
                    <p className="text-muted-foreground">{f.detail}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Ban className="h-4 w-4 text-red-500" /> Do not link ({result.doNotLink.length})
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  Plausible-looking pairs that fail the relevance gate — don't add them later.
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                {result.doNotLink.length === 0 && (
                  <p className="text-sm text-muted-foreground">No pairs ruled out.</p>
                )}
                {result.doNotLink.map((d, i) => (
                  <div key={i} className="text-sm">
                    <span className="font-medium">{shortPath(d.from)}</span>
                    <span className="text-muted-foreground"> ↛ </span>
                    <span className="font-medium">{shortPath(d.to)}</span>
                    <p className="text-muted-foreground">{d.reason}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

export default function LinkMapPrompt() {
  return (
    <div className="space-y-5">
      <HowThisWorks
        summary="Turns a set of cluster pages into an auditable, rule-justified internal link map — every proposed link names the rule that justifies it, with anchor text, placement, and a bridge sentence. Generate it in-app (the INPUTS are filled from your crawl + Search Console data) or copy the prompt to run manually."
        steps={[
          {
            title: "Pick the cluster",
            body: "Name the central entity, select 2–30 pages in scope (optionally mark one as the hub), and set the per-page link budget.",
          },
          {
            title: "Generate",
            body: "The app builds the INPUTS from real data — H1s, canonical queries, inbound counts, existing in-cluster links, anchors already in use — and runs the 10-rule prompt against the AI. Nothing runs on page load; only when you click Generate.",
          },
          {
            title: "Apply the map",
            body: "You get a coverage table, proposed links sorted by impact (each with anchor, placement, and bridge sentence), flags for structural problems, and a do-not-link list.",
          },
        ]}
        tips={[
          "Inbound link counts per URL: with WordPress access, search post content for the URL slug — the result count is the number of posts linking to it. Faster than a crawl for a small set.",
          "Existing outbound links: read each page's raw source, not the rendered page — links inside shortcodes, tabs, and accordions won't always appear in rendered text.",
          "If the AI is missing an input (H1s, inbound counts), the prompt tells it to say which field and stop — never estimate.",
        ]}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Internal Link Map</h1>
          <p className="text-sm text-muted-foreground">
            Generate a directed, rule-justified link map in-app from your real
            crawl data — or copy the prompt to run it manually.
          </p>
        </div>
        <CopyButton
          getText={() => PROMPT_TEXT}
          label="Copy prompt"
          toastTitle="Prompt copied — paste it into a new AI chat"
        />
      </div>

      <GeneratorSection />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Inputs you fill in</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-64">Input</TableHead>
                <TableHead>What goes there</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {INPUT_FIELDS.map((f) => (
                <TableRow key={f.field}>
                  <TableCell className="font-medium align-top">{f.field}</TableCell>
                  <TableCell className="text-muted-foreground">{f.hint}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">The 10 rules</CardTitle>
          <p className="text-sm text-muted-foreground">
            Applied in order — earlier rules win when two conflict. Every
            proposed link must name the rule that justifies it.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {RULES.map((r) => (
            <div key={r.id} className="flex gap-3">
              <Badge variant="outline" className="h-fit shrink-0 font-mono">
                {r.id}
              </Badge>
              <div>
                <div className="text-sm font-medium">{r.title}</div>
                <p className="text-sm text-muted-foreground">{r.body}</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">What you get back</CardTitle>
            <p className="text-sm text-muted-foreground">
              Four sections, in order, no preamble.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {OUTPUT_SECTIONS.map((s) => (
              <div key={s.n} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  {s.n}
                </span>
                <div>
                  <div className="text-sm font-medium">{s.title}</div>
                  <p className="text-sm text-muted-foreground">{s.body}</p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Guardrails baked in</CardTitle>
            <p className="text-sm text-muted-foreground">
              The prompt forbids the usual failure modes.
            </p>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
              <li>No invented pages, URLs, or metrics beyond the INPUTS.</li>
              <li>No link without a bridge sentence to justify it.</li>
              <li>
                No padding the map to look thorough — ten justified links beat
                forty guesses.
              </li>
              <li>
                Missing an input? It names the field and stops — it never
                estimates.
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base">Full prompt</CardTitle>
            <CopyButton getText={() => PROMPT_TEXT} label="Copy prompt" />
          </div>
        </CardHeader>
        <CardContent>
          <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-4 text-xs leading-relaxed">
            {PROMPT_TEXT}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
