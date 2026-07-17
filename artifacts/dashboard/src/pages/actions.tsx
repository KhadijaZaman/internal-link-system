import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListActions,
  getListActionsQueryKey,
  useSetActionStatus,
  type ActionItem,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ListTodo,
  ArrowDownLeft,
  ArrowUpRight,
  TrendingDown,
  Inbox,
  Settings2,
  ExternalLink,
  Check,
  X,
  RotateCcw,
  ChevronRight,
  MousePointerClick,
  Split,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { HowThisWorks } from "@/components/how-this-works";
import { ImpactWins } from "@/components/impact-wins";

type StatusFilter = "open" | "done" | "dismissed" | "all";

const TYPE_CONFIG: Record<
  string,
  {
    label: string;
    icon: typeof ListTodo;
    badgeClass: string;
    route: string;
    routeLabel: string;
  }
> = {
  add_inbound_links: {
    label: "Add inbound links",
    icon: ArrowDownLeft,
    badgeClass: "bg-amber-100 text-amber-800 border-amber-200",
    route: "/structural",
    routeLabel: "Structural Fixes",
  },
  add_outbound_links: {
    label: "Add outbound links",
    icon: ArrowUpRight,
    badgeClass: "bg-sky-100 text-sky-800 border-sky-200",
    route: "/structural",
    routeLabel: "Structural Fixes",
  },
  fix_losing_query: {
    label: "Fix losing query",
    icon: TrendingDown,
    badgeClass: "bg-red-100 text-red-800 border-red-200",
    route: "/losers",
    routeLabel: "Query Losers",
  },
  review_suggestions: {
    label: "Review link suggestions",
    icon: Inbox,
    badgeClass: "bg-violet-100 text-violet-800 border-violet-200",
    route: "/suggestions",
    routeLabel: "Semantic Links",
  },
  optimize_content: {
    label: "Optimize content",
    icon: Settings2,
    badgeClass: "bg-emerald-100 text-emerald-800 border-emerald-200",
    route: "/optimize",
    routeLabel: "Optimizer",
  },
  improve_ctr: {
    label: "Improve CTR",
    icon: MousePointerClick,
    badgeClass: "bg-cyan-100 text-cyan-800 border-cyan-200",
    route: "/report",
    routeLabel: "Page Report",
  },
  fix_cannibalization: {
    label: "Fix cannibalization",
    icon: Split,
    badgeClass: "bg-orange-100 text-orange-800 border-orange-200",
    route: "/link-lookups",
    routeLabel: "Suggest Links",
  },
};

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/$/, "");
    return p || "/";
  } catch {
    return url;
  }
}

