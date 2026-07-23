import { useState } from "react";
import { useListOptimizeQueue, useAddOptimizeQueueItem, useRequeueOptimizeItem, useRunOptimizeItem, getListOptimizeQueueQueryKey, useRunJob, useGetJobStatus, getGetJobStatusQueryKey, type JobStatus, type GroundingPassage } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Play, FileText, Plus, Loader2, Zap, BookOpen } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { OptimizeQueueInputPriority } from "@workspace/api-client-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";
import { JobSpendCapNotice } from "@/components/spend-cap-badge";

export default function Optimize() {
  const { data: queue, isLoading } = useListOptimizeQueue({
    query: {
      queryKey: getListOptimizeQueueQueryKey(),
      refetchInterval: (query) => {
        const rows = query.state.data ?? [];
        return rows.some((r) => r.status === "optimizing") ? 4000 : false;
      },
    },
  });
  const addMutation = useAddOptimizeQueueItem();
  const requeueMutation = useRequeueOptimizeItem();
  const runItemMutation = useRunOptimizeItem();
  const runJobMutation = useRunJob();
  const { data: jobStatuses } = useGetJobStatus({
    query: { refetchInterval: 5000, queryKey: getGetJobStatusQueryKey() },
  });
  const optimizeJob = jobStatuses?.find((j: JobStatus) => j.name === "optimize_queued_urls");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleRunOptimize = () => {
    runJobMutation.mutate(
      { jobName: "optimize_queued_urls" },
      {
        onSuccess: () => {
          toast({
            title: "Optimize job started",
            description: "Briefs are being generated for every queued URL. Refreshing in real time.",
          });
          queryClient.invalidateQueries({ queryKey: getGetJobStatusQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListOptimizeQueueQueryKey() });
        },
        onError: (err: unknown) => {
          const msg =
            err && typeof err === "object" && "message" in err
              ? String((err as { message: unknown }).message)
              : "Failed to start optimize job";
          toast({ variant: "destructive", title: "Couldn't start job", description: msg });
        },
      },
    );
  };

  const pendingCount = queue?.filter((i) => i.status === "optimize" || i.status === "optimizing").length ?? 0;
  const isOptimizeRunning = optimizeJob?.running ?? false;

  const [url, setUrl] = useState("");
  const [priority, setPriority] = useState<OptimizeQueueInputPriority>("medium");
  const [notes, setNotes] = useState("");

  const [briefDrawerOpen, setBriefDrawerOpen] = useState(false);
  const [activeBrief, setActiveBrief] = useState<{
    url: string;
    content: string;
    // null = brief predates grounding capture (hide the panel);
    // [] = brief was generated with no KB grounding (show explicit note).
    passages: GroundingPassage[] | null;
  } | null>(null);

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;

    addMutation.mutate(
      { data: { url, priority, notes } },
      {
        onSuccess: () => {
          toast({ title: "Added to queue" });
          setUrl("");
          setNotes("");
          setPriority("medium");
          queryClient.invalidateQueries({ queryKey: getListOptimizeQueueQueryKey() });
        },
        onError: () => {
          toast({ variant: "destructive", title: "Failed to add to queue" });
        }
      }
    );
  };

  const handleOptimizeNow = (id: number, url: string) => {
    runItemMutation.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Optimize started", description: `Brief is being generated for ${url}. The row will refresh automatically.` });
          queryClient.invalidateQueries({ queryKey: getListOptimizeQueueQueryKey() });
        },
        onError: (err: unknown) => {
          const msg = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : "Failed to start";
          toast({ variant: "destructive", title: "Couldn't start", description: msg });
        },
      },
    );
  };

  const handleRequeue = (id: number) => {
    requeueMutation.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Requeued successfully" });
          queryClient.invalidateQueries({ queryKey: getListOptimizeQueueQueryKey() });
        },
        onError: () => {
          toast({ variant: "destructive", title: "Failed to requeue" });
        }
      }
    );
  };

  const viewBrief = (
    url: string,
    content: string | null | undefined,
    passages: GroundingPassage[] | null | undefined,
  ) => {
    if (!content) return;
    setActiveBrief({ url, content, passages: passages ?? null });
    setBriefDrawerOpen(true);
  };

  const getStatusColor = (status: string) => {
    switch(status) {
      case "completed": return "bg-green-500/10 text-green-600 hover:bg-green-500/20";
      case "failed": return "bg-red-500/10 text-red-600 hover:bg-red-500/20";
      case "optimizing": return "bg-blue-500/10 text-blue-600 hover:bg-blue-500/20";
      default: return "bg-gray-500/10 text-gray-600 hover:bg-gray-500/20";
    }
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-3xl font-display text-foreground flex items-center gap-2">
            Optimization Queue
            <InfoTip>Queued pages that the AI will analyze and produce a content rewrite brief for. Add URLs manually or push them in from Query Losers.</InfoTip>
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Content update briefs generated by the Generative Engine Optimizer
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button
            onClick={handleRunOptimize}
            disabled={runJobMutation.isPending || isOptimizeRunning || pendingCount === 0}
            className="bg-primary text-primary-foreground"
          >
            {isOptimizeRunning ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Optimize running…
              </>
            ) : (
              <>
                <Play className="h-4 w-4 mr-2" />
                Run Optimize now ({pendingCount})
              </>
            )}
          </Button>
          <div className="text-xs text-muted-foreground text-right">
            {pendingCount === 0
              ? "No URLs awaiting a brief."
              : `${pendingCount} URL${pendingCount === 1 ? "" : "s"} will be processed.`}
            {optimizeJob?.lastRunAt && (
              <span> · Last run {new Date(optimizeJob.lastRunAt).toLocaleString()}</span>
            )}
          </div>
        </div>
      </div>

      <JobSpendCapNotice jobName="optimize_queued_urls" />

      <HowThisWorks
        defaultOpen
        summary="Each queued URL is enriched with live page content, 90 days of Search Console data, its internal link graph, and competitor SERP snippets, then Claude writes a Koray-style semantic SEO rewrite brief you can open from the Brief button."
        steps={[
          {
            title: "You add a URL to the queue",
            body: "Either paste a URL above (with a priority and optional notes) or push a losing page in from Query Losers. The row appears immediately with status Optimize.",
          },
          {
            title: "The optimize job picks it up",
            body: "On a schedule (Wednesdays 05:00 UTC) — or right away if you click Run optimize from the dashboard — the job processes every row whose status is Optimize, one URL at a time.",
          },
          {
            title: "We gather the page's full context",
            body: (
              <>
                For each URL we collect: the last 90 days of <strong>GSC query performance</strong>, the <strong>live page</strong>'s title / H1 / body (fetched with a 15s timeout), every <strong>inbound and outbound internal link</strong> from your link graph, and the <strong>top-5 competing SERP results</strong> for the page's three highest-impression queries (via DataForSEO).
              </>
            ),
          },
          {
            title: "Claude writes the brief",
            body: (
              <>
                All of that context is sent to Claude (claude-sonnet-4-6) with a prompt that applies <strong>Koray Tuğberk Güğbur's semantic SEO framework</strong>. The model returns Markdown containing a diagnosis, the primary target query, the proposed H2/H3 hierarchy, entity-gap analysis, internal-linking actions, and a prioritized 7-day action list.
              </>
            ),
          },
          {
            title: "You review the brief",
            body: "The row flips to Done and the Brief button lights up. Click it to open the side drawer with the full Markdown brief. Use Requeue to re-run after the page is updated, or if the previous run failed.",
          },
        ]}
        faqs={[
          {
            title: "Why does a row sometimes go to skipped_no_gsc?",
            body: "Search Console has no impressions for that URL in the last 90 days, so there's nothing meaningful for Claude to optimize against. Add inbound links or wait for indexing, then requeue.",
          },
          {
            title: "What does priority change?",
            body: "Priority is a label you set when queueing — it's stored on the row and visible in the table, but the current job iterates all Optimize rows without an explicit ORDER BY. Use it as a human sort/filter signal, not as execution order.",
          },
          {
            title: "What if the URL fails to fetch?",
            body: "We fall back to the title and H1 stored in your inventory table. If both the live fetch and the inventory lookup miss, the brief is still generated from GSC data + link graph + SERP context alone. A row is only marked Failed if the job throws (e.g. GSC, DataForSEO, or Claude error) — in which case the error message is appended to its notes.",
          },
          {
            title: "Are the briefs ever regenerated automatically?",
            body: "No. Once a brief is written it stays put. Click Requeue to flip the row back to Optimize and produce a fresh brief on the next run.",
          },
        ]}
        tips={[
          "Add a short note when queueing — it's passed straight into the prompt and Claude will tailor the brief to that angle.",
          "Push your Query Losers into the queue weekly — that's the highest-leverage workflow this dashboard is built around.",
        ]}
      />

      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            Add to Queue
            <InfoTip>Manually add any URL on the site to the optimization queue. Higher priority is processed first.</InfoTip>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="flex gap-4 items-start">
            <div className="flex-1 space-y-2">
              <Input 
                placeholder="URL to optimize (e.g. /blog/seo-tips)" 
                value={url} 
                onChange={(e) => setUrl(e.target.value)}
                required
              />
            </div>
            <div className="w-32 space-y-2">
              <Select value={priority} onValueChange={(v) => setPriority(v as OptimizeQueueInputPriority)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1 space-y-2">
              <Input 
                placeholder="Notes (optional)" 
                value={notes} 
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={addMutation.isPending}>
              <Plus className="h-4 w-4 mr-2" />
              Add
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="border-border/50">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center py-12"><Spinner /></div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>URL</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Added At</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queue?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                      Queue is empty
                    </TableCell>
                  </TableRow>
                ) : (
                  queue?.map(item => (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium max-w-[300px] truncate" title={item.url}>
                        {item.url}
                        {item.notes && <div className="text-xs text-muted-foreground font-normal truncate mt-0.5">{item.notes}</div>}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className={`capitalize ${getStatusColor(item.status)}`}>
                          {item.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">
                          {item.priority}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(item.addedAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <InfoTip>Open the AI-generated content rewrite brief for this page. Available once the job has completed.</InfoTip>
                          <Button 
                            variant="ghost" 
                            size="sm"
                            disabled={!item.briefMarkdown}
                            onClick={() => viewBrief(item.url, item.briefMarkdown, item.groundingPassages)}
                          >
                            <FileText className="h-4 w-4 mr-2" />
                            Brief
                          </Button>
                          <InfoTip>Generate the brief for just this URL right now, in the background. Use this instead of "Run Optimize" when you only want one row processed.</InfoTip>
                          <Button
                            variant="default"
                            size="sm"
                            onClick={() => handleOptimizeNow(item.id, item.url)}
                            disabled={runItemMutation.isPending || item.status === "optimizing"}
                            className="bg-primary text-primary-foreground"
                          >
                            {item.status === "optimizing" ? (
                              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Running…</>
                            ) : (
                              <><Zap className="h-4 w-4 mr-2" />Optimize now</>
                            )}
                          </Button>
                          <InfoTip>Re-run the optimization for this URL — useful after the page has been updated or if the previous run failed.</InfoTip>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRequeue(item.id)}
                            disabled={requeueMutation.isPending || item.status === "optimizing"}
                          >
                            <Play className="h-4 w-4 mr-2" />
                            Requeue
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Drawer open={briefDrawerOpen} onOpenChange={setBriefDrawerOpen}>
        <DrawerContent className="h-[85vh]">
          <div className="max-w-4xl w-full mx-auto flex flex-col h-full">
            <DrawerHeader>
              <DrawerTitle className="font-display tracking-wide text-2xl text-primary">Content Optimization Brief</DrawerTitle>
              <DrawerDescription className="text-base truncate">
                {activeBrief?.url}
              </DrawerDescription>
            </DrawerHeader>
            <div className="p-4 overflow-y-auto flex-1">
              {activeBrief?.passages !== null && activeBrief?.passages !== undefined && (
                <div className="mb-6 rounded-lg border bg-muted/40 p-4 not-prose">
                  <div className="flex items-center gap-2 mb-2">
                    <BookOpen className="h-4 w-4 text-primary" />
                    <span className="font-medium text-sm">Knowledge-base sources used</span>
                    <InfoTip>
                      The passages from your Knowledge Base that were most relevant to this
                      page and were injected into the brief prompt as grounding context,
                      with their similarity to the page's target query.
                    </InfoTip>
                  </div>
                  {activeBrief.passages.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No knowledge-base passages grounded this brief — the knowledge base was
                      empty or nothing was relevant enough.
                    </p>
                  ) : (
                    <ul className="space-y-3">
                      {activeBrief.passages.map((p, i) => (
                        <li key={`${p.documentId}-${p.chunkIndex}-${i}`} className="text-sm">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium">{p.documentTitle}</span>
                            <Badge variant="outline" className="text-xs">
                              passage {p.chunkIndex + 1}
                            </Badge>
                            <Badge variant="secondary" className="text-xs">
                              {Math.round(p.score * 100)}% match
                            </Badge>
                          </div>
                          <p className="text-muted-foreground mt-1 line-clamp-3">{p.excerpt}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <div className="prose prose-slate dark:prose-invert prose-blue max-w-none prose-headings:font-headers">
                {activeBrief?.content && (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {activeBrief.content}
                  </ReactMarkdown>
                )}
              </div>
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
}
