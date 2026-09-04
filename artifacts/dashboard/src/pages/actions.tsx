import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListActions,
  getListActionsQueryKey,
  useUpdateAction,
  useExportOpportunitiesSheet,
  useGetOpportunitiesSheetInfo,
  getGetOpportunitiesSheetInfoQueryKey,
  useSyncOpportunitiesSheet,
  type ActionItem,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  Sheet,
  RefreshCw,
  CalendarDays,
  UserRound,
  Database,
  Pencil,
  Save,
  AlertTriangle,
  TrendingUp,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { HowThisWorks } from "@/components/how-this-works";
import { ImpactWins } from "@/components/impact-wins";
import { InfoTip } from "@/components/info-tip";

type StatusFilter = "open" | "done" | "dismissed" | "all";
type CategoryFilter = "all" | "content" | "linking" | "technical" | "visibility" | "authority";

/** "Aug 6 – Aug 12, 2026" for the 7-day stored GSC window, or a fallback. */
function gscWindowLabel(start: string | null | undefined, end: string | null | undefined): string {
  if (!start || !end) return "latest Google window";
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return "latest Google window";
  return `${s.toLocaleDateString(undefined, { ...opts, timeZone: "UTC" })} – ${e.toLocaleDateString(undefined, { ...opts, year: "numeric", timeZone: "UTC" })}`;
}

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
  improve_ranking: {
    label: "Push to page one",
    icon: TrendingUp,
    badgeClass: "bg-indigo-100 text-indigo-800 border-indigo-200",
    route: "/link-map",
    routeLabel: "Link Map",
  },
  fix_cannibalization: {
    label: "Fix cannibalization",
    icon: Split,
    badgeClass: "bg-orange-100 text-orange-800 border-orange-200",
    route: "/link-lookups",
    routeLabel: "Suggest Links",
  },
  create_topical_content: {
    label: "Create topical content",
    icon: Settings2,
    badgeClass: "bg-emerald-100 text-emerald-800 border-emerald-200",
    route: "/topical-map",
    routeLabel: "Topical Map",
  },
  pursue_authority_prospect: {
    label: "Earn authority",
    icon: ArrowUpRight,
    badgeClass: "bg-indigo-100 text-indigo-800 border-indigo-200",
    route: "/backlinks",
    routeLabel: "Backlinks",
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
  onUpdate,
  busy,
}: {
  item: ActionItem;
  onUpdate: (
    item: ActionItem,
    update: {
      status?: "open" | "done" | "dismissed";
      owner?: string | null;
      dueDate?: string | null;
      market?: string;
    },
    onSuccess?: () => void,
    onConflict?: () => void,
  ) => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [owner, setOwner] = useState(item.owner ?? "");
  const [dueDate, setDueDate] = useState(item.dueDate ?? "");
  const [market, setMarket] = useState(item.market);
  const [status, setStatus] = useState<"open" | "done" | "dismissed">(item.status);
  useEffect(() => {
    setOwner(item.owner ?? "");
    setDueDate(item.dueDate ?? "");
    setMarket(item.market);
    setStatus(item.status);
  }, [item.version, item.owner, item.dueDate, item.market, item.status]);
  const cfg = TYPE_CONFIG[item.actionType] ?? {
    label: item.actionType,
    icon: ListTodo,
    badgeClass: "bg-muted text-muted-foreground",
    route: "/",
    routeLabel: "Dashboard",
  };
  const Icon = cfg.icon;
  const cancelEditing = () => {
    setOwner(item.owner ?? "");
    setDueDate(item.dueDate ?? "");
    setMarket(item.market);
    setStatus(item.status);
    setEditing(false);
  };
  const saveEditing = () => {
    const trimmedMarket = market.trim();
    if (!trimmedMarket) return;
    onUpdate(
      item,
      {
        owner: owner.trim() || null,
        dueDate: dueDate || null,
        market: trimmedMarket,
        status,
      },
      () => setEditing(false),
      () => setEditing(false),
    );
  };

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
            <Badge variant="secondary" className="capitalize">{item.category}</Badge>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
              score {Math.round(item.score)}
              <InfoTip>How urgent this task is. Higher scores mean a bigger likely payoff, so work down the list from the top.</InfoTip>
            </span>
            {item.status !== "open" && (
              <Badge
                variant="secondary"
                className="text-xs"
                title={
                  item.resolution === "auto"
                    ? "The system closed this automatically because the underlying signal is no longer active — the issue was fixed or the data moved on."
                    : "You closed this yourself."
                }
              >
                {item.status === "done"
                  ? item.resolution === "auto"
                    ? "resolved on its own"
                    : "done"
                  : "dismissed"}
              </Badge>
            )}
            {item.status === "open" && item.pinnedOpen && (
              <Badge
                variant="secondary"
                className="text-xs"
                title="You reopened this item, so it stays on your list until you mark it Done or Dismiss it — the system won't close it automatically."
              >
                kept open
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
          {editing ? (
            <div className="mt-3 grid gap-3 rounded-md border bg-muted/20 p-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="space-y-1 text-xs font-medium">
                Owner
                <Input
                  value={owner}
                  maxLength={200}
                  placeholder="Unassigned"
                  onChange={(event) => setOwner(event.target.value)}
                  data-testid={`input-owner-${item.id}`}
                />
              </label>
              <label className="space-y-1 text-xs font-medium">
                Due date
                <Input
                  type="date"
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                  data-testid={`input-due-date-${item.id}`}
                />
              </label>
              <label className="space-y-1 text-xs font-medium">
                Market
                <Input
                  value={market}
                  maxLength={100}
                  required
                  onChange={(event) => setMarket(event.target.value)}
                  data-testid={`input-market-${item.id}`}
                />
              </label>
              <label className="space-y-1 text-xs font-medium">
                Status
                <select
                  value={status}
                  onChange={(event) => setStatus(event.target.value as typeof status)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  data-testid={`select-status-${item.id}`}
                >
                  <option value="open">Open</option>
                  <option value="done">Done</option>
                  <option value="dismissed">Dismissed</option>
                </select>
              </label>
              {!market.trim() && (
                <p className="text-xs text-destructive sm:col-span-2 lg:col-span-4">
                  Market is required.
                </p>
              )}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              {fmtNum(item.impressionsAtStake)} impressions at stake
              <InfoTip>Impressions are the times your page showed up in Google's results. "At stake" is roughly how many you could gain or lose depending on whether you do this fix.</InfoTip>
            </span>
            <span className="inline-flex items-center gap-1" title="Assigned owner">
              <UserRound className="h-3 w-3" />
              {item.owner || "unassigned"}
            </span>
            <span className="inline-flex items-center gap-1" title="Due date">
              <CalendarDays className="h-3 w-3" />
              {item.dueDate || "no due date"}
            </span>
            <span>{item.market} market</span>
            <Badge
              variant="outline"
              className={item.freshness === "fresh" ? "text-emerald-700" : "text-amber-700"}
            >
              {item.freshness}
            </Badge>
            <span className="inline-flex items-center gap-1">
              {fmtNum(item.clicksAtStake)} clicks at stake
              <InfoTip>Clicks are the times people actually clicked through to your page. "At stake" is roughly how many extra visits this fix could win you.</InfoTip>
            </span>
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
          <details className="mt-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer inline-flex items-center gap-1 font-medium">
              <Database className="h-3 w-3" />
              Source evidence & score
            </summary>
            <div className="mt-2 rounded-md border bg-muted/30 p-2 space-y-1">
              {item.sourceRecords.map((record, index) => (
                <p key={`${record.kind}-${index}`}>
                  <span className="font-medium capitalize">{record.label}</span>
                  {record.observedAt ? ` · observed ${new Date(record.observedAt).toLocaleDateString()}` : ""}
                </p>
              ))}
              <p>
                Components:{" "}
                {Object.entries(item.scoreComponents)
                  .map(([key, value]) => `${key.replace(/([A-Z])/g, " $1")}: ${String(value)}`)
                  .join(" · ")}
              </p>
            </div>
          </details>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {editing ? (
            <>
              <Button
                size="sm"
                disabled={busy || !market.trim()}
                onClick={saveEditing}
                data-testid={`button-save-${item.id}`}
              >
                <Save className="mr-1 h-3.5 w-3.5" />
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={cancelEditing}
                data-testid={`button-cancel-edit-${item.id}`}
              >
                Cancel
              </Button>
            </>
          ) : item.status === "open" ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onUpdate(item, { status: "done" })}
                data-testid={`button-done-${item.id}`}
              >
                <Check className="mr-1 h-3.5 w-3.5" />
                Done
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onUpdate(item, { status: "dismissed" })}
                data-testid={`button-dismiss-${item.id}`}
              >
                <X className="mr-1 h-3.5 w-3.5" />
                Dismiss
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setEditing(true)}
                data-testid={`button-edit-${item.id}`}
              >
                <Pencil className="mr-1 h-3.5 w-3.5" />
                Edit
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onUpdate(item, { status: "open" })}
                data-testid={`button-reopen-${item.id}`}
              >
                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                Reopen
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setEditing(true)}
                data-testid={`button-edit-${item.id}`}
              >
                <Pencil className="mr-1 h-3.5 w-3.5" />
                Edit
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function Actions() {
  const [status, setStatus] = useState<StatusFilter>("open");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [sheetConflicts, setSheetConflicts] = useState<Array<{
    rowNumber: number;
    actionId: string;
    reason: "stale" | "invalid";
  }>>([]);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useListActions(
    { status, category },
    { query: { queryKey: getListActionsQueryKey({ status, category }) } },
  );
  const sheetInfo = useGetOpportunitiesSheetInfo();
  useEffect(() => {
    if (sheetInfo.data) setSheetConflicts(sheetInfo.data.conflicts);
  }, [sheetInfo.data]);
  const exportSheet = useExportOpportunitiesSheet({
    mutation: {
      onSuccess: (result) => {
        setSheetConflicts([]);
        void queryClient.invalidateQueries({ queryKey: getGetOpportunitiesSheetInfoQueryKey() });
        toast({ title: "Opportunities exported", description: `${result.rowCount} rows refreshed in Google Sheets.` });
      },
      onError: () => toast({ title: "Export failed", description: "Google Sheets could not be refreshed.", variant: "destructive" }),
    },
  });
  const syncSheet = useSyncOpportunitiesSheet({
    mutation: {
      onSuccess: (result) => {
        setSheetConflicts(result.conflicts);
        void queryClient.invalidateQueries({ queryKey: ["/actions"] });
        void queryClient.invalidateQueries({ queryKey: getGetOpportunitiesSheetInfoQueryKey() });
        toast({ title: "Sheet review imported", description: `${result.updated} updated, ${result.stale} stale, ${result.invalid} invalid.` });
      },
      onError: () => toast({ title: "Import failed", description: "Check the sheet headers and row versions.", variant: "destructive" }),
    },
  });

  const mutation = useUpdateAction({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ["/actions"] });
        void queryClient.invalidateQueries({
          predicate: (q) =>
            typeof q.queryKey[0] === "string" && q.queryKey[0].includes("/actions"),
        });
      },
      onError: (error) => {
        const conflict = error.status === 409;
        if (conflict) {
          void queryClient.invalidateQueries({
            predicate: (q) =>
              typeof q.queryKey[0] === "string" && q.queryKey[0].includes("/actions"),
          });
        }
        toast({
          title: conflict ? "Opportunity changed" : "Update failed",
          description: conflict
            ? "Someone else updated this opportunity. The latest version is loading; review it before saving again."
            : "Could not update the opportunity. Try again.",
          variant: "destructive",
        });
      },
    },
  });

  const onUpdate = (
    item: ActionItem,
    update: {
      status?: "open" | "done" | "dismissed";
      owner?: string | null;
      dueDate?: string | null;
      market?: string;
    },
    onSuccess?: () => void,
    onConflict?: () => void,
  ) => {
    mutation.mutate(
      { id: item.id, data: { expectedVersion: item.version, ...update } },
      {
        onSuccess,
        onError: (error) => {
          if (error.status === 409) onConflict?.();
        },
      },
    );
  };

  const counts = data?.counts;
  const items = data?.items ?? [];
  const refreshExport = () => {
    if (
      sheetConflicts.length > 0 &&
      !window.confirm(
        `Refreshing the export will replace ${sheetConflicts.length} unresolved spreadsheet row${sheetConflicts.length === 1 ? "" : "s"}. Continue?`,
      )
    ) {
      return;
    }
    exportSheet.mutate({
      data: { confirmConflictOverwrite: sheetConflicts.length > 0 },
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ListTodo className="h-6 w-6" />
          Opportunities
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          One ranked workspace across content, linking, technical, visibility,
          and authority. Specialist tools provide evidence; this is the task record.
        </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {sheetInfo.data?.url && (
            <Button variant="outline" asChild>
              <a href={sheetInfo.data.url} target="_blank" rel="noreferrer">
                <Sheet className="mr-2 h-4 w-4" /> Open sheet
              </a>
            </Button>
          )}
          <Button
            variant="outline"
            disabled={exportSheet.isPending}
            onClick={refreshExport}
          >
            <Sheet className="mr-2 h-4 w-4" />
            {sheetInfo.data?.url ? "Refresh export" : "Export to Sheets"}
          </Button>
          {sheetInfo.data?.url && (
            <Button
              variant="outline"
              disabled={syncSheet.isPending}
              onClick={() => syncSheet.mutate()}
            >
              <RefreshCw className="mr-2 h-4 w-4" /> Import reviews
            </Button>
          )}
        </div>
      </div>

      {sheetConflicts.length > 0 && (
        <Card className="border-amber-300 bg-amber-50/60">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold text-amber-950">Spreadsheet rows need refreshing</h2>
                <p className="mt-1 text-sm text-amber-900">
                  These reviews were not imported. Resolve them in the sheet, or refresh the export to replace them with the latest app values.
                </p>
                <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {sheetConflicts.map((conflict) => (
                    <li
                      key={`${conflict.rowNumber}-${conflict.actionId}-${conflict.reason}`}
                      className="rounded-md border border-amber-200 bg-background px-3 py-2 text-sm"
                    >
                      <span className="font-medium">Row {conflict.rowNumber}</span>
                      {" · "}Action ID {conflict.actionId || "(missing)"}
                      <Badge variant="outline" className="ml-2 capitalize text-amber-800">
                        {conflict.reason}
                      </Badge>
                    </li>
                  ))}
                </ul>
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  disabled={exportSheet.isPending}
                  onClick={refreshExport}
                >
                  <Sheet className="mr-2 h-4 w-4" />
                  Refresh export and replace these rows
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <HowThisWorks
        summary="One governed opportunity list built from specialist evidence without creating duplicate task stores."
        steps={[
          {
            title: "Signals are collected",
            body: "After source jobs run, Opportunities reconciles orphans, dead ends, ranking and CTR issues, semantic suggestions, optimizer work, topical gaps, and authority prospects by stable identity.",
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
            body: "If an action's underlying signal disappears (e.g. an orphan page gains links, or a ranking drop is no longer in the latest week's data), the action is closed automatically and labeled \"resolved on its own\".",
          },
          {
            title: "What does Reopen do?",
            body: "Reopen puts an item back on your Open list and pins it there — it stays until you mark it Done or Dismiss it yourself, even if the system no longer detects the issue.",
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
      <div className="flex flex-wrap gap-2" aria-label="Opportunity category">
        {(["all", "content", "linking", "technical", "visibility", "authority"] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={category === value ? "default" : "outline"}
            className="capitalize"
            onClick={() => setCategory(value)}
          >
            {value}
          </Button>
        ))}
      </div>

      {data?.gscWindowStart != null && (
        <p className="text-xs text-muted-foreground">
          Google impression and click figures reflect the{" "}
          <span className="font-medium">
            {gscWindowLabel(data.gscWindowStart, data.gscWindowEnd)}
          </span>{" "}
          GSC sync window.
        </p>
      )}

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {status === "open"
              ? "No matching open opportunities. The workspace refreshes after source jobs run."
              : `No ${status === "all" ? "" : status + " "}actions yet.`}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <ActionRow
              key={item.id}
              item={item}
              onUpdate={onUpdate}
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
