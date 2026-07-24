import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useListLinkLookups,
  getListLinkLookupsQueryKey,
  useListOptimizeQueue,
  getListOptimizeQueueQueryKey,
  useListTrackedSubmissions,
  getListTrackedSubmissionsQueryKey,
  useCreateTrackedSubmissions,
  useDeleteTrackedSubmission,
  useExportSubmissionsSheet,
  useGetMovementSheetInfo,
  getGetMovementSheetInfoQueryKey,
  type LinkLookup,
  type OptimizeQueueItem,
  type TrackedSubmission,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ClipboardList,
  Sparkles,
  Settings2,
  Target,
  ExternalLink,
  ChevronRight,
  Inbox,
  Plus,
  X,
  Search,
  LineChart,
  FileSpreadsheet,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";
import { TrackedPerformanceDialog } from "@/components/tracked-performance-dialog";

const DAY_OPTIONS = [
  { value: "7", label: "Last 7 days" },
  { value: "14", label: "Last 14 days" },
  { value: "30", label: "Last 30 days" },
  { value: "60", label: "Last 60 days" },
  { value: "90", label: "Last 90 days" },
  { value: "0", label: "All time" },
];

const TYPE_OPTIONS = [
  { value: "all", label: "All submissions" },
  { value: "tracked", label: "Tracked URLs" },
  { value: "lookup", label: "Suggest Links" },
  { value: "optimize", label: "Optimizer" },
];

type SubmissionType = "lookup" | "optimize" | "tracked";
type NormStatus =
  | "pending"
  | "processing"
  | "done"
  | "failed"
  | "skipped"
  | "tracking";

interface SubmissionItem {
  key: string;
  type: SubmissionType;
  trackedId?: number;
  keyword?: string | null;
  title: string;
  detail: string;
  externalUrl: string | null;
  pageHref: string;
  pageLabel: string;
  status: NormStatus;
  timestamp: string;
  completedAt?: string | null;
  priority?: string;
  isTopic?: boolean;
}

const STATUS_META: Record<NormStatus, { label: string; className: string }> = {
  pending: {
    label: "Queued",
    className:
      "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
  },
  processing: {
    label: "Processing",
    className: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30",
  },
  done: {
    label: "Done",
    className:
      "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  },
  failed: {
    label: "Failed",
    className: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
  },
  skipped: {
    label: "Skipped",
    className: "bg-muted text-muted-foreground border-border",
  },
  tracking: {
    label: "Tracking",
    className:
      "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
  },
};

const TYPE_STYLE: Record<
  SubmissionType,
  { icon: typeof Sparkles; circle: string }
> = {
  lookup: { icon: Sparkles, circle: "bg-primary/10 text-primary" },
  optimize: {
    icon: Settings2,
    circle: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
  tracked: {
    icon: Target,
    circle: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  },
};

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function todayKey(): string {
  return dayKey(new Date().toISOString());
}

function yesterdayKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dayKey(d.toISOString());
}

function formatDayHeader(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  if (key === todayKey()) return "Today";
  if (key === yesterdayKey()) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    const p = (u.pathname + u.search).replace(/\/$/, "");
    return p || "/";
  } catch {
    return url;
  }
}

function lookupStatus(s: string): NormStatus {
  if (s === "ready") return "done";
  if (s === "failed") return "failed";
  return "pending";
}

function optimizeStatus(s: string): NormStatus {
  if (s === "done") return "done";
  if (s === "failed") return "failed";
  if (s === "skipped_no_gsc") return "skipped";
  if (s === "optimizing") return "processing";
  return "pending";
}

function trackedStatus(s: string): NormStatus {
  return s === "done" ? "done" : "tracking";
}

function mapLookup(l: LinkLookup): SubmissionItem {
  const isTopic = l.kind === "text";
  const url = isTopic ? null : l.resolvedUrl ?? l.inputValue;
  return {
    key: `lookup-${l.id}`,
    type: "lookup",
    title: isTopic
      ? l.label || l.inputValue
      : l.fetchedTitle || pathOf(url ?? l.inputValue),
    detail: isTopic ? `Topic: ${l.inputValue}` : pathOf(url ?? l.inputValue),
    externalUrl: url,
    pageHref: "/link-lookups",
    pageLabel: "Suggest Links",
    status: lookupStatus(l.status),
    timestamp: l.createdAt,
    completedAt: l.completedAt,
    isTopic,
  };
}

