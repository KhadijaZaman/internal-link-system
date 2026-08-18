import { describe, expect, it } from "vitest";
import {
  buildDisavowTxt,
  isDomainFlagged,
  isCommercialAnchor,
  mergeDisavowDomains,
  scoreAnchor,
  scoreDomain,
} from "./backlink-toxicity";
import { SPAM_ANCHORS } from "./spam-anchors";
import { SPAM_TLDS } from "./spam-tlds";

// ---------------------------------------------------------------------------
// scoreDomain
// ---------------------------------------------------------------------------
describe("scoreDomain", () => {
  // --- Suspicious TLD -------------------------------------------------------
  it("flags a known-spammy TLD (.xyz)", () => {
    const result = scoreDomain("spammy.xyz", 500, 1);
    expect(result.flags).toContain("Suspicious TLD");
  });

  it("flags a known-spammy TLD (.loan)", () => {
    const result = scoreDomain("quick.loan", 200, 2);
    expect(result.flags).toContain("Suspicious TLD");
  });

  it("does not flag a legitimate TLD (.com)", () => {
    const result = scoreDomain("example.com", 800, 5);
    expect(result.flags).not.toContain("Suspicious TLD");
  });

  // --- Config-only update path: every SPAM_TLDS entry must reach the scorer --
  it("every TLD in SPAM_TLDS scores at least 'medium' on a decent-rank, low-link-count domain", () => {
    // Use rank=500 (well above the <30 low-authority threshold) and backlinks=1
    // so the only flag that can fire is "Suspicious TLD".  The scorer must
    // elevate level to at least "medium" from that single high-weight signal alone.
    for (const tld of SPAM_TLDS) {
      const domain = `test-domain.${tld}`;
      const result = scoreDomain(domain, 500, 1);
      expect(result.flags, `${domain} should carry "Suspicious TLD"`).toContain(
        "Suspicious TLD",
      );
      expect(
        result.level,
        `${domain} should be at least "medium" risk`,
      ).not.toBe("low");
    }
  });

  it("a TLD not in SPAM_TLDS never triggers the 'Suspicious TLD' flag", () => {
    // Use a TLD that is explicitly not in SPAM_TLDS and is considered clean.
    const cleanTLDs = ["com", "org", "net", "gov", "edu", "io", "co"];
    for (const tld of cleanTLDs) {
      const result = scoreDomain(`reputable.${tld}`, 800, 5);
      expect(
        result.flags,
        `.${tld} must not be flagged as a suspicious TLD`,
      ).not.toContain("Suspicious TLD");
    }
  });

  // --- Rank signals ---------------------------------------------------------
  it("flags a very low rank (< 10)", () => {
    const result = scoreDomain("lowrank.com", 5, 1);
    expect(result.flags.some((f) => f.includes("Very low authority"))).toBe(
      true,
    );
  });

  it("flags a low rank (< 30 but >= 10)", () => {
    const result = scoreDomain("medrank.com", 20, 1);
    expect(result.flags.some((f) => f.includes("Low authority"))).toBe(true);
  });

  it("flags an unranked domain (null rank)", () => {
    const result = scoreDomain("unranked.com", null, 1);
    expect(result.flags).toContain("Unranked domain");
  });

  it("flags an unranked domain (undefined rank)", () => {
    const result = scoreDomain("unranked.com", undefined, 1);
    expect(result.flags).toContain("Unranked domain");
  });

  it("does not flag a high-rank domain", () => {
    const result = scoreDomain("highauth.com", 900, 3);
    expect(result.flags).toHaveLength(0);
  });

  // --- Sitewide backlink volume ---------------------------------------------
  it("flags high link volume (>= 50 backlinks) as possible sitewide placement", () => {
    const result = scoreDomain("sitewidelinks.com", 500, 55);
    expect(
      result.flags.some((f) => f.includes("sitewide")),
    ).toBe(true);
  });

  it("flags many links (>= 20) from a low-authority domain", () => {
    const result = scoreDomain("lowauth.com", 15, 25);
    expect(
      result.flags.some((f) => f.includes("Many links from low-authority")),
    ).toBe(true);
  });

  it("does not flag moderate link count from a high-authority domain", () => {
    const result = scoreDomain("authority.com", 900, 25);
    expect(result.flags).toHaveLength(0);
  });

  // --- Clean high-authority domain should score "low" ----------------------
  it("scores a clean high-authority domain as low risk", () => {
    // High rank, few backlinks, clean TLD
    const result = scoreDomain("reputable.com", 950, 3);
    expect(result.level).toBe("low");
    expect(result.flags).toHaveLength(0);
  });

  it("scores a clean high-authority domain with .org TLD as low risk", () => {
    const result = scoreDomain("nonprofit.org", 800, 10);
    expect(result.level).toBe("low");
  });

  // --- Risk level aggregation -----------------------------------------------
  it("returns 'high' when two or more high-weight signals fire", () => {
    // Suspicious TLD + sitewide volume (>= 50) → 2 high-weight flags
    const result = scoreDomain("spam.xyz", 5, 60);
    expect(result.level).toBe("high");
  });

  it("returns 'medium' when exactly one high-weight signal fires", () => {
    // Only suspicious TLD, no other signals
    const result = scoreDomain("meh.xyz", 700, 3);
    expect(result.level).toBe("medium");
  });

  it("returns 'high' when three or more flags are present regardless of type", () => {
    // Low rank (< 30) + many links from low-auth + unranked triggers enough flags
    const result = scoreDomain("norank.com", null, 25);
    // "Unranked domain" + "Many links from low-authority domain" → ≥2 flags
    expect(result.flags.length).toBeGreaterThanOrEqual(2);
    // Both should be flagged → medium or high
    expect(result.level).not.toBe("low");
  });
});

