import { useEffect, useMemo, useRef, useState } from "react";
import {
  useListLinkLookups,
  useCreateLinkLookups,
  useGetLinkLookup,
  useDeleteLinkLookup,
  getListLinkLookupsQueryKey,
  getGetLinkLookupQueryKey,
  type LinkLookup,
  type LinkLookupCandidate,
  type LinkLookupExistingLink,
  type LinkLookupInputItem,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Copy, ExternalLink, Trash2, RefreshCw, Upload, Send, Sparkles, Link2 } from "lucide-react";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";

function copy(text: string, toastFn: (o: { title: string }) => void): void {
  void navigator.clipboard.writeText(text).then(() => toastFn({ title: "Copied" }));
}

function parseUrls(raw: string): string[] {
  return raw
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"))
    .map((s) => {
      // CSV: take the first column if comma-delimited inside a single line
      const cell = s.split(",")[0];
      return cell ? cell.trim() : "";
    })
    .filter((s) => s.length > 0);
}

interface SubmitArgs {
  inputs: LinkLookupInputItem[];
  resetAfter?: () => void;
}

function useSubmitLookups() {
  const create = useCreateLinkLookups();
  const qc = useQueryClient();
  const { toast } = useToast();
  return {
    isPending: create.isPending,
    submit: (args: SubmitArgs) => {
      if (args.inputs.length === 0) {
        toast({ title: "Nothing to submit" });
        return;
      }
      create.mutate(
        { data: { inputs: args.inputs } },
        {
          onSuccess: (resp) => {
            toast({ title: `Queued ${resp.ids.length} lookup${resp.ids.length === 1 ? "" : "s"}` });
            qc.invalidateQueries({ queryKey: getListLinkLookupsQueryKey() });
            args.resetAfter?.();
          },
          onError: (err) => {
            const msg = err instanceof Error ? err.message : "Failed to queue lookup";
            toast({ title: msg, variant: "destructive" });
          },
        },
      );
    },
  };
}

