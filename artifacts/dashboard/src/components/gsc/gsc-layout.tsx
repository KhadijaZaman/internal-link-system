import { Link, useLocation } from "wouter";
import { GscControls } from "./controls";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/gsc/overview", label: "Overview" },
  { href: "/gsc/queries", label: "Queries" },
  { href: "/gsc/pages", label: "Pages" },
  { href: "/gsc/geo", label: "Countries & Devices" },
  { href: "/gsc/indexing", label: "Indexing" },
  { href: "/gsc/cwv", label: "Core Web Vitals" },
  { href: "/gsc/links", label: "Links" },
  { href: "/gsc/bulk-queries", label: "Bulk Queries" },
  { href: "/gsc/ask", label: "Ask" },
];

const TABS_NO_RANGE = new Set(["/gsc/cwv", "/gsc/links", "/gsc/indexing", "/gsc/bulk-queries"]);

export function GscLayout({
  children,
  showControls = true,
}: {
  children: ReactNode;
  /** @deprecated kept for backward compatibility — controls now always render so users see a stable filter bar across every tab. */
  showControls?: boolean;
}) {
  void showControls;
  const [location] = useLocation();
  const rangeIgnored = TABS_NO_RANGE.has(location);
  return (
    <>
      <div className="space-y-6 max-w-7xl mx-auto">
        <div>
          <h2 className="text-3xl font-display text-foreground">GSC Pro</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Search Console analytics, indexing health, and AI-assisted analysis.
          </p>
        </div>

        <div className="border-b flex gap-1 overflow-x-auto -mx-1 px-1">
          {TABS.map((t) => {
            const active = location === t.href;
            return (
              <Link key={t.href} href={t.href}>
                <button
                  className={cn(
                    "px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors",
                    active
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.label}
                </button>
              </Link>
            );
          })}
        </div>

        <GscControls />
        {rangeIgnored && (
          <p className="-mt-3 text-xs text-muted-foreground italic">
            Date range does not apply to this tab — data is sourced from live
            feeds (sitemaps, CrUX 28-day window, or backlink index).
          </p>
        )}

        <div>{children}</div>
      </div>
    </>
  );
}
