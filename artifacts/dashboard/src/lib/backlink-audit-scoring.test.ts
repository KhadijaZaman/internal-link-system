import { describe, it, expect } from "vitest";
import {
  buildDomainAnchors,
  buildScoredCandidates,
  isDomainFlagged,
} from "./backlink-audit-scoring";
import type { AuditReferringDomain, TopBacklink } from "@workspace/api-client-react";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeBl(
  domainFrom: string,
  anchor: string | null,
  domainFromRank: number | null,
): TopBacklink {
  return {
    urlFrom: `https://${domainFrom}/link`,
    urlTo: "https://target.com/",
    domainFrom,
    pageFromTitle: null,
    anchor,
    dofollow: true,
    rank: domainFromRank,
    domainFromRank,
    firstSeen: "2024-01-01",
    lastSeen: null,
  };
}

function makeRef(domain: string, rank: number | null, backlinks = 10): AuditReferringDomain {
  return { domain, backlinks, rank, firstSeen: null, lastSeen: null };
}

// ─── buildDomainAnchors ───────────────────────────────────────────────────────

describe("buildDomainAnchors", () => {
  it("maps domainFrom to anchor texts", () => {
    const map = buildDomainAnchors([makeBl("spam.xyz", "online casino", 5)]);
    expect(map.get("spam.xyz")).toEqual(["online casino"]);
  });

  it("accumulates multiple anchors for the same domain", () => {
    const bls: TopBacklink[] = [
      makeBl("spam.xyz", "online casino", 5),
      makeBl("spam.xyz", "best online casino", 5),
    ];
    expect(buildDomainAnchors(bls).get("spam.xyz")).toEqual([
      "online casino",
      "best online casino",
    ]);
  });

  it("normalises domain keys to lowercase", () => {
    const map = buildDomainAnchors([makeBl("Spam.XYZ", "online casino", 5)]);
    expect(map.get("spam.xyz")).toEqual(["online casino"]);
    expect(map.has("Spam.XYZ")).toBe(false);
  });

  it("skips entries with null anchor", () => {
    const map = buildDomainAnchors([makeBl("clean.com", null, 800)]);
    expect(map.has("clean.com")).toBe(false);
  });

  it("returns an empty map for an empty input", () => {
    expect(buildDomainAnchors([]).size).toBe(0);
  });
});

// ─── buildScoredCandidates — existing referringDomains are always scored ─────

describe("buildScoredCandidates — existing referringDomains", () => {
  it("scores all entries from referringDomains", () => {
    const refs = [makeRef("auth.com", 800), makeRef("low.net", 15)];
    const scored = buildScoredCandidates(refs, []);
    expect(scored).toHaveLength(2);
    expect(scored.map((s) => s.domain.domain)).toEqual(["auth.com", "low.net"]);
  });

  it("supplies per-domain anchor data from topBacklinks when scoring", () => {
    const refs = [makeRef("low.net", 15)];
    const bls = [makeBl("low.net", "online casino", 15)];
    const scored = buildScoredCandidates(refs, bls);
    expect(scored[0].risk.flags.some((f) => f.includes("Anchor spam"))).toBe(true);
  });

  it("does not flag a high-rank domain even with a spam anchor in topBacklinks", () => {
    const refs = [makeRef("auth.com", 800)];
    const bls = [makeBl("auth.com", "online casino", 800)];
    const scored = buildScoredCandidates(refs, bls);
    expect(scored[0].risk.flags.some((f) => f.includes("Anchor spam"))).toBe(false);
  });
});

// ─── buildScoredCandidates — low-rank backlink domains extend the list ────────

describe("buildScoredCandidates — low-rank extension", () => {
  it("includes a low-rank backlink domain absent from referringDomains", () => {
    const refs = [makeRef("auth.com", 800)];
    const bls = [makeBl("cheap-pills.xyz", "online casino", 5)];
    const scored = buildScoredCandidates(refs, bls);
    const extra = scored.find((s) => s.domain.domain === "cheap-pills.xyz");
    expect(extra).toBeDefined();
  });

  it("flags the extra low-rank domain with Anchor spam when it has a spam anchor", () => {
    const refs = [makeRef("auth.com", 800)];
    const bls = [makeBl("cheap-pills.xyz", "online casino", 5)];
    const scored = buildScoredCandidates(refs, bls);
    const extra = scored.find((s) => s.domain.domain === "cheap-pills.xyz")!;
    expect(extra.risk.flags.some((f) => f.includes("Anchor spam"))).toBe(true);
    expect(isDomainFlagged(extra.risk)).toBe(true);
  });

  it("extra candidate is included in the disavow candidate set when flagged", () => {
    const refs = [makeRef("auth.com", 800)];
    const bls = [makeBl("cheap-pills.xyz", "online casino", 3)];
    const scored = buildScoredCandidates(refs, bls);
    const flagged = scored.filter((s) => isDomainFlagged(s.risk));
    expect(flagged.map((s) => s.domain.domain)).toContain("cheap-pills.xyz");
  });

  it("does NOT include a high-rank backlink domain (rank >= 30) absent from referringDomains", () => {
    const refs = [makeRef("auth.com", 800)];
    const bls = [makeBl("good-site.com", "online casino", 500)];
    const scored = buildScoredCandidates(refs, bls);
    expect(scored.find((s) => s.domain.domain === "good-site.com")).toBeUndefined();
  });

  it("does NOT duplicate a domain already in referringDomains", () => {
    const refs = [makeRef("low.net", 15)];
    const bls = [makeBl("low.net", "online casino", 15)];
    const scored = buildScoredCandidates(refs, bls);
    expect(scored.filter((s) => s.domain.domain === "low.net")).toHaveLength(1);
  });

  it("handles an unranked (null domainFromRank) backlink domain as low-auth", () => {
    const refs = [makeRef("auth.com", 800)];
    const bls = [makeBl("unranked-spam.com", "online casino", null)];
    const scored = buildScoredCandidates(refs, bls);
    const extra = scored.find((s) => s.domain.domain === "unranked-spam.com");
    expect(extra).toBeDefined();
    expect(isDomainFlagged(extra!.risk)).toBe(true);
  });

  it("extra candidate domain key matching is case-insensitive", () => {
    const refs = [makeRef("Low.Net", 15)];
    // Same domain in topBacklinks with different case — should NOT produce extra
    const bls = [makeBl("low.net", "online casino", 15)];
    const scored = buildScoredCandidates(refs, bls);
    expect(scored.filter((s) => s.domain.domain.toLowerCase() === "low.net")).toHaveLength(1);
  });

  it("returns only the referringDomains list when topBacklinks is empty", () => {
    const refs = [makeRef("a.com", 100), makeRef("b.com", 50)];
    expect(buildScoredCandidates(refs, [])).toHaveLength(2);
  });
});
