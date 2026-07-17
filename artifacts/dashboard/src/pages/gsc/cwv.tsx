import { useGetGscCwv } from "@workspace/api-client-react";
import { GscLayout } from "@/components/gsc/gsc-layout";
import { useGscRange } from "@/components/gsc/range-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";
import { CopyButton } from "@/components/copy-button";
import { rowsToTsv } from "@/lib/clipboard";
import { AlertTriangle, CheckCircle2, ExternalLink, Lightbulb, TrendingDown } from "lucide-react";

const BAND_COLORS: Record<string, string> = {
  good: "bg-green-500/15 text-green-700 dark:text-green-400",
  ni: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  poor: "bg-red-500/15 text-red-700 dark:text-red-400",
  unknown: "bg-muted text-muted-foreground",
};

const METRIC_LABELS: Record<string, { short: string; full: string; target: string }> = {
  largest_contentful_paint: { short: "LCP", full: "Largest Contentful Paint", target: "≤ 2.5 s" },
  interaction_to_next_paint: { short: "INP", full: "Interaction to Next Paint", target: "≤ 200 ms" },
  cumulative_layout_shift: { short: "CLS", full: "Cumulative Layout Shift", target: "≤ 0.1" },
  first_contentful_paint: { short: "FCP", full: "First Contentful Paint", target: "≤ 1.8 s" },
  experimental_time_to_first_byte: { short: "TTFB", full: "Time to First Byte", target: "≤ 800 ms" },
  round_trip_time: { short: "RTT", full: "Round Trip Time", target: "≤ 75 ms" },
};

interface Recommendation {
  title: string;
  why: string;
  actions: string[];
  docs?: { label: string; href: string }[];
}

