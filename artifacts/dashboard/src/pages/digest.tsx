import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDigests,
  getListDigestsQueryKey,
  useRunJob,
  getJobStatus,
  type DigestItem,
  type DigestPayload,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  Newspaper,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  CheckCircle2,
  Trophy,
  ListTodo,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

const ACTION_TYPE_LABELS: Record<string, string> = {
  fix_losing_query: "Losing query",
  add_inbound_links: "Add inbound links",
  add_outbound_links: "Add outbound links",
  review_suggestions: "Review suggestions",
  optimize_content: "Optimize content",
  improve_ctr: "Improve CTR",
  fix_cannibalization: "Fix cannibalization",
};

function actionTypeLabel(t: string): string {
  return ACTION_TYPE_LABELS[t] ?? t.replace(/_/g, " ");
}

function fmtWeek(weekOf: string): string {
  const start = new Date(`${weekOf}T00:00:00Z`);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  return `${start.toLocaleDateString("en-US", opts)} – ${end.toLocaleDateString("en-US", { ...opts, year: "numeric" })}`;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || url;
  } catch {
    return url;
  }
}

function HealthDelta({ health }: { health: DigestPayload["health"] }) {
  const { current, previous, delta } = health;
  const Icon = delta == null || delta === 0 ? Minus : delta > 0 ? TrendingUp : TrendingDown;
  const tone =
    delta == null || delta === 0
      ? "text-muted-foreground"
      : delta > 0
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-red-600 dark:text-red-400";
  return (
    <div className="flex items-center gap-3" data-testid="digest-health">
      <span className="text-3xl font-bold tabular-nums">{current ?? "—"}</span>
      <div className={`flex items-center gap-1 text-sm font-medium ${tone}`}>
        <Icon className="h-4 w-4" />
        {delta == null
          ? previous == null
            ? "no prior snapshot"
            : "no change"
          : delta === 0
            ? "no change"
            : `${delta > 0 ? "+" : ""}${delta} since last snapshot`}
      </div>
    </div>
  );
}

