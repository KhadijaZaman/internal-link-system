import { HowThisWorks } from "@/components/how-this-works";
import { CopyButton } from "@/components/copy-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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

export default function LinkMapPrompt() {
  return (
    <div className="space-y-5">
      <HowThisWorks
        summary="A reusable prompt that turns a list of cluster pages into an auditable, rule-justified internal link map — every proposed link names the rule that justifies it, with anchor text, placement, and a bridge sentence."
        steps={[
          {
            title: "Copy the prompt",
            body: "Use the Copy prompt button — it copies the full prompt with the rules, output format, and guardrails.",
          },
          {
            title: "Fill the INPUTS",
            body: "Paste it into a new AI chat and fill in the central entity, hub, the pages-in-scope table, and your constraints. Assign each page's layer (hub / core / outer / commercial) before running — it drives the hierarchy and money-page rules.",
          },
          {
            title: "Run and apply",
            body: "You get a coverage matrix, proposed links sorted by impact (each with anchor, placement, and bridge sentence), flags for structural problems, and a do-not-link list.",
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
          <h1 className="text-xl font-semibold">Internal Link Map Prompt</h1>
          <p className="text-sm text-muted-foreground">
            Paste into a new AI chat, fill the INPUTS, and get a directed link
            map you can audit — not a pile of suggestions.
          </p>
        </div>
        <CopyButton
          getText={() => PROMPT_TEXT}
          label="Copy prompt"
          toastTitle="Prompt copied — paste it into a new AI chat"
        />
      </div>

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
