import { db, auditReportsTable, inventoryTable, linkGraphTable, linkStatsTable, wpPostsTable, linkExcludeListTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { SiteContext } from "../lib/site";
import { logger } from "../lib/logger";
import { withDbRetry } from "../lib/dbRetry";

const OVER_LINKED_TARGET_THRESHOLD = 50;
const OVER_LINKED_ANCHOR_THRESHOLD = 10;
// Per-run cap on broken-link checks. Default is high enough for a typical
// weekly sweep of a mid-size site; tune via env when needed. Set to 0 for
// "no cap" (check every distinct target in the link graph).
const BROKEN_CHECK_LIMIT = Number(process.env["AUDIT_BROKEN_LINK_LIMIT"] ?? "5000");
const BROKEN_CONCURRENCY = Number(process.env["AUDIT_BROKEN_CONCURRENCY"] ?? "8");

interface OrphanItem {
  url: string;
  title: string | null;
  inboundCount: number;
}
interface LinkingPage {
  sourceUrl: string;
  anchorText: string;
  title: string | null;
}
interface OverLinkedItem {
  kind: "target" | "anchor";
  url?: string;
  anchorText?: string;
  /**
   * For "target": number of body (content-placement) inbound links that carry
   * real anchor text — the figure compared against the threshold.
   * For "anchor": total anchor frequency across body links only.
   */
  count: number;
  /** "target" only — the body-text pages that link to this URL (with anchor). */
  linkingPages?: LinkingPage[];
}

/** A link "counts" only when it's in body text AND carries real anchor text. */
function hasRealAnchor(text: string | null | undefined): boolean {
  const v = (text ?? "").trim().toLowerCase();
  return v !== "" && v !== "wp:auto";
}
interface BrokenItem {
  url: string;
  status: number | null;
  error?: string;
  inboundCount: number;
  /** For 3xx: the absolute URL this link redirects to (the link should be repointed here). */
  redirectTo?: string;
  /**
   * The internal pages that link to this broken/redirecting URL (with the
   * anchor text used), so the operator can open each one and fix the href.
   * This is the actionable payload — knowing *which* pages to edit, not just
   * how many.
   */
  linkingPages?: LinkingPage[];
}

async function record(siteId: number, type: string, payload: unknown, itemCount: number): Promise<void> {
  // Audit steps run at the tail of the long full-pipeline job, where stale
  // serverless-PG connections are most likely — retry transient drops. This is
  // a plain INSERT, but a rare duplicate audit report on a dropped ack is
  // harmless (the dashboard reads only the latest report per type).
  await withDbRetry(
    () =>
      db.insert(auditReportsTable).values({
        siteId,
        type,
        payload: payload as unknown,
        itemCount,
        runAt: new Date(),
      }),
    { label: `audit_record:${type}` },
  );
}

function compilePattern(pattern: string): RegExp {
  const escaped = pattern.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(escaped);
}

function isExcluded(url: string, regexes: RegExp[]): boolean {
  let path: string;
  try { path = new URL(url).pathname; } catch { path = url; }
  return regexes.some((re) => re.test(path) || re.test(url));
}

// SSRF allow-list — same policy as the sitemap crawler (jobs/crawlLinkMap.ts):
//   1. SITE_DOMAIN is the primary source of truth (single hostname, www-stripped).
//   2. WP_SITE_ORIGINS / WP_API_BASE may add extra hostnames (multi-origin sites).
//   3. If nothing is configured, we refuse to fetch anything — no permissive
//      fallback to the open web.
function getAllowedHostnames(): Set<string> {
  const set = new Set<string>();
  const primary = process.env["SITE_DOMAIN"];
  if (primary) {
    const hostOnly = primary.replace(/^https?:\/\//, "").replace(/\/.*$/, "").split(":")[0] ?? primary;
    set.add(hostOnly.replace(/^www\./, "").toLowerCase());
  }
  const extra = process.env["WP_SITE_ORIGINS"] ?? process.env["WP_API_BASE"] ?? "";
  for (const raw of extra.split(/[,\s]+/).filter(Boolean)) {
    try {
      const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
      set.add(u.hostname.replace(/^www\./, "").toLowerCase());
    } catch {
      // ignore
    }
  }
  return set;
}

function isSafeUrl(url: string, allowed: Set<string>): boolean {
  if (allowed.size === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  // Block private / loopback / link-local ranges (defense-in-depth even when
  // the allow-list itself is correctly configured).
  if (/^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1|0\.)/.test(host)) return false;
  return allowed.has(host);
}

export async function runAuditOrphans(site: SiteContext): Promise<void> {
  const [stats, posts, excludes, inventoryUrls] = await withDbRetry(
    () =>
      Promise.all([
        db.select().from(linkStatsTable).where(eq(linkStatsTable.siteId, site.id)),
        db.select().from(wpPostsTable).where(eq(wpPostsTable.siteId, site.id)),
        db.select().from(linkExcludeListTable).where(eq(linkExcludeListTable.siteId, site.id)),
        db.select({ url: inventoryTable.url }).from(inventoryTable).where(eq(inventoryTable.siteId, site.id)),
      ]),
    { label: "audit_orphans:reads" },
  );
  const titleByUrl = new Map(posts.map((p) => [p.url, p.title]));
  const excludeRegexes = excludes.map((e) => compilePattern(e.pattern));
  // Only real, live pages can be orphans. The link graph also accumulates
  // "ghost" URLs — old addresses that now redirect, tracking-parameter
  // variants (?utm_...), and pagination pages (/page/2/). Those aren't pages
  // that need internal links, so they'd bury the genuine orphans. A URL
  // counts as a real page when the CMS knows it (wp_posts, from the WP API)
  // or Search Console reports it as a live indexed page (inventory).
  const realPageUrls = new Set<string>([
    ...posts.map((p) => p.url),
    ...inventoryUrls.map((r) => r.url),
  ]);
  const orphans: OrphanItem[] = stats
    .filter((s) => s.inboundCount === 0)
    .filter((s) => realPageUrls.has(s.url))
    .filter((s) => !isExcluded(s.url, excludeRegexes))
    .map((s) => ({
      url: s.url,
      title: titleByUrl.get(s.url) ?? null,
      inboundCount: 0,
    }));
  await record(site.id, "orphans", orphans, orphans.length);
  logger.info(
    { count: orphans.length, excludePatterns: excludeRegexes.length },
    "Audit orphans: done",
  );
}

export async function runAuditOverLinked(site: SiteContext): Promise<void> {
  const [edges, posts] = await withDbRetry(
    () =>
      Promise.all([
        db.select().from(linkGraphTable).where(eq(linkGraphTable.siteId, site.id)),
        db.select().from(wpPostsTable).where(eq(wpPostsTable.siteId, site.id)),
      ]),
    { label: "audit_over_linked:reads" },
  );
  const titleByUrl = new Map(posts.map((p) => [p.url, p.title]));

  // This audit counts ONLY body-text (content-placement) internal links that
  // carry real anchor text. Navigation, sidebar, header, and footer links are
  // sitewide structure, not editorial linking choices, so they're excluded —
  // as are auto-generated / empty-anchor links. We group inbound links per
  // target so we can both count them and list the linking pages for drill-down.
  // Keyed by target, then by source page so each linking page is counted once.
  // A source can have multiple edges to the same target (the link-map crawler
  // stores one edge per distinct anchor); we keep the first real-anchor link so
  // the count and drill-down stay page-based, matching the "N pages" UI label.
  const inboundByTarget = new Map<string, Map<string, LinkingPage>>();
  for (const e of edges) {
    if (e.placement !== "content") continue;
    if (!hasRealAnchor(e.anchorText)) continue;
    const bySource = inboundByTarget.get(e.targetUrl) ?? new Map<string, LinkingPage>();
    if (!bySource.has(e.sourceUrl)) {
      bySource.set(e.sourceUrl, {
        sourceUrl: e.sourceUrl,
        anchorText: (e.anchorText ?? "").trim(),
        title: titleByUrl.get(e.sourceUrl) ?? null,
      });
    }
    inboundByTarget.set(e.targetUrl, bySource);
  }
  const overTargets: OverLinkedItem[] = [];
  for (const [url, bySource] of inboundByTarget.entries()) {
    const pages = Array.from(bySource.values());
    if (pages.length > OVER_LINKED_TARGET_THRESHOLD) {
      pages.sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl));
      overTargets.push({ kind: "target", url, count: pages.length, linkingPages: pages });
    }
  }

  // Anchor-text frequency — body links with real anchor text only. A sitewide
  // footer link with identical anchor text on every page would otherwise
  // dominate this list even though it's a single editorial decision.
  const anchorCounts = new Map<string, number>();
  for (const e of edges) {
    if (e.placement !== "content") continue;
    if (!hasRealAnchor(e.anchorText)) continue;
    const k = (e.anchorText ?? "").trim().toLowerCase();
    anchorCounts.set(k, (anchorCounts.get(k) ?? 0) + 1);
  }
  const overAnchors: OverLinkedItem[] = [];
  for (const [anchor, count] of anchorCounts.entries()) {
    if (count >= OVER_LINKED_ANCHOR_THRESHOLD) {
      overAnchors.push({ kind: "anchor", anchorText: anchor, count });
    }
  }
  const items = [...overTargets, ...overAnchors].sort((a, b) => b.count - a.count);
  await record(
    site.id,
    "over_linked",
    items.map((i) => ({ ...i, title: i.url ? titleByUrl.get(i.url) ?? null : null })),
    items.length,
  );
  logger.info({ count: items.length }, "Audit over-linked: done");
}