function DigestBody({ payload }: { payload: DigestPayload }) {
  const winsTotal =
    payload.wins.improved + payload.wins.measuring + payload.wins.flat + payload.wins.declined;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            New issues found ({payload.newIssues.total})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {payload.newIssues.total === 0 ? (
            <p className="text-sm text-muted-foreground">No new issues surfaced this week.</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(payload.newIssues.byType).map(([type, n]) => (
                  <Badge key={type} variant="secondary" className="font-normal">
                    {actionTypeLabel(type)}: {n}
                  </Badge>
                ))}
              </div>
              <ul className="space-y-1.5">
                {payload.newIssues.top.map((item, i) => (
                  <li key={i} className="text-sm truncate" title={item.targetUrl}>
                    <span className="text-muted-foreground mr-1.5">
                      {actionTypeLabel(item.actionType)} ·
                    </span>
                    {item.title ?? pathOf(item.targetUrl)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            Work completed ({payload.completed.total})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {payload.completed.total === 0 ? (
            <p className="text-sm text-muted-foreground">No actions were completed this week.</p>
          ) : (
            <>
              <div className="flex gap-1.5">
                <Badge variant="secondary" className="font-normal">
                  Auto-resolved: {payload.completed.auto}
                </Badge>
                <Badge variant="secondary" className="font-normal">
                  Manual: {payload.completed.manual}
                </Badge>
              </div>
              <ul className="space-y-1.5">
                {payload.completed.top.map((item, i) => (
                  <li key={i} className="text-sm truncate" title={item.targetUrl}>
                    <span className="text-muted-foreground mr-1.5">
                      {actionTypeLabel(item.actionType)} ·
                    </span>
                    {item.title ?? pathOf(item.targetUrl)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Trophy className="h-4 w-4 text-primary" />
            Impact wins
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {winsTotal === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing measured yet — wins appear ~2 weeks after work is completed.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="secondary" className="font-normal">Improved: {payload.wins.improved}</Badge>
                <Badge variant="secondary" className="font-normal">Measuring: {payload.wins.measuring}</Badge>
                <Badge variant="secondary" className="font-normal">Flat: {payload.wins.flat}</Badge>
                <Badge variant="secondary" className="font-normal">Declined: {payload.wins.declined}</Badge>
              </div>
              {payload.wins.top.length > 0 && (
                <ul className="space-y-1.5">
                  {payload.wins.top.map((w, i) => (
                    <li key={i} className="text-sm flex items-center gap-2 min-w-0" title={w.url}>
                      <span className="truncate">{pathOf(w.url)}</span>
                      <span className="text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                        {w.deltaClicks != null && `${w.deltaClicks > 0 ? "+" : ""}${Math.round(w.deltaClicks)} clicks/wk`}
                        {w.deltaImpressions != null &&
                          ` · ${w.deltaImpressions > 0 ? "+" : ""}${Math.round(w.deltaImpressions).toLocaleString()} impr/wk`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <ListTodo className="h-4 w-4 text-muted-foreground" />
            Still open
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm">
            <span className="text-2xl font-bold tabular-nums mr-2" data-testid="digest-open-actions">
              {payload.openActions}
            </span>
            actions waiting in the queue.
          </p>
          <Link href="/actions">
            <Button variant="outline" size="sm" data-testid="button-digest-open-queue">
              Open Action Queue
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

function DigestSection({ digest, defaultOpen }: { digest: DigestItem; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="space-y-4" data-testid={`digest-week-${digest.weekOf}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4 text-left group"
        data-testid={`button-toggle-digest-${digest.weekOf}`}
      >
        <div className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <h2 className="text-lg font-semibold group-hover:text-primary transition-colors">
            Week of {fmtWeek(digest.weekOf)}
          </h2>
        </div>
        <HealthDelta health={digest.payload.health} />
      </button>
      {open && <DigestBody payload={digest.payload} />}
    </div>
  );
}

export default function DigestPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const digests = useListDigests({ query: { queryKey: getListDigestsQueryKey() } });
  const runJob = useRunJob();

  const [generating, setGenerating] = useState(false);

  const pollUntilDone = async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const statuses = await getJobStatus();
        const job = statuses.find((s) => s.name === "weekly_digest");
        if (!job || !job.running) break;
      } catch {
        break;
      }
    }
    await queryClient.invalidateQueries({ queryKey: getListDigestsQueryKey() });
    setGenerating(false);
  };

  const handleGenerate = () => {
    runJob.mutate(
      { jobName: "weekly_digest" },
      {
        onSuccess: () => {
          toast({
            title: "Generating digest",
            description: "This week's digest will refresh when the job finishes.",
          });
          setGenerating(true);
          void pollUntilDone();
        },
        onError: () => toast({ title: "Failed to start digest job", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="space-y-8 max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Newspaper className="h-6 w-6 text-primary" />
            Weekly Digest
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            What happened, what got done, and what improved — one summary per week, generated
            automatically every Friday at 10:00 UTC.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={handleGenerate}
          disabled={runJob.isPending || generating}
          data-testid="button-generate-digest"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${runJob.isPending || generating ? "animate-spin" : ""}`} />
          {generating ? "Refreshing…" : "Refresh this week"}
        </Button>
      </div>

      {digests.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <div className="grid gap-4 md:grid-cols-2">
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
          </div>
        </div>
      ) : digests.isError ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-destructive">
            Failed to load digests.
          </CardContent>
        </Card>
      ) : !digests.data || digests.data.items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <p className="text-sm text-muted-foreground">
              No digests yet. The first one is generated automatically on Friday — or create this
              week's now.
            </p>
            <Button onClick={handleGenerate} disabled={runJob.isPending || generating} data-testid="button-generate-first-digest">
              Generate this week's digest
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-10">
          {digests.data.items.map((d, i) => (
            <DigestSection key={d.id} digest={d} defaultOpen={i === 0} />
          ))}
        </div>
      )}
    </div>
  );
}
