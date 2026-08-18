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
 */

import React from "react";
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, fireEvent, cleanup, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ReferringDomainsCard } from "./backlink-audit";
import type { AuditReferringDomain } from "@workspace/api-client-react";

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

/** Helper: render ReferringDomainsCard wrapped in the required providers. */
function renderCard(referringDomains: AuditReferringDomain[]) {
  return render(
    <TooltipProvider>
      <ReferringDomainsCard referringDomains={referringDomains} />
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
    // The badge text inside the button should match the number of flagged domains (2)
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

    // Flagged domains must be visible
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

    // Clean domains must NOT appear in the table
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
    // Extract count from badge text (the button textContent is "Flagged 2")
    const badgeCount = parseInt(btn.textContent?.replace(/\D/g, "") ?? "0", 10);

    fireEvent.click(btn);

    // Data rows (excluding header row)
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

    // Enable flagged view
    fireEvent.click(getByTestId("button-filter-flagged"));
    // Disable flagged view
    fireEvent.click(getByTestId("button-filter-flagged"));

    // All domains should be back
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

    const rows = getAllByRole("row").slice(1); // skip header
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
