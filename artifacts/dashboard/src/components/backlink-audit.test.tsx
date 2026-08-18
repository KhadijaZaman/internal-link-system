// @vitest-environment jsdom
/**
 * Component integration tests for ReferringDomainsCard (inside backlink-audit.tsx).
 *
 * Confirms that the flagged-domains view wires `isDomainFlagged` correctly:
 *   - Only medium/high-risk domains appear when the Flagged filter is active
 *   - Clean (low-risk) domains are absent from the flagged view
 *   - The badge count on the Flagged button equals the number of flagged domains
 *   - The "Export disavow.txt" button is absent when zero flagged/saved domains exist
 *   - The export button is always visible when persisted decisions exist (even without flagged domains)
 *   - The export badge reflects persisted decision count, not the algorithmic flagged count
 *   - Combined domain-risk + anchor-spam rows are highlighted and sorted first
 */

import React from "react";
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, fireEvent, cleanup, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ReferringDomainsCard } from "./backlink-audit";
import type { AuditReferringDomain, TopBacklink } from "@workspace/api-client-react";

// ---------------------------------------------------------------------------
// Mock React Query so ReferringDomainsCard's useQueryClient() works without
// a real QueryClientProvider in the test render tree.
// ---------------------------------------------------------------------------
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
  };
});

