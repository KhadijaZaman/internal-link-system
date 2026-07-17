import { useMemo, useState } from "react";
import {
  useListImpactWins,
  getListImpactWinsQueryKey,
  useGetImpactDetail,
  getGetImpactDetailQueryKey,
  type ImpactWinItem,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { TrendChart } from "@/components/gsc/trend-chart";
import { TrendingUp, TrendingDown, Timer, Minus, ChevronRight } from "lucide-react";

const STATE_CONFIG = {
  improved: {
    label: "Improved",
    icon: TrendingUp,
    badgeClass: "bg-emerald-100 text-emerald-800 border-emerald-200",
  },
  measuring: {
    label: "Measuring",
    icon: Timer,
    badgeClass: "bg-sky-100 text-sky-800 border-sky-200",
  },
  flat: {
    label: "Flat",
    icon: Minus,
    badgeClass: "bg-muted text-muted-foreground border-border",
  },
  declined: {
    label: "Declined",
    icon: TrendingDown,
    badgeClass: "bg-red-100 text-red-800 border-red-200",
  },
} as const;

function pathLabel(path: string): string {
  const i = path.indexOf("/");
  return i >= 0 ? path.slice(i) || "/" : path;
}

function fmtDelta(n: number | null | undefined, suffix = ""): string {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n}${suffix}`;
}

function WinDetailDrawer({
  item,
  onClose,
}: {
  item: ImpactWinItem | null;
  onClose: () => void;
}) {
  const [metric, setMetric] = useState<"clicks" | "impressions" | "position">("clicks");
  const url = item?.url ?? "";
  const { data, isLoading } = useGetImpactDetail(
    { url },
    {
      query: {
        queryKey: getGetImpactDetailQueryKey({ url }),
        enabled: !!item,
      },
    },
  );

  const chartData = useMemo(
    () =>
      (data?.weeks ?? []).map((w) => ({
        date: w.weekStart.slice(5),
        clicks: w.clicks,
        impressions: w.impressions,
        ctr: w.impressions > 0 ? (w.clicks / w.impressions) * 100 : 0,
        position: w.position ?? 0,
      })),
    [data],
  );

  return (
    <Drawer open={!!item} onOpenChange={(open) => !open && onClose()}>
      <DrawerContent>
        {item && (
          <div className="mx-auto w-full max-w-3xl pb-6">
            <DrawerHeader>
              <DrawerTitle className="truncate">{pathLabel(item.path)}</DrawerTitle>
              <DrawerDescription>
                Work completed {new Date(item.anchorCompletedAt).toLocaleDateString()} —{" "}
                {item.events.length} completed action{item.events.length === 1 ? "" : "s"} on
                this page. Weekly Search Console performance:
              </DrawerDescription>
            </DrawerHeader>
            <div className="px-4">
              <div className="mb-3 flex gap-1.5">
                {(["clicks", "impressions", "position"] as const).map((m) => (
                  <Button
                    key={m}
                    size="sm"
                    variant={metric === m ? "default" : "outline"}
                    onClick={() => setMetric(m)}
                    data-testid={`button-metric-${m}`}
                  >
                    {m[0]!.toUpperCase() + m.slice(1)}
                  </Button>
                ))}
              </div>
              {isLoading ? (
                <div className="flex justify-center py-12">
                  <Spinner />
                </div>
              ) : (
                <TrendChart data={chartData} metric={metric} />
              )}
              <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
                <div className="rounded-md border p-2.5">
                  <div className="text-xs text-muted-foreground">Clicks / wk</div>
                  <div className="font-medium">
                    {item.baseline?.clicks ?? "—"} → {item.after?.clicks ?? "—"}{" "}
                    <span className="text-xs text-muted-foreground">
                      ({fmtDelta(item.deltaClicks)})
                    </span>
                  </div>
                </div>
                <div className="rounded-md border p-2.5">
                  <div className="text-xs text-muted-foreground">Impressions / wk</div>
                  <div className="font-medium">
                    {item.baseline?.impressions ?? "—"} → {item.after?.impressions ?? "—"}{" "}
                    <span className="text-xs text-muted-foreground">
                      ({fmtDelta(item.deltaImpressions)})
                    </span>
                  </div>
                </div>
                <div className="rounded-md border p-2.5">
                  <div className="text-xs text-muted-foreground">Avg position</div>
                  <div className="font-medium">
                    {item.baseline?.position ?? "—"} → {item.after?.position ?? "—"}{" "}
                    <span className="text-xs text-muted-foreground">
                      ({fmtDelta(item.deltaPosition)})
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}

export function ImpactWins() {
  const [selected, setSelected] = useState<ImpactWinItem | null>(null);
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading } = useListImpactWins({
    query: { queryKey: getListImpactWinsQueryKey() },
  });

  const items = data?.items ?? [];
  const summary = data?.summary;
  const visible = showAll ? items : items.slice(0, 6);

  if (!isLoading && items.length === 0) {
    return (
      <div>
        <h2 className="text-lg font-semibold">Impact of completed work</h2>
        <Card className="mt-3">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No completed work to measure yet. Mark actions done (or insert suggestions,
            or complete optimizer items) and results will show up here as GSC data
            accumulates.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Impact of completed work</h2>
        {summary && (
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(STATE_CONFIG) as Array<keyof typeof STATE_CONFIG>).map((k) => (
              <Badge key={k} variant="outline" className={STATE_CONFIG[k].badgeClass}>
                {summary[k]} {STATE_CONFIG[k].label.toLowerCase()}
              </Badge>
            ))}
          </div>
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Weekly Search Console performance before vs. after each page was worked on
        (4-week baseline vs. rolling 4-week effect).
      </p>

      {isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {visible.map((item) => {
            const cfg = STATE_CONFIG[item.state];
            const Icon = cfg.icon;
            return (
              <button
                key={item.path}
                className="w-full text-left"
                onClick={() => setSelected(item)}
                data-testid={`row-impact-${item.path.replace(/[^a-z0-9]+/gi, "-")}`}
              >
                <Card className="transition-colors hover:bg-muted/40">
                  <CardContent className="flex items-center gap-3 p-3">
                    <Badge variant="outline" className={cfg.badgeClass}>
                      <Icon className="mr-1 h-3 w-3" />
                      {cfg.label}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {pathLabel(item.path)}
                    </span>
                    <span className="hidden text-xs text-muted-foreground sm:inline">
                      {item.state === "measuring"
                        ? `${item.weeksAfter} wk of data — needs 2`
                        : `clicks ${fmtDelta(item.deltaClicks)} · impr ${fmtDelta(item.deltaImpressions)} · pos ${fmtDelta(item.deltaPosition)}`}
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </CardContent>
                </Card>
              </button>
            );
          })}
          {items.length > 6 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowAll((v) => !v)}
              data-testid="button-toggle-all-wins"
            >
              {showAll ? "Show fewer" : `Show all ${items.length}`}
            </Button>
          )}
        </div>
      )}

      <WinDetailDrawer item={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
