export interface JobLabel {
  title: string;
  description: string;
  /** In-app route where the results / inputs of this job live. */
  route?: string;
  /** Short label for the "View" link next to the job (e.g. "Open link map"). */
  routeLabel?: string;
}

const JOB_LABELS: Record<string, JobLabel> = {
  crawl_link_map: {
    title: "Crawl Site & Build Link Map",
    description: "Crawls every page on the site and rebuilds the internal link graph.",
    route: "/link-map",
    routeLabel: "Open link map",
  },
  gsc_inventory_and_losers: {
    title: "Sync Google Search Console",
    description: "Pulls fresh GSC clicks/impressions and detects queries losing position.",
    route: "/gsc/overview",
    routeLabel: "Open GSC overview",
  },
  optimize_queued_urls: {
    title: "Generate Optimization Briefs",
    description: "Runs the AI optimizer over URLs queued from the Optimizer page.",
    route: "/optimize",
    routeLabel: "Open Optimizer",
  },
  crawl_wordpress: {
    title: "Sync WordPress Posts",
    description: "Pulls latest posts, pages, and metadata from WordPress.",
    route: "/wp/classifications",
    routeLabel: "Open WordPress posts",
  },
  reembed_wordpress: {
    title: "Refresh Post Embeddings",
    description: "Regenerates semantic embeddings for WordPress content (used for link matching).",
    route: "/wp/classifications",
    routeLabel: "Open WordPress posts",
  },
  semantic_linking: {
    title: "Generate Internal Link Suggestions",
    description: "Scores donor→receiver pairs and produces the suggestions on the Semantic Links page.",
    route: "/semantic-links#inbox",
    routeLabel: "Open Suggestions inbox",
  },
  audit_orphans: {
    title: "Audit: Orphan Pages",
    description: "Finds pages with zero inbound internal links.",
    route: "/semantic-links#orphans",
    routeLabel: "Open Orphans audit",
  },
  audit_over_linked: {
    title: "Audit: Over-Linked Pages",
    description: "Finds pages receiving an unusually high share of internal links.",
    route: "/semantic-links#over_linked",
    routeLabel: "Open Over-linked audit",
  },
  audit_broken_links: {
    title: "Audit: Broken Internal Links",
    description: "Finds internal links pointing at missing or 404 pages.",
    route: "/semantic-links#broken",
    routeLabel: "Open Broken Links audit",
  },
  run_full_pipeline: {
    title: "Run Full Pipeline",
    description: "Runs every job sequentially: WP crawl → sitemap crawl → GSC sync → semantic linking → all 3 audits → optimize queued URLs. Skips the monthly re-embed.",
  },
  recompute_action_queue: {
    title: "Refresh Action Queue",
    description: "Rebuilds the ranked 'do this next' list from current orphans, losers, suggestions, and the optimize queue.",
    route: "/actions",
    routeLabel: "Open Action Queue",
  },
  weekly_digest: {
    title: "Weekly Digest",
    description: "Summarizes the week: health score change, new issues found, work completed, and pages that improved. Runs Fridays at 10:00 UTC.",
    route: "/digest",
    routeLabel: "Open Weekly Digest",
  },
};

export function getJobLabel(name: string): JobLabel {
  return (
    JOB_LABELS[name] ?? {
      title: name,
      description: "",
    }
  );
}