export async function runAuditBrokenLinks(site: SiteContext): Promise<void> {
  const [edges, excludes, stats, posts] = await withDbRetry(
    () =>
      Promise.all([
        db.select().from(linkGraphTable).where(eq(linkGraphTable.siteId, site.id)),
        db.select().from(linkExcludeListTable).where(eq(linkExcludeListTable.siteId, site.id)),
        db.select().from(linkStatsTable).where(eq(linkStatsTable.siteId, site.id)),
        db.select().from(wpPostsTable).where(eq(wpPostsTable.siteId, site.id)),
      ]),
    { label: "audit_broken_links:reads" },
  );
  const excludeRegexes = excludes.map((e) => compilePattern(e.pattern));
  const inboundByUrl = new Map(stats.map((s) => [s.url, s.inboundCount]));
  const titleByUrl = new Map(posts.map((p) => [p.url, p.title]));

  // Build the inbound-link list per target so a broken/redirecting URL can name
  // exactly which pages need their href fixed. Unlike the over-linked audit we
  // keep ALL placements (a broken link in nav/footer is still broken), dedup
  // per source page, and prefer a real anchor when one exists so the operator
  // can actually find the link on the page.
  const LINKING_PAGES_CAP = 200;
  const linkingByTarget = new Map<string, Map<string, LinkingPage>>();
  for (const e of edges) {
    const bySource = linkingByTarget.get(e.targetUrl) ?? new Map<string, LinkingPage>();
    const anchor = (e.anchorText ?? "").trim();
    const existing = bySource.get(e.sourceUrl);
    if (!existing) {
      bySource.set(e.sourceUrl, {
        sourceUrl: e.sourceUrl,
        anchorText: anchor,
        title: titleByUrl.get(e.sourceUrl) ?? null,
      });
    } else if (!hasRealAnchor(existing.anchorText) && hasRealAnchor(anchor)) {
      existing.anchorText = anchor;
    }
    linkingByTarget.set(e.targetUrl, bySource);
  }
  const linkingPagesFor = (url: string): LinkingPage[] =>
    Array.from((linkingByTarget.get(url) ?? new Map<string, LinkingPage>()).values())
      .sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl))
      .slice(0, LINKING_PAGES_CAP);

  const targets = new Set<string>();
  for (const e of edges) {
    if (isExcluded(e.targetUrl, excludeRegexes)) continue;
    targets.add(e.targetUrl);
  }
  const allowed = getAllowedHostnames();
  const safe = [...targets].filter((u) => isSafeUrl(u, allowed));
  const list = BROKEN_CHECK_LIMIT > 0 ? safe.slice(0, BROKEN_CHECK_LIMIT) : safe;
  const broken: BrokenItem[] = [];
  let idx = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = idx++;
      if (i >= list.length) return;
      const url = list[i]!;
      try {
        const res = await fetch(url, {
          method: "HEAD",
          redirect: "manual",
          signal: AbortSignal.timeout(8000),
        });
        if (res.status >= 300) {
          const item: BrokenItem = {
            url,
            status: res.status,
            inboundCount: inboundByUrl.get(url) ?? 0,
            linkingPages: linkingPagesFor(url),
          };
          if (res.status < 400) {
            const loc = res.headers.get("location");
            if (loc) {
              try {
                const dest = new URL(loc, url);
                // Only surface http(s) destinations — guards against a
                // malicious Location header (e.g. javascript:) becoming a
                // clickable href in the dashboard.
                if (dest.protocol === "http:" || dest.protocol === "https:") {
                  item.redirectTo = dest.href;
                }
              } catch {
                // Unparseable Location: drop it rather than store raw input.
              }
            }
          }
          broken.push(item);
        }
      } catch (e) {
        broken.push({
          url,
          status: null,
          error: e instanceof Error ? e.message : String(e),
          inboundCount: inboundByUrl.get(url) ?? 0,
          linkingPages: linkingPagesFor(url),
        });
      }
    }
  }
  await Promise.all(Array.from({ length: BROKEN_CONCURRENCY }, () => worker()));
  await record(site.id, "broken_links", broken, broken.length);
  logger.info({ checked: list.length, broken: broken.length }, "Audit broken links: done");
}