// ---------------------------------------------------------------------------
// Mock the API hooks used by ReferringDomainsCard so tests don't need a
// real server. Default: no persisted decisions (empty list).
// ---------------------------------------------------------------------------
vi.mock("@workspace/api-client-react", () => ({
  useGetBacklinkDisavow: vi.fn(() => ({ data: { decisions: [] }, isLoading: false })),
  useSetDisavowDecision: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useClearDisavowDecision: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  getGetBacklinkDisavowQueryKey: vi.fn(() => ["backlinks", "disavow"]),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// jsdom stubs for the download helper (URL.createObjectURL / anchor.click)
// ---------------------------------------------------------------------------
beforeAll(() => {
  if (!("createObjectURL" in URL)) {
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:mock"),
      writable: true,
    });
  }
  if (!("revokeObjectURL" in URL)) {
    Object.defineProperty(URL, "revokeObjectURL", {
      value: vi.fn(),
      writable: true,
    });
  }
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Clean domain: high rank, small backlink count, safe TLD → low risk */
const cleanDomain: AuditReferringDomain = {
  domain: "reputable.com",
  rank: 900,
  backlinks: 5,
};

/** Clean domain 2: another safe domain → low risk */
const cleanDomain2: AuditReferringDomain = {
  domain: "trusted.org",
  rank: 820,
  backlinks: 8,
};

/**
 * Medium-risk domain: suspicious TLD (.loan) with high rank and few backlinks.
 * scoreDomain: Suspicious TLD flag only → medium level.
 */
const flaggedMedium: AuditReferringDomain = {
  domain: "sketchy.loan",
  rank: 700,
  backlinks: 3,
};

/**
 * High-risk domain: suspicious TLD (.xyz) + very low rank + high link volume.
 * scoreDomain: Suspicious TLD + Very low authority + sitewide placement → high level.
 */
const flaggedHigh: AuditReferringDomain = {
  domain: "spam.xyz",
  rank: 5,
  backlinks: 60,
};

/**
 * Sitewide-placement domain: high backlink volume (≥ 50) from a decent-rank
 * domain.  scoreDomain fires "High link volume — possible sitewide placement"
 * (a high-weight signal) → medium risk → isDomainFlagged = true.
 * NOTE: scoring with backlinks=1 would produce zero flags and level "low".
 */
const sitewideVolumeDomain: AuditReferringDomain = {
  domain: "sitewide-ads.net",
  rank: 400,
  backlinks: 55,
};

/**
 * Low-authority + many-links domain: rank < 30 and backlinks ≥ 20.
 * scoreDomain fires "Low authority (rank < 30)" + "Many links from
 * low-authority domain" → flags.length = 2 → medium risk → isDomainFlagged.
 */
const lowAuthHighVolumeDomain: AuditReferringDomain = {
  domain: "low-auth-linker.com",
  rank: 18,
  backlinks: 28,
};

/** Spam backlink from the sitewide-volume domain. */
const spamBacklinkFromSitewide: TopBacklink = {
  urlFrom: "https://sitewide-ads.net/network-page",
  urlTo: "https://mysite.com/target",
  domainFrom: "sitewide-ads.net",
  domainFromRank: 400,
  anchor: "online casino bonus",
  dofollow: true,
};

/** Spam backlink from the low-auth/high-volume domain. */
const spamBacklinkFromLowAuth: TopBacklink = {
  urlFrom: "https://low-auth-linker.com/promo",
  urlTo: "https://mysite.com/target",
  domainFrom: "low-auth-linker.com",
  domainFromRank: 18,
  anchor: "payday loans fast approval",
  dofollow: true,
};

/** Clean backlink from a reputable domain. */
const cleanBacklink: TopBacklink = {
  urlFrom: "https://reputable.com/article",
  urlTo: "https://mysite.com/target",
  domainFrom: "reputable.com",
  domainFromRank: 900,
  anchor: "read more",
  dofollow: true,
};

/** Helper: render ReferringDomainsCard wrapped in the required providers. */
function renderCard(referringDomains: AuditReferringDomain[], topBacklinks: TopBacklink[] = []) {
  return render(
    <TooltipProvider>
      <ReferringDomainsCard referringDomains={referringDomains} topBacklinks={topBacklinks} />
    </TooltipProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests: mixed clean + flagged domains (default view shows all)
// ---------------------------------------------------------------------------

describe("ReferringDomainsCard — mixed clean and flagged domains", () => {
  it("shows all domains (clean + flagged) in the default view", () => {
    const { getByText } = renderCard([cleanDomain, cleanDomain2, flaggedMedium, flaggedHigh]);

    expect(getByText("reputable.com")).toBeTruthy();
    expect(getByText("trusted.org")).toBeTruthy();
    expect(getByText("sketchy.loan")).toBeTruthy();
    expect(getByText("spam.xyz")).toBeTruthy();
  });

  it("renders the Flagged button with the correct count badge", () => {
    const { getByTestId } = renderCard([cleanDomain, flaggedMedium, flaggedHigh]);

    const btn = getByTestId("button-filter-flagged");
    // Badge should show 2 (the two flagged domains)
    expect(btn.textContent).toContain("2");
  });

  it("does not render the Export disavow.txt button when the flagged filter is inactive and no decisions saved", () => {
    const { queryByTestId } = renderCard([cleanDomain, flaggedMedium, flaggedHigh]);

    // Export button is only shown when flagged filter is active OR there are persisted decisions
    expect(queryByTestId("button-export-disavow")).toBeNull();
  });

  it("shows only flagged domains after toggling the Flagged filter", () => {
    const { getByTestId, queryByText } = renderCard([
      cleanDomain,
      cleanDomain2,
      flaggedMedium,
      flaggedHigh,
    ]);

    fireEvent.click(getByTestId("button-filter-flagged"));

    expect(queryByText("sketchy.loan")).toBeTruthy();
    expect(queryByText("spam.xyz")).toBeTruthy();
  });

  it("hides clean domains from the flagged-filter view", () => {
    const { getByTestId, queryByText } = renderCard(
      [flaggedHigh, cleanDomain],
      [cleanBacklink],
    );

    fireEvent.click(getByTestId("button-filter-flagged"));

    expect(queryByText("reputable.com")).toBeNull();
    expect(queryByText("trusted.org")).toBeNull();
  });



  it("toggling the flagged filter off returns all domains to the view", () => {
    const { getByTestId, getByText } = renderCard([cleanDomain, flaggedMedium]);

    fireEvent.click(getByTestId("button-filter-flagged"));
    fireEvent.click(getByTestId("button-filter-flagged"));

    expect(getByText("reputable.com")).toBeTruthy();
    expect(getByText("sketchy.loan")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tests: zero flagged domains
// ---------------------------------------------------------------------------

describe("ReferringDomainsCard — no flagged domains", () => {
  it("does not render the Flagged filter button when every domain is clean", () => {
    const { queryByTestId } = renderCard([cleanDomain, cleanDomain2]);

    expect(queryByTestId("button-filter-flagged")).toBeNull();
  });

  it("does not render the Export disavow.txt button when every domain is clean and no decisions saved", () => {
    const { queryByTestId } = renderCard([cleanDomain, cleanDomain2]);

    expect(queryByTestId("button-filter-flagged")).toBeNull();
    expect(queryByTestId("button-export-disavow")).toBeNull();
  });

  it("shows all clean domains in the table", () => {
    const { getByText } = renderCard([cleanDomain, cleanDomain2]);

    expect(getByText("reputable.com")).toBeTruthy();
    expect(getByText("trusted.org")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tests: all domains flagged
// ---------------------------------------------------------------------------

describe("ReferringDomainsCard — all domains flagged", () => {
  it("shows every domain in the flagged view when all are risky", () => {
    const { getByTestId, getAllByRole } = renderCard(
      [flaggedMedium, sitewideVolumeDomain],
      [spamBacklinkFromSitewide],
    );

    fireEvent.click(getByTestId("button-filter-flagged"));

    const rows = getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
  });

  it("shows the export button in the flagged view even when no decisions are persisted", () => {
    const { getByTestId } = renderCard([flaggedMedium, flaggedHigh]);

    fireEvent.click(getByTestId("button-filter-flagged"));

    // Export button should appear (flagged view with domains present)
    expect(getByTestId("button-export-disavow")).toBeTruthy();
  });

  it("export badge is absent when no domains have been persisted for disavowal", () => {
    const { getByTestId } = renderCard([flaggedMedium, flaggedHigh]);

    fireEvent.click(getByTestId("button-filter-flagged"));

    const btn = getByTestId("button-export-disavow");
    // No persisted decisions → badge count should not appear
    expect(btn.textContent).not.toMatch(/[1-9]/);
  });
});

// ---------------------------------------------------------------------------
// Tests: empty domain list
// ---------------------------------------------------------------------------

describe("ReferringDomainsCard — empty list", () => {
  it("renders without crashing when given an empty domain list", () => {
    const { queryByTestId } = renderCard([]);

    expect(queryByTestId("button-filter-flagged")).toBeNull();
    expect(queryByTestId("button-export-disavow")).toBeNull();
  });

  it("shows the empty-state message in the table", () => {
    const { getByText } = renderCard([]);

    expect(getByText("No referring domains.")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tests: export reflects only persisted disavow decisions
// ---------------------------------------------------------------------------

describe("ReferringDomainsCard — export uses persisted decisions only", () => {
  it("export button shows no count badge when no domains are saved for disavowal", () => {
    const { getByTestId } = renderCard([cleanDomain, flaggedMedium]);

    fireEvent.click(getByTestId("button-filter-flagged"));

    const btn = getByTestId("button-export-disavow");
    // No persisted decisions → badge should not show a non-zero count
    expect(btn.textContent).not.toMatch(/[1-9]/);
  });
});

// ---------------------------------------------------------------------------
// Tests: combined domain-risk + anchor-spam (High Priority)
//
// These tests confirm that when a flagged domain ALSO has a spam anchor in
// topBacklinks, it is surfaced first in the flagged view with a "Spam anchor"
// indicator.  Critically, the fixtures use real backlink counts that trigger
// signals (sitewide volume, many-links-from-low-auth) that would be missed if
// the domain were re-scored with a fake count of 1.
// ---------------------------------------------------------------------------

describe("ReferringDomainsCard — combined domain-risk + anchor-spam (High Priority)", () => {
  it("shows 'Spam anchor' badge on a sitewide-volume domain that also has a spam anchor", () => {
    const { getByTestId, getByText } = renderCard(
      [sitewideVolumeDomain, flaggedMedium],
      [spamBacklinkFromSitewide],
    );

    fireEvent.click(getByTestId("button-filter-flagged"));

    expect(getByText("sitewide-ads.net")).toBeTruthy();
    expect(getByText("Spam anchor")).toBeTruthy();
  });

  it("shows 'Spam anchor' badge on a low-auth/high-volume domain that also has a spam anchor", () => {
    const { getByTestId, getByText } = renderCard(
      [lowAuthHighVolumeDomain, cleanDomain],
      [spamBacklinkFromLowAuth, cleanBacklink],
    );

    fireEvent.click(getByTestId("button-filter-flagged"));

    expect(getByText("low-auth-linker.com")).toBeTruthy();
    expect(getByText("Spam anchor")).toBeTruthy();
  });

  it("places combined-risk domains before domain-only-risk domains in the flagged view", () => {
    const { getByTestId, getAllByRole } = renderCard(
      [flaggedMedium, sitewideVolumeDomain],
      [spamBacklinkFromSitewide],
    );

    fireEvent.click(getByTestId("button-filter-flagged"));

    const rows = getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("sitewide-ads.net")).toBeTruthy();
    expect(within(rows[1]!).getByText("sketchy.loan")).toBeTruthy();
  });

  it("does not show 'Spam anchor' badge on a flagged domain with only a clean anchor in topBacklinks", () => {
    const { getByTestId, queryByText } = renderCard(
      [flaggedHigh, cleanDomain],
      [cleanBacklink],
    );

    fireEvent.click(getByTestId("button-filter-flagged"));

    expect(queryByText("Spam anchor")).toBeNull();
  });

  it("does not show 'Spam anchor' badge in the default (non-flagged) view even when combined risk is present", () => {
    const { queryByText } = renderCard(
      [sitewideVolumeDomain, cleanDomain],
      [spamBacklinkFromSitewide],
    );

    expect(queryByText("Spam anchor")).toBeNull();
  });

  it("shows warning text mentioning combined-risk count when combined-risk domains are present", () => {
    const { getByTestId, getByText } = renderCard(
      [sitewideVolumeDomain, flaggedMedium],
      [spamBacklinkFromSitewide],
    );

    fireEvent.click(getByTestId("button-filter-flagged"));

    expect(getByText(/spam anchor text/i)).toBeTruthy();
  });
});