const RECS: Record<string, { ni: Recommendation; poor: Recommendation }> = {
  largest_contentful_paint: {
    ni: {
      title: "Speed up the hero image / above-the-fold render",
      why: "LCP measures when the biggest above-the-fold element finishes painting. You are close to the 2.5 s good threshold — small wins push you over the line.",
      actions: [
        "Add fetchpriority=\"high\" to the hero <img> and preload its source.",
        "Serve hero images as AVIF/WebP with explicit width/height; cap at the rendered size, not the source resolution.",
        "Remove render-blocking <script> tags above the fold; defer or async non-critical JS.",
        "Inline the critical CSS path for above-the-fold styles.",
      ],
      docs: [{ label: "web.dev: Optimize LCP", href: "https://web.dev/articles/optimize-lcp" }],
    },
    poor: {
      title: "LCP is over 4 s — large render blocker on the critical path",
      why: "Real users on the 75th percentile wait >4 s for the main content. Google treats this as failing CWV and will weight it negatively for ranking.",
      actions: [
        "Run a Lighthouse run on the worst page and look at the 'Largest Contentful Paint element' section.",
        "Move the LCP image into the HTML response (don't lazy-load or inject via JS).",
        "Eliminate client-side hydration of above-the-fold content where possible (SSR or static HTML).",
        "Reduce TTFB first — every ms saved there is a free LCP win.",
      ],
      docs: [{ label: "web.dev: Optimize LCP", href: "https://web.dev/articles/optimize-lcp" }],
    },
  },
  interaction_to_next_paint: {
    ni: {
      title: "Trim main-thread work on tap / scroll handlers",
      why: "INP is the new responsiveness metric (replaced FID in March 2024). You are between 200–500 ms — interactions feel slightly laggy on mid-tier phones.",
      actions: [
        "Audit third-party tags (GTM, analytics, chat widgets) — they're the #1 INP cause.",
        "Break long tasks (>50 ms) with scheduler.yield() or setTimeout chunking.",
        "Move heavy work (parsing, decoding) off the main thread into Web Workers.",
        "Use CSS transitions instead of JS-driven animations where possible.",
      ],
      docs: [{ label: "web.dev: Optimize INP", href: "https://web.dev/articles/optimize-inp" }],
    },
    poor: {
      title: "INP > 500 ms — page feels unresponsive to taps",
      why: "Users perceive interactions as broken at this latency. CWV failure.",
      actions: [
        "Disable or self-host every third-party script you don't strictly need.",
        "Profile with Chrome DevTools 'Performance' panel during a real interaction; find tasks > 200 ms.",
        "Code-split route bundles — ship less JS per page.",
        "Replace heavy UI frameworks/components above the fold with HTML+CSS.",
      ],
    },
  },
  cumulative_layout_shift: {
    ni: {
      title: "Reserve space for images, ads, and embeds",
      why: "Content shifts noticeably while loading — annoying on mobile and a ranking signal.",
      actions: [
        "Set explicit width and height (or aspect-ratio) on every <img>, <video>, and <iframe>.",
        "Reserve a min-height for ad slots and embeds before they load.",
        "Preload web fonts and use font-display: optional / swap with size-adjust to avoid FOUT shifts.",
        "Avoid injecting banners / cookie bars above existing content — overlay them instead.",
      ],
      docs: [{ label: "web.dev: Optimize CLS", href: "https://web.dev/articles/optimize-cls" }],
    },
    poor: {
      title: "CLS > 0.25 — layout is jumping badly during load",
      why: "Users mis-tap because the layout shifts after they aim. Hard CWV failure.",
      actions: [
        "Open the worst page in Chrome DevTools → Performance Insights → 'Layout shifts'. Each shift is annotated with the offending element.",
        "Replace any element injected via JS that pushes existing content down.",
        "Audit your CSS for late-loading font swaps that change line-height.",
      ],
    },
  },
  first_contentful_paint: {
    ni: {
      title: "Get something on screen sooner",
      why: "FCP measures when the first text/image appears. Slow FCP usually means slow TTFB or render-blocking CSS/JS in the <head>.",
      actions: [
        "Inline critical above-the-fold CSS and load the rest asynchronously.",
        "Preconnect to required origins (fonts, CDN) with <link rel=\"preconnect\">.",
        "Defer all non-essential <script> tags in the <head>.",
      ],
      docs: [{ label: "web.dev: FCP", href: "https://web.dev/articles/fcp" }],
    },
    poor: {
      title: "FCP > 3 s — blank screen for too long",
      why: "Users see a white page on first load — bounce rate spikes here.",
      actions: [
        "Fix TTFB first (see TTFB recommendations).",
        "Strip render-blocking resources from the document <head>.",
        "Serve a meaningful HTML shell from the server instead of an empty <div id=root>.",
      ],
    },
  },
  experimental_time_to_first_byte: {
    ni: {
      title: "Cache HTML at the edge",
      why: "Server is taking 800–1800 ms to respond. Every other paint metric is paying for that.",
      actions: [
        "Put a CDN (Cloudflare / Fastly / Vercel Edge) in front of the origin and cache HTML for at least a few minutes.",
        "Enable HTTP/2 or HTTP/3 if not already.",
        "Move from a single origin region to multi-region or anycast.",
        "Profile slow database queries that block page rendering (especially WordPress: turn on Query Monitor).",
      ],
      docs: [{ label: "web.dev: Optimize TTFB", href: "https://web.dev/articles/optimize-ttfb" }],
    },
    poor: {
      title: "TTFB > 1.8 s — origin is the bottleneck",
      why: "The browser is waiting almost two seconds before it even receives the HTML. Nothing else can render until this is fixed.",
      actions: [
        "Cache every cacheable page at the CDN edge; bypass cache only for logged-in traffic.",
        "Move the origin closer to your users (multi-region or anycast hosting).",
        "Audit any backend plugins / middleware adding latency to every request.",
        "Pre-render or static-export pages that don't need per-request data.",
      ],
    },
  },
  round_trip_time: {
    ni: {
      title: "Reduce network distance",
      why: "RTT reflects how far packets travel between user and origin. High RTT inflates every other metric.",
      actions: [
        "Use a CDN with edge presence near your traffic geography.",
        "Enable HTTP/3 (QUIC) for fewer round trips on slow networks.",
      ],
    },
    poor: {
      title: "RTT is high — users are far from your origin",
      why: "Likely single-region hosting with global traffic.",
      actions: [
        "Move to a multi-region or anycast hosting provider.",
        "Enable HTTP/3 and TLS 1.3 to shave handshake round trips.",
      ],
    },
  },
};

function formatP75(metric: string, p75: number): string {
  if (metric === "cumulative_layout_shift") return p75.toFixed(3);
  return `${Math.round(p75)} ms`;
}

interface MetricLike {
  metric: string;
  p75: number;
  band: string;
  distribution: { label: string; density: number }[];
}