function fmtNum(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function ActionRow({
  item,
  onSetStatus,
  busy,
}: {
  item: ActionItem;
  onSetStatus: (id: number, status: "open" | "done" | "dismissed") => void;
  busy: boolean;
}) {
  const cfg = TYPE_CONFIG[item.actionType] ?? {
    label: item.actionType,
    icon: ListTodo,
    badgeClass: "bg-muted text-muted-foreground",
    route: "/",
    routeLabel: "Dashboard",
  };
  const Icon = cfg.icon;
  return (
    <Card data-testid={`card-action-${item.id}`}>
      <CardContent className="flex items-start gap-3 p-4">
        <div className="mt-0.5 rounded-md border bg-muted/40 p-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cfg.badgeClass}>
              {cfg.label}
            </Badge>
            <span
              className="text-xs font-medium text-muted-foreground"
              title="Priority score — action weight scaled by impressions at stake"
            >
              score {Math.round(item.score)}
            </span>
            {item.status !== "open" && (
              <Badge variant="secondary" className="text-xs">
                {item.status}
                {item.resolution === "auto" ? " (auto)" : ""}
              </Badge>
            )}
          </div>
          <div className="mt-1 truncate text-sm font-medium" title={item.targetUrl}>
            {item.title ?? pathOf(item.targetUrl)}
          </div>
          {item.description && (
            <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
              {item.description}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{fmtNum(item.impressionsAtStake)} impressions at stake</span>
            <span>{fmtNum(item.clicksAtStake)} clicks at stake</span>
            <a
              href={item.targetUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground"
              data-testid={`link-open-page-${item.id}`}
            >
              <ExternalLink className="h-3 w-3" />
              open page
            </a>
            <Link
              href={cfg.route}
              className="inline-flex items-center gap-1 hover:text-foreground"
              data-testid={`link-goto-tool-${item.id}`}
            >
              <ChevronRight className="h-3 w-3" />
              {cfg.routeLabel}
            </Link>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {item.status === "open" ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onSetStatus(item.id, "done")}
                data-testid={`button-done-${item.id}`}
              >
                <Check className="mr-1 h-3.5 w-3.5" />
                Done
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onSetStatus(item.id, "dismissed")}
                data-testid={`button-dismiss-${item.id}`}
              >
                <X className="mr-1 h-3.5 w-3.5" />
                Dismiss
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => onSetStatus(item.id, "open")}
              data-testid={`button-reopen-${item.id}`}
            >
              <RotateCcw className="mr-1 h-3.5 w-3.5" />
              Reopen
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function Actions() {
  const [status, setStatus] = useState<StatusFilter>("open");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useListActions(
    { status },
    { query: { queryKey: getListActionsQueryKey({ status }) } },
  );

  const mutation = useSetActionStatus({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ["/actions"] });
        void queryClient.invalidateQueries({
          predicate: (q) =>
            typeof q.queryKey[0] === "string" && q.queryKey[0].includes("/actions"),
        });
      },
      onError: () => {
        toast({
          title: "Update failed",
          description: "Could not update the action. Try again.",
          variant: "destructive",
        });
      },
    },
  });

  const onSetStatus = (id: number, next: "open" | "done" | "dismissed") => {
    mutation.mutate({ id, data: { status: next } });
  };

  const counts = data?.counts;
  const items = data?.items ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ListTodo className="h-6 w-6" />
          Action Queue
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything worth doing next, ranked by search opportunity. Refreshed
          automatically after each crawl and GSC sync.
        </p>
      </div>

      <HowThisWorks
        summary="One ranked to-do list built from orphans, dead ends, losing queries, pending suggestions, and the optimize queue."
        steps={[
          {
            title: "Signals are collected",
            body: "After every crawl, GSC sync, and semantic-linking run, the queue rebuilds from five signals: orphan pages (need inbound links), dead-end pages (need outbound links), queries losing position, pending semantic link suggestions, and pages queued in the Optimizer.",
          },
          {
            title: "Each action is scored",
            body: "Score = action-type weight × traffic scale. The weight reflects how impactful the fix type usually is, and the traffic scale grows with the impressions the page gets — so fixes on high-visibility pages rise to the top.",
          },
          {
            title: "You work the list",
            body: "Mark an action Done when you've handled it, or Dismiss it if it's not worth doing. Use the shortcut link on each card to jump to the tool that fixes it.",
          },
        ]}
        faqs={[
          {
            title: "Will dismissed actions come back?",
            body: "No. Dismissed items stay dismissed across refreshes, even if the signal still exists.",
          },
          {
            title: "What if the problem fixes itself?",
            body: "If an action's underlying signal disappears (e.g. an orphan page gains links), the action is auto-closed as done.",
          },
        ]}
      />

      <Tabs value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
        <TabsList>
          <TabsTrigger value="open" data-testid="tab-open">
            Open{counts ? ` (${counts.open})` : ""}
          </TabsTrigger>
          <TabsTrigger value="done" data-testid="tab-done">
            Done{counts ? ` (${counts.done})` : ""}
          </TabsTrigger>
          <TabsTrigger value="dismissed" data-testid="tab-dismissed">
            Dismissed{counts ? ` (${counts.dismissed})` : ""}
          </TabsTrigger>
          <TabsTrigger value="all" data-testid="tab-all">
            All
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {status === "open"
              ? "Nothing to do — the queue is clear. It refreshes after each crawl and GSC sync."
              : `No ${status === "all" ? "" : status + " "}actions yet.`}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <ActionRow
              key={item.id}
              item={item}
              onSetStatus={onSetStatus}
              busy={mutation.isPending}
            />
          ))}
        </div>
      )}

      <div className="border-t pt-6">
        <ImpactWins />
      </div>
    </div>
  );
}