function mapOptimize(o: OptimizeQueueItem): SubmissionItem {
  return {
    key: `optimize-${o.id}`,
    type: "optimize",
    title: pathOf(o.url),
    detail: pathOf(o.url),
    externalUrl: o.url,
    pageHref: "/optimize",
    pageLabel: "Optimizer",
    status: optimizeStatus(o.status),
    timestamp: o.addedAt,
    completedAt: o.completedAt,
    priority: o.priority,
  };
}

function mapTracked(t: TrackedSubmission): SubmissionItem {
  return {
    key: `tracked-${t.id}`,
    type: "tracked",
    trackedId: t.id,
    keyword: t.keyword,
    title: t.label || pathOf(t.url),
    detail: t.note ? `${pathOf(t.url)} · ${t.note}` : pathOf(t.url),
    externalUrl: t.url,
    pageHref: "/submissions",
    pageLabel: "Tracking",
    status: trackedStatus(t.status),
    timestamp: t.createdAt,
    completedAt: t.completedAt,
  };
}

type DayGroup = {
  key: string;
  items: SubmissionItem[];
  lookupCount: number;
  optimizeCount: number;
  trackedCount: number;
};

export default function Submissions() {
  const [days, setDays] = useState("30");
  const [typeFilter, setTypeFilter] = useState("all");
  const [showAdd, setShowAdd] = useState(false);
  const [urlsText, setUrlsText] = useState("");
  const [noteText, setNoteText] = useState("");
  const [keywordText, setKeywordText] = useState("");
  const [perfItem, setPerfItem] = useState<SubmissionItem | null>(null);

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const lookupsQ = useListLinkLookups({
    query: {
      queryKey: getListLinkLookupsQueryKey(),
      refetchInterval: (q) =>
        (q.state.data ?? []).some(
          (x) =>
            lookupStatus(x.status) !== "done" &&
            lookupStatus(x.status) !== "failed",
        )
          ? 4000
          : false,
    },
  });
  const optimizeQ = useListOptimizeQueue({
    query: {
      queryKey: getListOptimizeQueueQueryKey(),
      refetchInterval: (q) =>
        (q.state.data ?? []).some((x) => {
          const s = optimizeStatus(x.status);
          return s === "pending" || s === "processing";
        })
          ? 4000
          : false,
    },
  });
  const trackedQ = useListTrackedSubmissions({
    query: { queryKey: getListTrackedSubmissionsQueryKey() },
  });
  const sheetInfoQ = useGetMovementSheetInfo({
    query: { queryKey: getGetMovementSheetInfoQueryKey() },
  });
  const movementSheetUrl = sheetInfoQ.data?.url ?? null;
  const movementSheetShared = sheetInfoQ.data?.shared ?? false;

  const createMutation = useCreateTrackedSubmissions();
  const deleteMutation = useDeleteTrackedSubmission();
  const exportMutation = useExportSubmissionsSheet();

  const trackedKeywordCount = (trackedQ.data ?? []).filter(
    (t) => (t.keyword ?? "").trim().length > 0,
  ).length;

  const handleExportSheet = () => {
    exportMutation.mutate(
      { data: { days: 90 } },
      {
        onSuccess: (result) => {
          window.open(result.url, "_blank", "noopener,noreferrer");
          queryClient.invalidateQueries({
            queryKey: getGetMovementSheetInfoQueryKey(),
          });
          toast({
            title: "Google Sheet updated",
            description: (
              <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2"
              >
                {result.title}
              </a>
            ),
          });
        },
        onError: () =>
          toast({
            variant: "destructive",
            title: "Export failed",
            description:
              trackedKeywordCount === 0
                ? "Add tracked URLs with a target keyword first."
                : "Google Sheets or Search Console didn't respond. Try again in a minute.",
          }),
      },
    );
  };

  const isLoading =
    lookupsQ.isLoading || optimizeQ.isLoading || trackedQ.isLoading;

  const handleAddTracked = (e: React.FormEvent) => {
    e.preventDefault();
    // Each line: "URL" alone, or "URL<TAB>keyword" / "URL, keyword" /
    // "URL keyword" — matches pasting two columns from a spreadsheet.
    const items = urlsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        let sep = line.indexOf("\t");
        if (sep === -1) sep = line.indexOf(",");
        if (sep === -1) sep = line.search(/\s/);
        if (sep === -1) return { url: line };
        const url = line.slice(0, sep).trim();
        const keyword = line.slice(sep + 1).trim();
        return keyword ? { url, keyword } : { url };
      })
      .filter((it) => it.url.length > 0);
    if (items.length === 0) return;
    createMutation.mutate(
      {
        data: {
          items,
          note: noteText.trim() || undefined,
          keyword: keywordText.trim() || undefined,
        },
      },
      {
        onSuccess: (created) => {
          toast({
            title: `Saved ${created.length} tracked URL${created.length === 1 ? "" : "s"}`,
            description:
              "Already-tracked URLs had their keyword updated instead of being duplicated.",
          });
          setUrlsText("");
          setNoteText("");
          setKeywordText("");
          setShowAdd(false);
          queryClient.invalidateQueries({
            queryKey: getListTrackedSubmissionsQueryKey(),
          });
        },
        onError: () =>
          toast({ variant: "destructive", title: "Couldn't add URLs" }),
      },
    );
  };

  const handleDeleteTracked = (item: SubmissionItem) => {
    if (item.trackedId == null) return;
    if (!window.confirm(`Remove "${item.title}" from your tracking list?`))
      return;
    deleteMutation.mutate(
      { id: item.trackedId },
      {
        onSuccess: () => {
          toast({ title: "Removed from tracking" });
          queryClient.invalidateQueries({
            queryKey: getListTrackedSubmissionsQueryKey(),
          });
        },
        onError: () =>
          toast({ variant: "destructive", title: "Couldn't remove URL" }),
      },
    );
  };

  const allItems = useMemo(() => {
    const items: SubmissionItem[] = [
      ...(lookupsQ.data ?? []).map(mapLookup),
      ...(optimizeQ.data ?? []).map(mapOptimize),
      ...(trackedQ.data ?? []).map(mapTracked),
    ];
    const cutoff =
      days === "0" ? 0 : Date.now() - Number(days) * 24 * 60 * 60 * 1000;
    return items
      .filter(
        // Still-open tracked URLs are a persistent checklist — never let the
        // day-window hide them; everything else respects the selected window.
        (it) =>
          it.status === "tracking" ||
          new Date(it.timestamp).getTime() >= cutoff,
      )
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
  }, [lookupsQ.data, optimizeQ.data, trackedQ.data, days]);

  const filteredItems = useMemo(
    () =>
      typeFilter === "all"
        ? allItems
        : allItems.filter((it) => it.type === typeFilter),
    [allItems, typeFilter],
  );

  // Still-open tracked URLs are a persistent checklist, not day-bound
  // activity — pin them in their own card above the timeline.
  const trackedOpen = useMemo(
    () => filteredItems.filter((it) => it.status === "tracking"),
    [filteredItems],
  );
  const timelineItems = useMemo(
    () => filteredItems.filter((it) => it.status !== "tracking"),
    [filteredItems],
  );

  const groups: DayGroup[] = useMemo(() => {
    const map = new Map<string, DayGroup>();
    for (const item of timelineItems) {
      const key = dayKey(item.timestamp);
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          items: [],
          lookupCount: 0,
          optimizeCount: 0,
          trackedCount: 0,
        };
        map.set(key, g);
      }
      g.items.push(item);
      if (item.type === "lookup") g.lookupCount += 1;
      else if (item.type === "optimize") g.optimizeCount += 1;
      else g.trackedCount += 1;
    }
    return Array.from(map.values()).sort((a, b) => b.key.localeCompare(a.key));
  }, [timelineItems]);

  // KPIs span every type in the window so the totals stay stable as the
  // type filter changes the timeline below.
  const total = allItems.length;
  const todayCount = allItems.filter(
    (it) => dayKey(it.timestamp) === todayKey(),
  ).length;
  const activeCount = allItems.filter(
    (it) => it.status === "pending" || it.status === "processing",
  ).length;
  const failedCount = allItems.filter((it) => it.status === "failed").length;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-none mb-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-3xl font-display text-foreground flex items-center gap-2">
              <ClipboardList className="h-7 w-7 text-primary" />
              My Submissions
              <InfoTip>
                A day-by-day log of the pages and topics you submit — Suggest
                Links lookups, Optimizer briefs, and your own custom tracked
                URLs — with their live status.
              </InfoTip>
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              {total} submission{total === 1 ? "" : "s"} in the selected window
            </p>
          </div>
          <div className="flex items-center gap-2">
            {movementSheetUrl && (
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  asChild
                  title="Opens this site's persistent daily-movement Google Sheet (refreshed every morning by the daily sync job)"
                >
                  <a
                    href={movementSheetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <FileSpreadsheet className="h-4 w-4" /> View daily movement
                    sheet <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
                {!movementSheetShared && (
                  <InfoTip>
                    This sheet lives in the operator's Google account and
                    hasn't been made link-viewable yet, so Google may show a
                    "Request access" page. Use that page to request access
                    with your Google account, or ask the operator to connect
                    Google Drive in Replit — once connected, every export and
                    nightly refresh shares the sheet automatically (anyone
                    with the link can view).
                  </InfoTip>
                )}
              </div>
            )}
            <Button
              variant={showAdd ? "secondary" : "default"}
              onClick={() => setShowAdd((v) => !v)}
            >
              <Plus className="h-4 w-4" /> Track URLs
            </Button>
            <Button
              variant="outline"
              onClick={handleExportSheet}
              disabled={exportMutation.isPending || trackedKeywordCount === 0}
              title={
                trackedKeywordCount === 0
                  ? "Add tracked URLs with a target keyword first"
                  : "Creates a Google Sheet with daily movement for every tracked keyword (last 90 days)"
              }
            >
              {exportMutation.isPending ? (
                <>
                  <Spinner className="h-4 w-4" /> Exporting…
                </>
              ) : (
                <>
                  <FileSpreadsheet className="h-4 w-4" /> Export to Sheets
                </>
              )}
            </Button>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {showAdd && (
          <Card className="border-border/50 mt-4">
            <CardContent className="p-4">
              <form onSubmit={handleAddTracked} className="space-y-3">
                <div>
                  <label className="text-sm font-medium text-foreground">
                    URLs to track
                  </label>
                  <p className="text-xs text-muted-foreground mb-1">
                    One URL per line, with an optional keyword after it —
                    paste both columns straight from your sheet (URL and
                    keyword separated by a tab, comma, or space). Re-pasting a
                    URL that's already tracked updates its keyword instead of
                    duplicating it. No fetching, crawling, or AI is run.
                  </p>
                  <Textarea
                    value={urlsText}
                    onChange={(e) => setUrlsText(e.target.value)}
                    placeholder={
                      "https://wellows.com/blog/ai-visibility-tools/, best ai visibility tools\nhttps://wellows.com/features/prompt-tracking/, prompt tracking\nhttps://wellows.com/tools/ai-overviews-tracker/"
                    }
                    rows={6}
                    className="font-mono text-sm"
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-sm font-medium text-foreground">
                      Default keyword (optional)
                    </label>
                    <p className="text-xs text-muted-foreground mb-1">
                      Used only for lines above that don't include their own
                      keyword. Keywords chart Search Console position over
                      time.
                    </p>
                    <Input
                      value={keywordText}
                      onChange={(e) => setKeywordText(e.target.value)}
                      placeholder="e.g. ai visibility tools"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground">
                      Note (optional)
                    </label>
                    <p className="text-xs text-muted-foreground mb-1">
                      A label to remind you why these are tracked.
                    </p>
                    <Input
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      placeholder="e.g. Q3 priority pages"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="submit"
                    disabled={
                      createMutation.isPending || urlsText.trim().length === 0
                    }
                  >
                    {createMutation.isPending ? (
                      <Spinner className="h-4 w-4" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}
                    Add to tracking
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setShowAdd(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
          <KpiCard label="Total" value={total} />
          <KpiCard label="Today" value={todayCount} accent="primary" />
          <KpiCard
            label="In progress"
            value={activeCount}
            accent="amber"
            hint="Submitted work that's still queued or processing — Suggest Links lookups and Optimizer briefs. Your tracked URLs live in their own card below."
          />
          <KpiCard label="Failed" value={failedCount} accent="red" />
        </div>

        <div className="mt-3">
          <HowThisWorks
            summary="A personal activity log of everything you've submitted — Suggest Links lookups, Optimizer briefs, and your own custom tracked URLs — grouped by day, newest first, with live status."
            steps={[
              {
                title: "Submit work as usual",
                body: "Every URL or topic you send to Suggest Links, and every page you add to the Optimizer, is recorded here automatically — nothing extra to do.",
              },
              {
                title: "Track any URL manually",
                body: "Use “Track URLs” to paste your own list of pages to keep an eye on. These are a plain checklist — nothing is fetched, crawled, or sent to AI — so there's no cost. When you're finished watching a URL, click the ✕ at the end of its row to remove it from the list.",
              },
              {
                title: "Track status day by day",
                body: "Each day groups your submissions with a live status: Queued, Processing, Done, or Failed for work you submitted, and Tracking for your own tracked URLs. The list auto-refreshes while anything is still running.",
              },
            ]}
            faqs={[
              {
                title: "How do I stop tracking a URL?",
                body: "Click the ✕ at the end of its row. That only removes it from your watchlist here — it doesn't change anything on your website. You can always add it back later with “Track URLs”.",
              },
              {
                title: "Does tracking a URL run Suggest Links or the Optimizer?",
                body: "No. Tracked URLs are a manual checklist only. Nothing is fetched, crawled, or sent to AI, so adding them costs nothing. Use Suggest Links or the Optimizer directly when you want to process a page.",
              },
              {
                title: "How is this different from the Dashboard activity feed?",
                body: "The Dashboard's \"What Changed\" feed tracks what changed on your site. This page tracks what you submitted or chose to follow — your lookups, queue additions, and custom tracked URLs.",
              },
            ]}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pr-1">
        {isLoading ? (
          <div className="flex items-center justify-center py-24">
            <Spinner className="h-8 w-8" />
          </div>
        ) : groups.length === 0 && trackedOpen.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center gap-2">
            <Inbox className="h-10 w-10 text-muted-foreground" />
            <div className="font-medium">No submissions in this window</div>
            <div className="text-sm text-muted-foreground max-w-md">
              Nothing matches the current filters. Track a URL with the “Track
              URLs” button, submit a lookup on Suggest Links, queue a page in the
              Optimizer, or widen the time window.
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {trackedOpen.length > 0 && (
              <div data-testid="section-tracked-urls">
                <div className="flex items-center gap-3 mb-2">
                  <h3 className="text-lg font-semibold text-foreground flex items-center gap-2">
                    <Target className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
                    Your tracked URLs
                  </h3>
                  <Badge variant="secondary">{trackedOpen.length}</Badge>
                  <span className="text-xs text-muted-foreground hidden sm:inline">
                    A standing watchlist — always shown here regardless of the
                    time window
                  </span>
                </div>
                <Card className="border-border/50">
                  <CardContent className="p-0 divide-y divide-border/60">
                    {trackedOpen.map((item) => (
                      <SubmissionRow
                        key={item.key}
                        item={item}
                        onDeleteTracked={handleDeleteTracked}
                        onOpenPerformance={setPerfItem}
                        deleteBusy={deleteMutation.isPending}
                      />
                    ))}
                  </CardContent>
                </Card>
              </div>
            )}
            {groups.length > 0 && trackedOpen.length > 0 && (
              <div className="flex items-center gap-3 pt-1">
                <h3 className="text-lg font-semibold text-foreground">
                  Activity log
                </h3>
                <span className="text-xs text-muted-foreground hidden sm:inline">
                  What you submitted, day by day
                </span>
              </div>
            )}
            {groups.map((g) => (
              <div key={g.key}>
                <div className="flex items-center gap-3 mb-2 sticky top-0 bg-background/95 backdrop-blur py-1 z-10">
                  <h3 className="text-lg font-semibold text-foreground">
                    {formatDayHeader(g.key)}
                  </h3>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {g.trackedCount > 0 && (
                      <Badge variant="secondary" className="gap-1">
                        <Target className="h-3 w-3" /> {g.trackedCount} tracked
                      </Badge>
                    )}
                    {g.lookupCount > 0 && (
                      <Badge variant="secondary" className="gap-1">
                        <Sparkles className="h-3 w-3" /> {g.lookupCount} lookup
                        {g.lookupCount === 1 ? "" : "s"}
                      </Badge>
                    )}
                    {g.optimizeCount > 0 && (
                      <Badge variant="secondary" className="gap-1">
                        <Settings2 className="h-3 w-3" /> {g.optimizeCount} optimize
                      </Badge>
                    )}
                  </div>
                </div>
                <Card className="border-border/50">
                  <CardContent className="p-0 divide-y divide-border/60">
                    {g.items.map((item) => (
                      <SubmissionRow
                        key={item.key}
                        item={item}
                        onDeleteTracked={handleDeleteTracked}
                        onOpenPerformance={setPerfItem}
                        deleteBusy={deleteMutation.isPending}
                      />
                    ))}
                  </CardContent>
                </Card>
              </div>
            ))}
          </div>
        )}
      </div>

      {perfItem && perfItem.trackedId != null && perfItem.externalUrl && (
        <TrackedPerformanceDialog
          key={perfItem.trackedId}
          trackedId={perfItem.trackedId}
          url={perfItem.externalUrl}
          keyword={perfItem.keyword ?? null}
          open
          onOpenChange={(o) => {
            if (!o) setPerfItem(null);
          }}
        />
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  accent,
  hint,
}: {
  label: string;
  value: number;
  accent?: "primary" | "amber" | "red";
  hint?: string;
}) {
  const accentClass =
    accent === "primary"
      ? "text-primary"
      : accent === "amber"
        ? "text-amber-600 dark:text-amber-400"
        : accent === "red"
          ? "text-red-600 dark:text-red-400"
          : "text-foreground";
  return (
    <Card className="border-border/50">
      <CardContent className="p-4">
        <div className="flex items-center gap-1 text-xs text-muted-foreground uppercase tracking-wide">
          {label}
          {hint && <InfoTip iconClassName="h-3 w-3">{hint}</InfoTip>}
        </div>
        <div className={`text-2xl font-semibold tabular-nums mt-1 ${accentClass}`}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function SubmissionRow({
  item,
  onDeleteTracked,
  onOpenPerformance,
  deleteBusy,
}: {
  item: SubmissionItem;
  onDeleteTracked: (item: SubmissionItem) => void;
  onOpenPerformance: (item: SubmissionItem) => void;
  deleteBusy: boolean;
}) {
  const isTracked = item.type === "tracked";
  const meta =
    isTracked && item.status === "done"
      ? { ...STATUS_META.done, label: "Finished" }
      : STATUS_META[item.status];
  const style = TYPE_STYLE[item.type];
  const Icon = style.icon;
  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors group">
      <div
        className={`flex-none flex items-center justify-center h-9 w-9 rounded-full ${style.circle}`}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          {item.externalUrl ? (
            <a
              href={item.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium truncate hover:text-primary inline-flex items-center gap-1"
              title={`Open ${item.externalUrl} in a new tab`}
            >
              <span className="truncate">{item.title}</span>
              <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
            </a>
          ) : (
            <span className="font-medium truncate">{item.title}</span>
          )}
          <Badge variant="outline" className={`flex-none ${meta.className}`}>
            {meta.label}
          </Badge>
          {item.priority && item.priority !== "medium" && (
            <Badge variant="secondary" className="flex-none capitalize">
              {item.priority}
            </Badge>
          )}
          {isTracked && item.keyword && (
            <Badge
              variant="secondary"
              className="flex-none gap-1 max-w-[16rem] truncate font-normal"
              title={`Target keyword: ${item.keyword}`}
            >
              <Search className="h-3 w-3" /> {item.keyword}
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground font-mono truncate">
          {item.detail}
        </div>
      </div>
      {isTracked ? (
        <div className="flex-none flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={() => onOpenPerformance(item)}
            title="View Search Console performance for this URL and keyword"
          >
            <LineChart className="h-3.5 w-3.5" /> Performance
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-red-600"
            disabled={deleteBusy}
            onClick={() => onDeleteTracked(item)}
            title="Remove from tracking"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <Link
          href={item.pageHref}
          className="flex-none text-xs text-muted-foreground hover:text-primary hidden sm:inline-flex items-center gap-1"
          title={`Go to ${item.pageLabel}`}
        >
          {item.pageLabel}
          <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      )}
      <div className="flex-none text-xs text-muted-foreground tabular-nums w-16 text-right">
        {formatTime(item.timestamp)}
      </div>
    </div>
  );
}