function RecommendationBlock({ metric, band }: { metric: string; band: string }) {
  if (band !== "ni" && band !== "poor") return null;
  const rec = RECS[metric]?.[band as "ni" | "poor"];
  if (!rec) return null;
  return (
    <div className="mt-3 border-t pt-3 space-y-2">
      <div className="flex items-start gap-2">
        <Lightbulb className={cn("h-4 w-4 mt-0.5 shrink-0", band === "poor" ? "text-red-500" : "text-amber-500")} />
        <div className="flex-1">
          <div className="text-sm font-medium leading-snug">{rec.title}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{rec.why}</div>
        </div>
      </div>
      <ul className="text-xs space-y-1 pl-6 list-disc text-foreground/90">
        {rec.actions.map((a, i) => (
          <li key={i}>{a}</li>
        ))}
      </ul>
      {rec.docs && rec.docs.length > 0 && (
        <div className="pl-6 pt-1 flex flex-wrap gap-2">
          {rec.docs.map((d) => (
            <a
              key={d.href}
              href={d.href}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] inline-flex items-center gap-1 text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" /> {d.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function PriorityActionsCard({
  metrics,
  scopeUrl,
}: {
  metrics: { formFactor: string; m: MetricLike }[];
  scopeUrl: string;
}) {
  const failing = metrics.filter((x) => x.m.band === "poor" || x.m.band === "ni");
  const passing = metrics.filter((x) => x.m.band === "good");

  if (failing.length === 0) {
    return (
      <Card className="border-green-500/40 bg-green-50/40 dark:bg-green-950/10">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            All Core Web Vitals are passing
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Every metric across every form factor is in the green band. Keep an
          eye on the trend over time — regressions show up here within a few
          weeks of a deploy.
        </CardContent>
      </Card>
    );
  }

  // Rank: poor first, then ni; weight mobile higher (Google uses mobile for ranking)
  const score = (x: { formFactor: string; m: MetricLike }) => {
    const b = x.m.band === "poor" ? 100 : x.m.band === "ni" ? 50 : 0;
    const f = x.formFactor === "PHONE" ? 10 : 0;
    return b + f;
  };
  const ranked = failing.slice().sort((a, b) => score(b) - score(a)).slice(0, 5);

  const psiUrl = `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(scopeUrl)}&form_factor=mobile`;
  const searchConsoleUrl = `https://search.google.com/search-console/core-web-vitals?resource_id=${encodeURIComponent(
    scopeUrl,
  )}`;

  return (
    <Card className="border-amber-500/40 bg-amber-50/40 dark:bg-amber-950/10">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            Priority actions
            <InfoTip>
              Ranked by severity (poor first, then needs-improvement) and weighted
              toward mobile, because Google ranks on the mobile experience.
            </InfoTip>
          </CardTitle>
          <CopyButton
            getText={() =>
              rowsToTsv(
                ["Metric", "Form Factor", "p75"],
                ranked.map((x) => [
                  METRIC_LABELS[x.m.metric]?.short ?? x.m.metric,
                  x.formFactor,
                  formatP75(x.m.metric, x.m.p75),
                ]),
              )
            }
            disabled={ranked.length === 0}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm text-muted-foreground">
          {failing.length} metric{failing.length === 1 ? "" : "s"} need attention.
          {passing.length > 0 && ` ${passing.length} already passing.`} Tackle
          them in the order below — each rec links to the specific fixes for
          that metric.
        </div>
        <ol className="space-y-2">
          {ranked.map((x, i) => {
            const label = METRIC_LABELS[x.m.metric];
            const rec = RECS[x.m.metric]?.[x.m.band as "ni" | "poor"];
            return (
              <li key={`${x.formFactor}-${x.m.metric}`} className="flex items-start gap-3 border rounded-md p-3 bg-background">
                <div className="text-lg font-bold text-muted-foreground tabular-nums w-6">
                  {i + 1}.
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className={cn("text-[10px]", BAND_COLORS[x.m.band])}>
                      {x.m.band}
                    </Badge>
                    <span className="text-xs font-mono text-muted-foreground">
                      {x.formFactor === "PHONE" ? "📱 Mobile" : x.formFactor === "DESKTOP" ? "🖥️ Desktop" : "All"}
                    </span>
                    <span className="text-sm font-semibold">
                      {label?.short ?? x.m.metric} — {formatP75(x.m.metric, x.m.p75)}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      target {label?.target ?? "—"}
                    </span>
                  </div>
                  {rec && (
                    <div className="text-sm mt-1 font-medium">{rec.title}</div>
                  )}
                  {rec && (
                    <div className="text-xs text-muted-foreground mt-0.5">{rec.why}</div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap gap-2 pt-1">
          <InfoTip>Run a full Lighthouse audit on this scope — gives you per-page diagnostics, not just the aggregate field data shown here.</InfoTip>
          <Button asChild size="sm" variant="default">
            <a href={psiUrl} target="_blank" rel="noreferrer">
              <TrendingDown className="h-3.5 w-3.5 mr-1.5" />
              Run PageSpeed Insights
              <ExternalLink className="h-3 w-3 ml-1.5" />
            </a>
          </Button>
          <InfoTip>Open this property's Core Web Vitals report directly in Google Search Console — shows every URL group failing CWV.</InfoTip>
          <Button asChild size="sm" variant="outline">
            <a href={searchConsoleUrl} target="_blank" rel="noreferrer">
              Search Console CWV report
              <ExternalLink className="h-3 w-3 ml-1.5" />
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CwvBody() {
  const { range } = useGscRange();
  const { data, isLoading, error } = useGetGscCwv({ url: range.urlFilter ?? undefined });

  if (isLoading) return <div className="flex justify-center py-12"><Spinner className="h-8 w-8" /></div>;
  if (error || !data) return <div className="py-12 text-center text-sm text-destructive">Failed to load Core Web Vitals. {error instanceof Error ? error.message : ""}</div>;

  const allMetrics: { formFactor: string; m: MetricLike }[] = [];
  (data.formFactors ?? []).forEach((ff) =>
    ff.metrics.forEach((m) =>
      allMetrics.push({ formFactor: ff.formFactor, m: m as MetricLike }),
    ),
  );

  return (
    <div className="space-y-4">
      <HowThisWorks
        summary="Real-user Core Web Vitals from Chrome's CrUX dataset — LCP, INP, CLS, FCP, TTFB, RTT — at origin or single-URL scope, with prioritized fix actions."
        steps={[
          { title: "Pick a scope", body: "Leave the top filter blank for origin-level (whole site) p75. Filter to a single URL for that URL's p75 — CrUX does not support arbitrary URL groups." },
          { title: "Read the bands", body: "Green = good, amber = needs improvement, red = poor. Bands reflect Google's official thresholds (LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1, etc.)." },
          { title: "Act on Priority Actions", body: "The top card surfaces the 3–5 highest-impact fixes ranked by metric × form factor × current band. Each action lists exactly what to change." },
        ]}
        faqs={[
          { title: "Why is data 'unknown' for my URL?", body: "CrUX only reports URLs with sufficient Chrome traffic. Low-traffic pages roll up to origin only." },
          { title: "How fresh is this?", body: "CrUX uses a 28-day trailing window of real-user data and refreshes daily. A fix made today will start showing in roughly 2–4 weeks." },
        ]}
      />
      <div className="text-xs text-muted-foreground">
        Scope: {range.urlFilter ? "URL" : "Origin"} · {data.scope} · fetched{" "}
        {new Date(data.fetchedAt).toLocaleString()}
        <span className="ml-2 italic">
          (CrUX field data — origin- or URL-level p75 over the trailing 28-day window. CrUX does not
          support arbitrary URL groups; filter to a single URL above to switch scopes.)
        </span>
      </div>
      {data.notice && <div className="border rounded-md p-3 text-sm bg-muted/30">{data.notice}</div>}

      {allMetrics.length > 0 && (
        <PriorityActionsCard metrics={allMetrics} scopeUrl={data.scope} />
      )}

      {data.formFactors && data.formFactors.map((ff) => (
        <Card key={ff.formFactor}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              {ff.formFactor.replace("_", " ")}
              <InfoTip>Core Web Vitals broken out for {ff.formFactor.replace("_", " ")} traffic — p75 values and the good/needs-improvement/poor distribution from Chrome real-user data. Recommendations below each metric trigger automatically when the metric is not in the green band.</InfoTip>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {ff.metrics.map((m) => {
              const label = METRIC_LABELS[m.metric];
              return (
                <div key={m.metric} className="border rounded-md p-3 flex flex-col">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs uppercase tracking-wider text-muted-foreground truncate">
                        {label?.full ?? m.metric.replace(/_/g, " ")}
                        {label && <span className="ml-1 opacity-60">({label.short})</span>}
                      </div>
                      {label && (
                        <div className="text-[10px] text-muted-foreground/80 mt-0.5">
                          Target: {label.target}
                        </div>
                      )}
                    </div>
                    <Badge className={cn("text-[10px] shrink-0", BAND_COLORS[m.band])}>{m.band}</Badge>
                  </div>
                  <div className="text-2xl font-bold mt-2">{formatP75(m.metric, m.p75)}</div>
                  <div className="mt-2 flex h-2 rounded overflow-hidden">
                    {m.distribution.map((d, i) => (
                      <div
                        key={i}
                        style={{ width: `${d.density * 100}%` }}
                        className={cn(i === 0 && "bg-green-500", i === 1 && "bg-amber-500", i === 2 && "bg-red-500")}
                        title={`${d.label}: ${(d.density * 100).toFixed(1)}%`}
                      />
                    ))}
                  </div>
                  <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                    <span>{(m.distribution[0]?.density * 100 || 0).toFixed(0)}% good</span>
                    <span>{(m.distribution[1]?.density * 100 || 0).toFixed(0)}% needs work</span>
                    <span>{(m.distribution[2]?.density * 100 || 0).toFixed(0)}% poor</span>
                  </div>
                  <RecommendationBlock metric={m.metric} band={m.band} />
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function GscCwvPage() {
  return <GscLayout showControls={false}><CwvBody /></GscLayout>;
}