function SingleUrlForm() {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const { submit, isPending } = useSubmitLookups();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          Single URL
          <InfoTip>Paste a published blog URL. The system fetches the page, lists the in-body internal links already on it (both directions, with their anchor text), then suggests net-new pages to link TO and pages that should link IN.</InfoTip>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input placeholder="https://example.com/blog/post" value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono text-sm" />
        <Input placeholder="Optional label" value={label} onChange={(e) => setLabel(e.target.value)} />
        <div className="flex justify-end">
          <Button
            onClick={() => submit({
              inputs: [{ kind: "url", value: url.trim(), label: label.trim() || null }],
              resetAfter: () => { setUrl(""); setLabel(""); },
            })}
            disabled={isPending || !url.trim()}
          >
            <Send className="h-4 w-4 mr-1" />
            {isPending ? "Submitting…" : "Get suggestions"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function BulkUrlsForm() {
  const [raw, setRaw] = useState("");
  const urls = useMemo(() => parseUrls(raw), [raw]);
  const { submit, isPending } = useSubmitLookups();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          Bulk URLs
          <InfoTip>Paste many URLs — one per line, or comma-separated. Up to 50 per submission. Each is processed independently.</InfoTip>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          placeholder={`https://example.com/blog/a\nhttps://example.com/blog/b`}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={8}
          className="font-mono text-xs"
        />
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">{urls.length} URL{urls.length === 1 ? "" : "s"} detected{urls.length > 50 ? " — only first 50 will be sent" : ""}</div>
          <Button
            onClick={() => submit({
              inputs: urls.slice(0, 50).map((u) => ({ kind: "url" as const, value: u, label: null })),
              resetAfter: () => setRaw(""),
            })}
            disabled={isPending || urls.length === 0}
          >
            <Send className="h-4 w-4 mr-1" />
            {isPending ? "Submitting…" : `Submit ${Math.min(urls.length, 50)}`}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TopicForm() {
  const [topic, setTopic] = useState("");
  const [label, setLabel] = useState("");
  const { submit, isPending } = useSubmitLookups();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          Topic / Keyword / Description
          <InfoTip>No URL yet? Paste a topic, keyword, or short description of the upcoming blog and we'll surface existing pages most relevant to it (outbound only — there's no URL for back-links yet).</InfoTip>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          placeholder="e.g. 'guide to choosing an ergonomic office chair for back pain'"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          rows={4}
        />
        <Input placeholder="Optional label" value={label} onChange={(e) => setLabel(e.target.value)} />
        <div className="flex justify-end">
          <Button
            onClick={() => submit({
              inputs: [{ kind: "text", value: topic.trim(), label: label.trim() || null }],
              resetAfter: () => { setTopic(""); setLabel(""); },
            })}
            disabled={isPending || topic.trim().length < 5}
          >
            <Send className="h-4 w-4 mr-1" />
            {isPending ? "Submitting…" : "Find pages"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CsvForm() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string[]>([]);
  const { submit, isPending } = useSubmitLookups();
  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      setPreview(parseUrls(text));
    };
    reader.readAsText(file);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          CSV upload
          <InfoTip>Upload a CSV. The first column of every non-empty row is treated as a URL. Up to 50 are submitted per upload.</InfoTip>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" className="hidden" onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }} />
          <Button variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4 mr-1" /> Choose CSV
          </Button>
          <span className="text-xs text-muted-foreground">{preview.length} URL{preview.length === 1 ? "" : "s"} detected</span>
        </div>
        {preview.length > 0 && (
          <div className="border rounded p-2 max-h-32 overflow-y-auto font-mono text-[11px] text-muted-foreground bg-muted/40">
            {preview.slice(0, 10).map((u, i) => <div key={i} className="truncate">{u}</div>)}
            {preview.length > 10 && <div>… +{preview.length - 10} more</div>}
          </div>
        )}
        <div className="flex justify-end">
          <Button
            onClick={() => submit({
              inputs: preview.slice(0, 50).map((u) => ({ kind: "url" as const, value: u, label: null })),
              resetAfter: () => { setPreview([]); if (fileRef.current) fileRef.current.value = ""; },
            })}
            disabled={isPending || preview.length === 0}
          >
            <Send className="h-4 w-4 mr-1" />
            {isPending ? "Submitting…" : `Submit ${Math.min(preview.length, 50)}`}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// Links that ALREADY exist on the page (pulled from the crawled link graph),
// shown so the operator can see current state and avoid re-adding them.
function ExistingLinksList({
  title,
  description,
  emptyText,
  items,
}: {
  title: string;
  description: string;
  emptyText: string;
  items: LinkLookupExistingLink[];
}) {
  return (
    <div className="space-y-1.5">
      <div>
        <div className="font-medium text-xs flex items-center gap-1.5">
          <Link2 className="h-3.5 w-3.5 text-emerald-600" />
          {title}
          {items.length > 0 && <Badge variant="secondary" className="text-[10px]">{items.length}</Badge>}
        </div>
        <div className="text-[11px] text-muted-foreground">{description}</div>
      </div>
      {items.length === 0 ? (
        <div className="text-[11px] text-muted-foreground italic border rounded border-dashed p-2">{emptyText}</div>
      ) : (
        <div className="border rounded divide-y bg-emerald-50/40 dark:bg-emerald-950/10">
          {items.map((c) => (
            <div key={c.url} className="p-2 text-xs">
              <a href={c.url} target="_blank" rel="noreferrer" className="font-medium truncate hover:underline flex items-center gap-1" title={c.url}>
                {c.title || c.url}
                <ExternalLink className="h-3 w-3 inline opacity-60 shrink-0" />
              </a>
              <div className="mt-0.5 text-[10px] text-muted-foreground font-mono truncate">
                {c.anchorText ? `anchor: \u201C${c.anchorText}\u201D` : <span className="italic">no anchor text captured</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CandidateList({
  title,
  description,
  items,
  hiddenAlready = 0,
}: {
  title: string;
  description: string;
  items: LinkLookupCandidate[];
  hiddenAlready?: number;
}) {
  const { toast } = useToast();
  return (
    <div className="space-y-2">
      <div>
        <div className="font-medium text-xs flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          {title}
          {items.length > 0 && <Badge variant="secondary" className="text-[10px]">{items.length}</Badge>}
        </div>
        <div className="text-[11px] text-muted-foreground">{description}</div>
      </div>
      {items.length === 0 ? (
        <div className="text-[11px] text-muted-foreground italic border rounded border-dashed p-2">
          {hiddenAlready > 0
            ? `All ${hiddenAlready} relevant ${hiddenAlready === 1 ? "page is" : "pages are"} already linked — nothing new to add.`
            : "No matches above the similarity threshold."}
        </div>
      ) : (
        <div className="border rounded divide-y">
          {items.map((c) => (
            <div key={c.url} className="p-2 text-xs hover:bg-muted/30">
              <div className="flex items-center justify-between gap-2">
                <a href={c.url} target="_blank" rel="noreferrer" className="font-medium truncate hover:underline flex items-center gap-1" title={c.url}>
                  {c.title || c.url}
                  <ExternalLink className="h-3 w-3 inline opacity-60" />
                </a>
                <Badge variant="outline" className="font-mono text-[10px] shrink-0">
                  {(c.total * 100).toFixed(0)}
                </Badge>
              </div>
              <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground font-mono">
                <span>sim {(c.similarity * 100).toFixed(0)}</span>
                <span>gsc× {c.gscBoost.toFixed(2)}</span>
                <span>clk {c.gscClicks}</span>
                <span>imp {c.gscImpressions}</span>
                {c.anchorHint && (
                  <button
                    className="ml-auto hover:text-foreground flex items-center gap-1"
                    onClick={() => {
                      // Escape so a URL or anchor containing quotes/angle
                      // brackets can't inject extra markup when the operator
                      // pastes this snippet into their CMS HTML editor.
                      const esc = (s: string) =>
                        s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                      copy(`<a href="${esc(c.url)}">${esc(c.anchorHint ?? "")}</a>`, toast);
                    }}
                    title="Copy <a> tag with suggested anchor"
                  >
                    <Copy className="h-3 w-3" /> {c.anchorHint}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {items.length > 0 && hiddenAlready > 0 && (
        <div className="text-[10px] text-muted-foreground italic">
          +{hiddenAlready} more relevant {hiddenAlready === 1 ? "page" : "pages"} already linked (shown above).
        </div>
      )}
    </div>
  );
}

function LookupCard({ lookup }: { lookup: LinkLookup }) {
  const qc = useQueryClient();
  const del = useDeleteLinkLookup();
  const { toast } = useToast();
  // Poll for completion while pending.
  const pending = lookup.status === "pending";
  const detail = useGetLinkLookup(lookup.id, {
    query: {
      queryKey: getGetLinkLookupQueryKey(lookup.id),
      enabled: pending,
      refetchInterval: pending ? 2500 : false,
    },
  });
  const view = (detail.data ?? lookup) as LinkLookup;

  useEffect(() => {
    if (detail.data && detail.data.status !== "pending") {
      qc.invalidateQueries({ queryKey: getListLinkLookupsQueryKey() });
    }
  }, [detail.data, qc]);

  const removeLookup = () => {
    del.mutate({ id: lookup.id }, {
      onSuccess: () => {
        toast({ title: "Deleted" });
        qc.invalidateQueries({ queryKey: getListLinkLookupsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetLinkLookupQueryKey(lookup.id) });
      },
    });
  };

  const headerLabel = view.label || view.fetchedTitle || (view.kind === "url" ? view.inputValue : view.inputValue.slice(0, 80));

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base truncate" title={headerLabel}>{headerLabel}</CardTitle>
            <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-2 items-center">
              <Badge variant="secondary" className="text-[10px]">{view.kind}</Badge>
              <Badge
                variant={view.status === "ready" ? "default" : view.status === "failed" ? "destructive" : "outline"}
                className="text-[10px]"
              >
                {view.status}
              </Badge>
              {view.fetcherUsed && (
                <Badge variant="outline" className="text-[10px]">via {view.fetcherUsed}</Badge>
              )}
              {view.wordCount ? <span className="font-mono">{view.wordCount}w</span> : null}
              {view.durationMs ? <span className="font-mono">{Math.round(view.durationMs)}ms</span> : null}
            </div>
            {view.kind === "url" && (
              <div className="text-[11px] text-muted-foreground mt-1 truncate font-mono" title={view.inputValue}>
                {view.inputValue}
              </div>
            )}
          </div>
          <Button size="sm" variant="ghost" onClick={removeLookup} title="Delete lookup">
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {view.status === "pending" ? (
          <div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
            <Spinner /> Fetching content and scoring against the inventory…
          </div>
        ) : view.status === "failed" ? (
          <div className="text-sm text-destructive border border-destructive/30 bg-destructive/5 p-3 rounded">
            {view.error ?? "Lookup failed"}
          </div>
        ) : (
          <div className="grid md:grid-cols-2 gap-5">
            <div className="space-y-3">
              <div>
                <div className="font-medium text-sm">Outbound — links from this page</div>
                <div className="text-xs text-muted-foreground">What this content links out to.</div>
              </div>
              {view.kind === "url" && (
                <ExistingLinksList
                  title="Already linked from here"
                  description="In-body links this page already points to — no need to re-add."
                  emptyText="No in-body outbound links found on this page yet."
                  items={view.existingOutbound ?? []}
                />
              )}
              <CandidateList
                title="Suggested to add"
                description="Relevant pages not yet linked from this page. Add these as in-body links."
                items={view.outboundResults.filter((c) => !c.alreadyLinked)}
                hiddenAlready={view.outboundResults.filter((c) => c.alreadyLinked).length}
              />
            </div>
            <div className="space-y-3">
              <div>
                <div className="font-medium text-sm">Inbound — links to this page</div>
                <div className="text-xs text-muted-foreground">
                  {view.kind === "text" ? "Only available for URL inputs (no destination yet)." : "What should link back to this URL."}
                </div>
              </div>
              {view.kind === "url" && (
                <ExistingLinksList
                  title="Already linking here"
                  description="Pages that already link to this URL in-body."
                  emptyText="No in-body inbound links found for this page yet."
                  items={view.existingInbound ?? []}
                />
              )}
              <CandidateList
                title="Suggested to add"
                description={view.kind === "text" ? "Submit a URL to see pages that should link to it." : "Relevant pages that should link to this URL but don't yet."}
                items={view.inboundResults.filter((c) => !c.alreadyLinked)}
                hiddenAlready={view.inboundResults.filter((c) => c.alreadyLinked).length}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function LinkLookupsPage() {
  const { data, isLoading } = useListLinkLookups();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: getListLinkLookupsQueryKey() });

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Suggest Links</h1>
          <p className="text-sm text-muted-foreground mt-1">
            On-demand internal link recommendations for any URL, batch of URLs, or topic. Ranked by semantic relevance combined with Google Search Console clicks &amp; impressions.
          </p>
        </div>
        <Button variant="outline" onClick={refresh}>
          <RefreshCw className="h-4 w-4 mr-1" /> Refresh
        </Button>
      </div>

      <HowThisWorks
        summary="On-demand companion to the semantic linker — paste a URL, a batch, or a topic and we'll surface the best places to link from or to, ranked by relevance and GSC traffic."
        steps={[
          { title: "Pick a mode", body: "Single URL = find sources to link to one page. Bulk URLs = same thing across many targets. Topic = anchor-text driven search. CSV = upload a list of URLs or topics." },
          { title: "Submit the job", body: "We score every candidate page against the target using semantic embeddings combined with GSC clicks and impressions (the same engine the semantic linker uses)." },
          { title: "Review existing vs new", body: "For a URL, each column first lists the in-body links already on the page (with their current anchor text), then the net-new suggestions. Pages you've already linked are removed from the suggestions, so the list is purely things to implement." },
          { title: "Copy and implement", body: "Each suggestion shows a score breakdown and a recommended anchor. Click the anchor button to copy a ready-to-paste <a> tag for your CMS." },
        ]}
        faqs={[
          { title: "How is this different from Semantic Links?", body: "Semantic Links runs across the whole site on a schedule and writes long-lived proposals. Link Lookups is ad-hoc — answer one question, throw away the result." },
          { title: "What does 'Already linked' mean?", body: "We cross-check each suggestion against your crawled link graph. Pages you already link to (or that already link to you) in the body show under 'Already linked' and are removed from the suggestions, so you never re-add an existing link." },
          { title: "Why are some URLs missing?", body: "We only consider URLs that have been crawled and embedded. Run the WordPress crawler + reembed job if a page is missing." },
        ]}
      />

      <Tabs defaultValue="single">
        <TabsList>
          <TabsTrigger value="single">Single URL</TabsTrigger>
          <TabsTrigger value="bulk">Bulk URLs</TabsTrigger>
          <TabsTrigger value="topic">Topic / Keyword</TabsTrigger>
          <TabsTrigger value="csv">CSV Upload</TabsTrigger>
        </TabsList>
        <TabsContent value="single" className="mt-4"><SingleUrlForm /></TabsContent>
        <TabsContent value="bulk" className="mt-4"><BulkUrlsForm /></TabsContent>
        <TabsContent value="topic" className="mt-4"><TopicForm /></TabsContent>
        <TabsContent value="csv" className="mt-4"><CsvForm /></TabsContent>
      </Tabs>

      <div className="space-y-3">
        <div className="text-sm font-medium text-muted-foreground">Recent lookups</div>
        {isLoading ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : (data ?? []).length === 0 ? (
          <div className="border rounded border-dashed p-12 text-center text-muted-foreground text-sm">
            No lookups yet. Submit one above.
          </div>
        ) : (
          <div className="space-y-3">
            {(data ?? []).map((l) => <LookupCard key={l.id} lookup={l} />)}
          </div>
        )}
      </div>
    </div>
  );
}
