// @vitest-environment jsdom
/**
 * Component integration tests for ReferringDomainsCard (inside backlink-audit.tsx).
 *
 * Confirms that the disavow drawer (the flagged-domains view) wires
 * `isDomainFlagged` correctly:
 *   - Only medium/high-risk domains appear when the Flagged filter is active
 *   - Clean (low-risk) domains are absent from the flagged view
 *   - The badge count on the Flagged button equals the number of flagged domains
 *   - The "Export disavow.txt" button is absent when zero flagged domains exist
 *   - Manually saved disavow decisions survive an audit re-run (new referringDomains prop)
 *   - Manual decisions are scoped per site ID and never bleed across sites
 *   - Combined domain-risk + anchor-spam rows are highlighted and sorted first
 */

import React from "react";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ReferringDomainsCard, disavowStorageKey, loadManualDisavow } from "./backlink-audit";
import type { AuditReferringDomain, TopBacklink } from "@workspace/api-client-react";

// ---------------------------------------------------------------------------
// Mock useSiteContext so the component works without a full SiteProvider
// ---------------------------------------------------------------------------
let mockSiteId: number = 1;

vi.mock("@/lib/site-context", () => ({
  useSiteContext: () => ({
    activeSite: { id: mockSiteId, displayName: `Site ${mockSiteId}` },
    sites: [],
    switchSite: vi.fn(),
  }),
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

beforeEach(() => {
  mockSiteId = 1;
  localStorage.clear();
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
// Tests: mixed clean + flagged domains
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
    expect(btn.textContent).toContain("2");
  });

  it("does not render the Export disavow.txt button when the flagged filter is inactive", () => {
    const { queryByTestId } = renderCard([cleanDomain, flaggedMedium, flaggedHigh]);

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
    const { getByTestId, queryByText } = renderCard([
      cleanDomain,
      cleanDomain2,
      flaggedMedium,
      flaggedHigh,
    ]);

    fireEvent.click(getByTestId("button-filter-flagged"));

    expect(queryByText("reputable.com")).toBeNull();
    expect(queryByText("trusted.org")).toBeNull();
  });

  it("shows exactly the flagged-domain rows (count matches badge)", () => {
    const { getByTestId, getAllByRole } = renderCard([
      cleanDomain,
      flaggedMedium,
      flaggedHigh,
    ]);

    const btn = getByTestId("button-filter-flagged");
    const badgeCount = parseInt(btn.textContent?.replace(/\D/g, "") ?? "0", 10);

    fireEvent.click(btn);

    const rows = getAllByRole("row").slice(1);
    expect(rows).toHaveLength(badgeCount);
  });

  it("shows the Export disavow.txt button once the flagged filter is active", () => {
    const { getByTestId } = renderCard([cleanDomain, flaggedMedium]);

    fireEvent.click(getByTestId("button-filter-flagged"));

    expect(getByTestId("button-export-disavow")).toBeTruthy();
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

  it("does not render the Export disavow.txt button when every domain is clean", () => {
    const { queryByTestId } = renderCard([cleanDomain, cleanDomain2]);

    expect(queryByTestId("button-filter-flagged")).toBeNull();
    expect(queryByTestId("button-export-disavow")).toBeNull();
  });

  it("still renders the domain rows when every domain is clean", () => {
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
    const { getByTestId, getAllByRole } = renderCard([flaggedMedium, flaggedHigh]);

    fireEvent.click(getByTestId("button-filter-flagged"));

    const rows = getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
  });

  it("badge count equals total domain count when all are flagged", () => {
    const { getByTestId } = renderCard([flaggedMedium, flaggedHigh]);

    const btn = getByTestId("button-filter-flagged");
    expect(btn.textContent).toContain("2");
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
// Tests: manual disavow decisions survive an audit re-run
//
// "Re-run" = the parent re-renders ReferringDomainsCard with new referringDomains
// data (exactly what happens when React Query cache is updated after an audit).
// The manualDisavow state persists because it is keyed by siteId in localStorage
// and reloaded via useEffect whenever storageKey changes.
// ---------------------------------------------------------------------------

describe("ReferringDomainsCard — manual disavow decisions survive audit re-run", () => {
  it("manual flag toggle shows the export button even for a clean domain", () => {
    const { getByTestId } = renderCard([cleanDomain]);

    // No flagged domains → export button hidden by default
    expect(getByTestId(`button-toggle-disavow-${cleanDomain.domain}`)).toBeTruthy();

    // Toggle a clean domain into the manual disavow set
    fireEvent.click(getByTestId(`button-toggle-disavow-${cleanDomain.domain}`));

    // Export button should now appear
    expect(getByTestId("button-export-disavow")).toBeTruthy();
  });

  it("manual decision persists to localStorage under the site-scoped key", () => {
    const { getByTestId } = renderCard([cleanDomain]);

    fireEvent.click(getByTestId(`button-toggle-disavow-${cleanDomain.domain}`));

    const key = disavowStorageKey(mockSiteId);
    const stored = loadManualDisavow(key);
    expect(stored.has(cleanDomain.domain)).toBe(true);
  });

  it("manual decision survives a re-render with new referringDomains (simulated audit re-run)", () => {
    const { getByTestId, rerender } = renderCard([cleanDomain, cleanDomain2]);
    fireEvent.click(getByTestId(`button-toggle-disavow-${cleanDomain.domain}`));

    // Confirm it was saved under site 1's key
    expect(loadManualDisavow(disavowStorageKey(1)).has(cleanDomain.domain)).toBe(true);

    // Re-render with new referringDomains (simulating what React Query does on audit re-run)
    rerender(
      <TooltipProvider>
        <ReferringDomainsCard referringDomains={[cleanDomain, cleanDomain2]} />
      </TooltipProvider>,
    );

    // The manually marked domain's toggle must still be active (flag icon filled)
    const toggleBtn = getByTestId(`button-toggle-disavow-${cleanDomain.domain}`);
    expect(toggleBtn.title).toBe("Remove from disavow list");
  });

  it("un-marking a domain removes it from localStorage and hides the export button", () => {
    const { getByTestId, queryByTestId } = renderCard([cleanDomain]);

    // Mark then unmark
    fireEvent.click(getByTestId(`button-toggle-disavow-${cleanDomain.domain}`));
    fireEvent.click(getByTestId(`button-toggle-disavow-${cleanDomain.domain}`));

    const key = disavowStorageKey(mockSiteId);
    expect(loadManualDisavow(key).has(cleanDomain.domain)).toBe(false);
    expect(queryByTestId("button-export-disavow")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: manual disavow decisions are scoped per site — no cross-site bleed
// ---------------------------------------------------------------------------

describe("ReferringDomainsCard — manual decisions are scoped per site ID", () => {
  it("decisions saved under site 1 are not loaded when siteId changes to 2", () => {
    // Render as site 1 and mark a clean domain
    mockSiteId = 1;
    const { getByTestId, rerender } = renderCard([cleanDomain, cleanDomain2]);
    fireEvent.click(getByTestId(`button-toggle-disavow-${cleanDomain.domain}`));

    // Confirm it was saved under site 1's key
    expect(loadManualDisavow(disavowStorageKey(1)).has(cleanDomain.domain)).toBe(true);

    // Switch to site 2 (mockSiteId drives useSiteContext)
    mockSiteId = 2;
    rerender(
      <TooltipProvider>
        <ReferringDomainsCard referringDomains={[cleanDomain]} />
      </TooltipProvider>,
    );

    // Site 2 has no saved decisions → export button must be hidden
    expect(getByTestId(`button-toggle-disavow-${cleanDomain.domain}`).title).toBe(
      "Mark for disavowal",
    );
  });

  it("site 1 and site 2 maintain independent disavow sets in localStorage", () => {
    // Mark a domain under site 1
    mockSiteId = 1;
    const { getByTestId, rerender } = renderCard([cleanDomain, cleanDomain2]);
    fireEvent.click(getByTestId(`button-toggle-disavow-${cleanDomain.domain}`));

    // Switch to site 2 and mark a different domain
    mockSiteId = 2;
    rerender(
      <TooltipProvider>
        <ReferringDomainsCard referringDomains={[cleanDomain, cleanDomain2]} />
      </TooltipProvider>,
    );
    fireEvent.click(getByTestId(`button-toggle-disavow-${cleanDomain2.domain}`));

    // Verify the two site keys are independent
    expect(loadManualDisavow(disavowStorageKey(1)).has(cleanDomain.domain)).toBe(true);
    expect(loadManualDisavow(disavowStorageKey(1)).has(cleanDomain2.domain)).toBe(false);
    expect(loadManualDisavow(disavowStorageKey(2)).has(cleanDomain2.domain)).toBe(true);
    expect(loadManualDisavow(disavowStorageKey(2)).has(cleanDomain.domain)).toBe(false);
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
      [sitewideVolumeDomain, cleanDomain],
      [spamBacklinkFromSitewide, cleanBacklink],
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