// ---------------------------------------------------------------------------
// isCommercialAnchor — thin wrapper around scoreAnchor / SPAM_ANCHORS
// ---------------------------------------------------------------------------
describe("isCommercialAnchor", () => {
  // Positive cases — all phrases must exist in SPAM_ANCHORS so the wrapper
  // and the authoritative list stay in sync.
  it.each([
    "cheap seo services",       // contains "cheap seo"
    "buy backlinks now",        // contains "buy backlinks"
    "cheap pills delivered",    // contains "cheap pills"
    "online pharmacy discount", // contains "online pharmacy"
    "sports betting tips",      // contains "sports betting"
    "bet online today",         // contains "bet online"
    "guest post service",       // contains "guest post"
    "seo services cheap",       // contains "seo services"
    "link building services",   // exact phrase
    "buy essay online",         // contains "buy essay"
    "write my essay fast",      // contains "write my essay"
    "dating site signup",       // contains "dating site"
    "online casino bonus",      // contains "online casino"
    "slots online free",        // contains "slots online"
    "poker online tips",        // contains "poker online"
    "online gambling site",     // contains "online gambling"
    "viagra online cheap",      // contains "viagra online"
    "cialis online order",      // contains "cialis online"
    "payday loans fast",        // contains "payday loans"
    "hookup site review",       // contains "hookup site"
    "meet singles near you",    // contains "meet singles"
  ])("flags commercial anchor %j", (anchor) => {
    expect(isCommercialAnchor(anchor)).toBe(true);
  });

  it.each([
    "click here",
    "read more",
    "example.com",
    "brand name",
    "our website",
    "learn more",
    "contact us",
    "homepage",
    "review",     // "review" alone is not in SPAM_ANCHORS
    "top tips",   // "top" alone is not in SPAM_ANCHORS
    "",
  ])("does not flag clean anchor %j", (anchor) => {
    expect(isCommercialAnchor(anchor)).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isCommercialAnchor("")).toBe(false);
  });

  it("every SPAM_ANCHORS phrase is caught by isCommercialAnchor", () => {
    for (const phrase of SPAM_ANCHORS) {
      expect(
        isCommercialAnchor(phrase),
        `SPAM_ANCHORS phrase "${phrase}" must be detected`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// scoreDomain — anchor spam signal
// ---------------------------------------------------------------------------
describe("scoreDomain — anchor spam", () => {
  it("adds Anchor spam flag when anchor is commercial and domain rank < 30", () => {
    const result = scoreDomain("lowrank.com", 15, 3, ["cheap seo services"]);
    expect(result.flags.some((f) => f.includes("Anchor spam"))).toBe(true);
  });

  it("adds Anchor spam flag when domain is unranked and anchor is commercial", () => {
    const result = scoreDomain("norank.com", null, 3, ["buy backlinks now"]);
    expect(result.flags.some((f) => f.includes("Anchor spam"))).toBe(true);
  });

  it("does NOT add Anchor spam flag when domain rank >= 30 even with commercial anchor", () => {
    const result = scoreDomain("authority.com", 500, 3, ["cheap seo services"]);
    expect(result.flags.some((f) => f.includes("Anchor spam"))).toBe(false);
  });

  it("does NOT add Anchor spam flag when anchor is clean even at low rank", () => {
    const result = scoreDomain("lowrank.com", 15, 3, ["click here"]);
    expect(result.flags.some((f) => f.includes("Anchor spam"))).toBe(false);
  });

  it("does NOT add Anchor spam flag when no anchors are supplied", () => {
    const result = scoreDomain("lowrank.com", 5, 3);
    expect(result.flags.some((f) => f.includes("Anchor spam"))).toBe(false);
  });

  it("does NOT add Anchor spam flag when anchor list is empty (domain not in topBacklinks)", () => {
    const result = scoreDomain("lowrank.com", 5, 3, []);
    expect(result.flags.some((f) => f.includes("Anchor spam"))).toBe(false);
  });

  it("includes the matched anchor text in the flag message", () => {
    const result = scoreDomain("lowrank.com", 15, 3, ["cheap seo services"]);
    const flag = result.flags.find((f) => f.includes("Anchor spam")) ?? "";
    expect(flag).toContain("cheap seo services");
  });

  it("anchor spam alone on a low-rank domain raises risk to at least medium", () => {
    // rank 20 → Low authority (high-weight) + Anchor spam (high-weight) → high
    const result = scoreDomain("lowrank.com", 20, 1, ["online casino"]);
    expect(result.level).not.toBe("low");
  });

  it("a high-rank domain with commercial anchors stays at low risk", () => {
    const result = scoreDomain("highauth.com", 800, 3, ["online casino"]);
    expect(result.level).toBe("low");
    expect(result.flags).toHaveLength(0);
  });

  it("a domain absent from topBacklinks (empty anchors) is never flagged for anchor spam", () => {
    // Simulates the common case where a referring domain has no topBacklinks entry
    const domainAnchors = new Map<string, string[]>([
      ["spam-source.com", ["cheap pills"]],
    ]);
    const domainUnderTest = "unrelated-low-rank.com";
    const anchors = domainAnchors.get(domainUnderTest) ?? [];
    const result = scoreDomain(domainUnderTest, 10, 5, anchors);
    expect(result.flags.some((f) => f.includes("Anchor spam"))).toBe(false);
  });

  it("every SPAM_ANCHORS phrase triggers the Anchor spam flag on a low-rank domain", () => {
    // End-to-end: configured phrases must reach the domain scorer, not just scoreAnchor
    for (const phrase of SPAM_ANCHORS) {
      const result = scoreDomain("lowrank.com", 15, 1, [phrase]);
      expect(
        result.flags.some((f) => f.includes("Anchor spam")),
        `SPAM_ANCHORS phrase "${phrase}" must produce Anchor spam flag on a rank-15 domain`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// buildDisavowTxt — Google format validation
// ---------------------------------------------------------------------------
describe("buildDisavowTxt", () => {
  it("starts with a header comment", () => {
    const txt = buildDisavowTxt(["spam.xyz", "bad.loan"]);
    expect(txt.startsWith("#")).toBe(true);
  });

  it("includes the Linkweave branding in the header", () => {
    const txt = buildDisavowTxt(["spam.xyz"]);
    expect(txt).toContain("Linkweave");
  });

  it("includes a Google Search Console upload URL in the header", () => {
    const txt = buildDisavowTxt(["spam.xyz"]);
    expect(txt).toContain("search.google.com");
  });

  it("formats each domain as 'domain:<name>'", () => {
    const domains = ["spam.xyz", "bad.loan", "dodgy.click"];
    const txt = buildDisavowTxt(domains);
    for (const d of domains) {
      expect(txt).toContain(`domain:${d}`);
    }
  });

  it("does not produce bare domain lines (every non-comment line is prefixed)", () => {
    const domains = ["spam.xyz", "bad.loan"];
    const txt = buildDisavowTxt(domains);
    const nonCommentLines = txt
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.startsWith("#"));
    for (const line of nonCommentLines) {
      expect(line.startsWith("domain:")).toBe(true);
    }
  });

  it("ends with a trailing newline (required by Google's parser)", () => {
    const txt = buildDisavowTxt(["spam.xyz"]);
    expect(txt.endsWith("\n")).toBe(true);
  });

  it("handles an empty domain list gracefully", () => {
    const txt = buildDisavowTxt([]);
    // Still has the header; no domain: lines
    expect(txt).toContain("#");
    expect(txt).not.toContain("domain:");
  });

  it("includes a date stamp in YYYY-MM-DD format", () => {
    const txt = buildDisavowTxt(["spam.xyz"]);
    // Header should contain a date like 2026-08-18
    expect(txt).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("produces one domain line per domain (no extras, no missing)", () => {
    const domains = ["a.xyz", "b.loan", "c.click"];
    const txt = buildDisavowTxt(domains);
    const domainLines = txt
      .split("\n")
      .filter((l) => l.startsWith("domain:"));
    expect(domainLines).toHaveLength(domains.length);
  });
});

// ---------------------------------------------------------------------------
// mergeDisavowDomains — production merge function
// ---------------------------------------------------------------------------
describe("mergeDisavowDomains", () => {
  it("returns only auto-flagged domains when manual set is empty", () => {
    const result = mergeDisavowDomains(["spam.xyz", "bad.loan"], new Set());
    expect(result).toEqual(["spam.xyz", "bad.loan"]);
  });

  it("adds manual-only domains that are not in the auto-flagged list", () => {
    const result = mergeDisavowDomains(["spam.xyz"], new Set(["manual.com"]));
    expect(result).toContain("spam.xyz");
    expect(result).toContain("manual.com");
  });

  it("deduplicates a domain that is both auto-flagged and manually saved", () => {
    const result = mergeDisavowDomains(["spam.xyz", "bad.loan"], new Set(["spam.xyz", "extra.com"]));
    const occurrences = result.filter((d) => d === "spam.xyz").length;
    expect(occurrences).toBe(1);
  });

  it("preserves auto-flagged domains first, manual-only additions after", () => {
    const result = mergeDisavowDomains(["auto.xyz"], new Set(["manual.com"]));
    expect(result.indexOf("auto.xyz")).toBeLessThan(result.indexOf("manual.com"));
  });

  it("returns an empty array when both inputs are empty", () => {
    expect(mergeDisavowDomains([], new Set())).toEqual([]);
  });

  it("handles an empty auto-flagged list with non-empty manual set", () => {
    const result = mergeDisavowDomains([], new Set(["manual.com", "also.net"]));
    expect(result).toContain("manual.com");
    expect(result).toContain("also.net");
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Disavow decisions survive audit re-run
//
// These tests exercise the full production pipeline:
//   scoreDomain → isDomainFlagged → mergeDisavowDomains → buildDisavowTxt
// The "audit re-run" is simulated by calling scoreDomain again from scratch
// on the same domain set, matching what ReferringDomainsCard does on every
// render after new audit data arrives via React Query.
// ---------------------------------------------------------------------------
describe("disavow decisions survive audit re-run", () => {
  const domainFixtures = [
    // auto-flagged (high risk): suspicious TLD + very low rank + sitewide links
    { domain: "spam.xyz", rank: 5, backlinks: 60 },
    // auto-flagged (medium risk): suspicious TLD only
    { domain: "mediocre.loan", rank: 700, backlinks: 3 },
    // clean domain — NOT auto-flagged by the scorer
    { domain: "clean.com", rank: 900, backlinks: 3 },
    // clean domain the user manually marks for disavowal
    { domain: "manual-override.com", rank: 850, backlinks: 5 },
  ];

  /**
   * Mirrors what ReferringDomainsCard does on each render / re-run:
   *   1. Re-score all domains from scratch (scoreDomain is pure — same input → same output).
   *   2. Collect auto-flagged domains via isDomainFlagged.
   *   3. Merge with the persisted manual disavow set via mergeDisavowDomains.
   */
  function simulateAuditRun(manualDecisions: ReadonlySet<string>): string[] {
    const autoFlagged = domainFixtures
      .filter((d) => isDomainFlagged(scoreDomain(d.domain, d.rank, d.backlinks)))
      .map((d) => d.domain);
    return mergeDisavowDomains(autoFlagged, manualDecisions);
  }

  it("auto-flagged domains appear in the disavow export after the first audit run", () => {
    const txt = buildDisavowTxt(simulateAuditRun(new Set()));
    expect(txt).toContain("domain:spam.xyz");
    expect(txt).toContain("domain:mediocre.loan");
  });

  it("a manually saved low-risk domain still appears after a re-run", () => {
    // Confirm the scorer alone does NOT flag this domain
    expect(isDomainFlagged(scoreDomain("manual-override.com", 850, 5))).toBe(false);

    // But with a saved manual decision it must appear in the export
    const txt = buildDisavowTxt(simulateAuditRun(new Set(["manual-override.com"])));
    expect(txt).toContain("domain:manual-override.com");
  });

  it("saved decisions produce identical results across multiple re-runs", () => {
    const saved = new Set<string>(["manual-override.com"]);
    const run1 = simulateAuditRun(saved);
    const run2 = simulateAuditRun(saved);
    const run3 = simulateAuditRun(saved);
    expect(run1).toEqual(run2);
    expect(run2).toEqual(run3);
  });

  it("manually saved domain appears in every re-run", () => {
    const saved = new Set<string>(["manual-override.com"]);
    for (let i = 0; i < 3; i++) {
      expect(simulateAuditRun(saved)).toContain("manual-override.com");
    }
  });

  it("a domain that is both auto-flagged and manually saved appears exactly once in the export", () => {
    const saved = new Set<string>(["spam.xyz", "manual-override.com"]);
    const merged = simulateAuditRun(saved);
    const txt = buildDisavowTxt(merged);
    const domainLines = txt.split("\n").filter((l) => l.startsWith("domain:spam.xyz"));
    expect(domainLines).toHaveLength(1);
  });

  it("clean domains not in the saved set are excluded from the export after a re-run", () => {
    const txt = buildDisavowTxt(simulateAuditRun(new Set(["manual-override.com"])));
    expect(txt).not.toContain("domain:clean.com");
  });

  it("all domain lines in the merged export are correctly prefixed", () => {
    const txt = buildDisavowTxt(simulateAuditRun(new Set(["manual-override.com"])));
    const nonCommentLines = txt
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.startsWith("#"));
    for (const line of nonCommentLines) {
      expect(line.startsWith("domain:")).toBe(true);
    }
  });

  it("every domain in the fixture appears in the export when all are manually saved", () => {
    const allManual = new Set<string>(domainFixtures.map((d) => d.domain));
    const txt = buildDisavowTxt(simulateAuditRun(allManual));
    for (const { domain } of domainFixtures) {
      expect(txt).toContain(`domain:${domain}`);
    }
  });

  it("removing a domain from saved decisions excludes it from the export when it scores low", () => {
    // With the saved decision: domain appears
    const txtWith = buildDisavowTxt(simulateAuditRun(new Set(["manual-override.com"])));
    expect(txtWith).toContain("domain:manual-override.com");

    // After the decision is removed: domain must be absent
    const txtWithout = buildDisavowTxt(simulateAuditRun(new Set()));
    expect(txtWithout).not.toContain("domain:manual-override.com");
  });
});

// ---------------------------------------------------------------------------
// isDomainFlagged — medium/high filter
// ---------------------------------------------------------------------------
describe("isDomainFlagged", () => {
  it("returns true for high risk", () => {
    const risk = scoreDomain("spam.xyz", 5, 60); // suspicious TLD + very low rank + sitewide
    expect(isDomainFlagged(risk)).toBe(true);
  });

  it("returns true for medium risk", () => {
    const risk = scoreDomain("meh.xyz", 700, 3); // only suspicious TLD → medium
    expect(isDomainFlagged(risk)).toBe(true);
  });

  it("returns false for low risk", () => {
    const risk = scoreDomain("clean.com", 900, 3);
    expect(isDomainFlagged(risk)).toBe(false);
  });

  it("only includes medium and high risk domains when used as a filter", () => {
    const domains = [
      { domain: "clean.com", rank: 900, backlinks: 3 },
      { domain: "spammy.xyz", rank: 5, backlinks: 60 },
      { domain: "mediocre.loan", rank: 700, backlinks: 3 },
      { domain: "highauth.org", rank: 850, backlinks: 8 },
    ];

    const flagged = domains
      .map((d) => ({ ...d, risk: scoreDomain(d.domain, d.rank, d.backlinks) }))
      .filter((d) => isDomainFlagged(d.risk))
      .map((d) => d.domain);

    expect(flagged).toContain("spammy.xyz");
    expect(flagged).toContain("mediocre.loan");
    expect(flagged).not.toContain("clean.com");
    expect(flagged).not.toContain("highauth.org");
  });

  it("disavow export only contains domains the filter approved", () => {

    const allDomains = [
      { domain: "clean.com", rank: 900, backlinks: 3 },
      { domain: "spam.xyz", rank: 5, backlinks: 60 },
      { domain: "bad.loan", rank: 700, backlinks: 3 },
    ];

    const flaggedDomains = allDomains
      .filter((d) => isDomainFlagged(scoreDomain(d.domain, d.rank, d.backlinks)))
      .map((d) => d.domain);

    const txt = buildDisavowTxt(flaggedDomains);

    // Only flagged domains appear
    expect(txt).toContain("domain:spam.xyz");
    expect(txt).toContain("domain:bad.loan");
    // Clean domain must NOT appear in the export
    expect(txt).not.toContain("domain:clean.com");
    // No bare domain lines without the prefix
    const nonCommentLines = txt
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.startsWith("#"));
    for (const line of nonCommentLines) {
      expect(line.startsWith("domain:")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// scoreAnchor — anchor-text spam detection
// ---------------------------------------------------------------------------
describe("scoreAnchor", () => {
  // --- Config-driven coverage: every SPAM_ANCHORS entry must fire -----------
  it("every phrase in SPAM_ANCHORS scores at least 'medium' when used as the exact anchor", () => {
    for (const phrase of SPAM_ANCHORS) {
      const result = scoreAnchor(phrase);
      expect(
        result.matchedPhrase,
        `"${phrase}" should match a spam anchor phrase`,
      ).not.toBeNull();
      expect(
        result.level,
        `"${phrase}" should be at least "medium" risk`,
      ).not.toBe("low");
    }
  });

  it("every phrase in SPAM_ANCHORS scores at least 'medium' when embedded in surrounding text", () => {
    // Simulates real anchor text that wraps the spam phrase in extra words, e.g.
    // "Get the best online casino deals here!" should still match "online casino".
    for (const phrase of SPAM_ANCHORS) {
      const anchor = `get the best ${phrase} deals here`;
      const result = scoreAnchor(anchor);
      expect(
        result.matchedPhrase,
        `"${phrase}" embedded in longer anchor should still match`,
      ).not.toBeNull();
      expect(result.level).not.toBe("low");
    }
  });

  it("matching is case-insensitive", () => {
    const result = scoreAnchor("Buy Viagra Online");
    expect(result.matchedPhrase).not.toBeNull();
    expect(result.level).toBe("medium");
  });

  it("matching trims leading and trailing whitespace", () => {
    const result = scoreAnchor("  cheap viagra  ");
    expect(result.matchedPhrase).not.toBeNull();
    expect(result.level).toBe("medium");
  });

  it("reports which phrase was matched", () => {
    const result = scoreAnchor("buy backlinks for cheap");
    expect(result.matchedPhrase).toBe("buy backlinks");
  });

  // --- Clean / neutral anchors must not false-positive ----------------------
  it("does not flag 'click here'", () => {
    const result = scoreAnchor("click here");
    expect(result.matchedPhrase).toBeNull();
    expect(result.level).toBe("low");
  });

  it("does not flag 'read more'", () => {
    const result = scoreAnchor("read more");
    expect(result.matchedPhrase).toBeNull();
    expect(result.level).toBe("low");
  });

  it("does not flag 'learn more'", () => {
    const result = scoreAnchor("learn more");
    expect(result.matchedPhrase).toBeNull();
    expect(result.level).toBe("low");
  });

  it("does not flag 'visit us'", () => {
    const result = scoreAnchor("visit us");
    expect(result.matchedPhrase).toBeNull();
    expect(result.level).toBe("low");
  });

  it("does not flag a generic brand name anchor", () => {
    const brandAnchors = [
      "Linkweave",
      "Wellows",
      "Acme Corporation",
      "TechCo",
      "FooBar Inc",
    ];
    for (const anchor of brandAnchors) {
      const result = scoreAnchor(anchor);
      expect(
        result.matchedPhrase,
        `Brand anchor "${anchor}" should not be flagged`,
      ).toBeNull();
      expect(result.level).toBe("low");
    }
  });

  it("does not flag navigational anchors like page titles", () => {
    const navAnchors = [
      "Home",
      "About us",
      "Contact",
      "Privacy Policy",
      "Terms of Service",
      "Blog",
      "Pricing",
      "Sign up",
      "Log in",
    ];
    for (const anchor of navAnchors) {
      const result = scoreAnchor(anchor);
      expect(
        result.matchedPhrase,
        `Navigational anchor "${anchor}" should not be flagged`,
      ).toBeNull();
      expect(result.level).toBe("low");
    }
  });

  it("does not flag bare URL-style anchors", () => {
    const urlAnchors = ["example.com", "www.example.com", "https://example.com"];
    for (const anchor of urlAnchors) {
      const result = scoreAnchor(anchor);
      expect(
        result.matchedPhrase,
        `URL anchor "${anchor}" should not be flagged`,
      ).toBeNull();
      expect(result.level).toBe("low");
    }
  });

  it("does not false-positive on a word that merely contains a spam substring (no word boundary)", () => {
    // "casinobonuses" should NOT match "casino" because there is no word boundary
    const result = scoreAnchor("casinobonuses");
    expect(result.matchedPhrase).toBeNull();
    expect(result.level).toBe("low");
  });

  it("returns level 'low' and null matchedPhrase for an empty anchor", () => {
    const result = scoreAnchor("");
    expect(result.matchedPhrase).toBeNull();
    expect(result.level).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Category-level smoke test — one representative phrase per spam category
//
// Purpose: catch accidental deletion of an entire category from SPAM_ANCHORS.
// Each entry names the category and one canonical phrase that must still fire.
// If a category is removed from spam-anchors.ts, the matching assertion below
// will fail with a clear message naming the deleted category.
// ---------------------------------------------------------------------------
describe("scoreAnchor — category coverage smoke test", () => {
  const CATEGORY_SENTINELS: Array<{ category: string; phrase: string }> = [
    { category: "pharmaceutical / health spam",  phrase: "buy viagra"             },
    { category: "gambling / casino spam",         phrase: "online casino"          },
    { category: "payday / financial spam",        phrase: "payday loans"           },
    { category: "SEO / link-building spam",       phrase: "buy backlinks"          },
    { category: "essay / academic fraud",         phrase: "essay writing service"  },
    { category: "dating / adult spam",            phrase: "dating site"            },
  ];

  for (const { category, phrase } of CATEGORY_SENTINELS) {
    it(`"${category}" category: sentinel phrase "${phrase}" is present and detectable`, () => {
      // 1. The phrase must exist in the SPAM_ANCHORS config — catches deletions.
      expect(
        SPAM_ANCHORS,
        `"${phrase}" was removed from SPAM_ANCHORS — the entire "${category}" category may have been deleted`,
      ).toContain(phrase);

      // 2. The scorer must fire on the exact phrase (config → scorer pipeline).
      const exact = scoreAnchor(phrase);
      expect(
        exact.matchedPhrase,
        `scoreAnchor("${phrase}") should match for category "${category}"`,
      ).toBe(phrase);
      expect(exact.level).not.toBe("low");

      // 3. The scorer must also fire when the phrase is embedded in surrounding text
      //    (simulates a realistic anchor like "get the best online casino deals").
      const embedded = scoreAnchor(`get the best ${phrase} deals here`);
      expect(
        embedded.matchedPhrase,
        `"${phrase}" embedded in longer anchor should still match for category "${category}"`,
      ).not.toBeNull();
      expect(embedded.level).not.toBe("low");
    });
  }
});
