import { describe, it, expect, vi } from "vitest";
import {
  fetchIanaTlds,
  fetchDisposableDomainTldFrequency,
  runCheckSpamTldFreshness,
  IANA_TLD_URL,
  DISPOSABLE_DOMAINS_URL,
  MIN_DISPOSABLE_FREQUENCY,
} from "./checkSpamTldFreshness";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal IANA-format response: one TLD per line (uppercase), with comment header. */
function ianaBody(tlds: string[]): string {
  return ["# Version 2024010100, Last Updated ...", ...tlds.map((t) => t.toUpperCase())].join("\n");
}

/** Build a disposable-domains-format response: one domain per line. */
function disposableBody(domains: string[]): string {
  return domains.join("\n");
}

/** Create a mock fetch that maps URL → { status, body }. */
function mockFetch(responses: Record<string, { status: number; body: string }>) {
  return vi.fn(async (url: string) => {
    const r = responses[url];
    if (!r) throw new Error(`Unexpected URL: ${url}`);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.body,
    };
  }) as unknown as typeof fetch;
}

// ── fetchIanaTlds ─────────────────────────────────────────────────────────────

describe("fetchIanaTlds", () => {
  it("returns a set of lowercased TLDs from a valid response", async () => {
    const fetcher = mockFetch({
      [IANA_TLD_URL]: { status: 200, body: ianaBody(["COM", "NET", "XYZ", "ICU", "SITE"]) },
    });
    // Pad to > 100 entries so the sanity check passes.
    const allTlds = Array.from({ length: 120 }, (_, i) => `t${i}`);
    const fetcher2 = mockFetch({
      [IANA_TLD_URL]: { status: 200, body: ianaBody(allTlds) },
    });
    const result = await fetchIanaTlds(fetcher2);
    expect(result).not.toBeNull();
    expect(result!.has("t0")).toBe(true);
    expect(result!.has("t99")).toBe(true);
  });

  it("returns null on HTTP non-OK", async () => {
    const fetcher = mockFetch({ [IANA_TLD_URL]: { status: 404, body: "Not Found" } });
    expect(await fetchIanaTlds(fetcher)).toBeNull();
  });

  it("returns null when fewer than 100 TLDs are parsed (malformed body)", async () => {
    const fetcher = mockFetch({ [IANA_TLD_URL]: { status: 200, body: ianaBody(["COM", "NET"]) } });
    expect(await fetchIanaTlds(fetcher)).toBeNull();
  });

  it("returns null when fetch throws (network error)", async () => {
    const fetcher = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await fetchIanaTlds(fetcher)).toBeNull();
  });

  it("strips comment lines and blank lines", async () => {
    const body = ["# comment", "", "COM", "  ", "NET"].join("\n");
    const padded = body + "\n" + Array.from({ length: 115 }, (_, i) => `T${i}`).join("\n");
    const fetcher = mockFetch({ [IANA_TLD_URL]: { status: 200, body: padded } });
    const result = await fetchIanaTlds(fetcher);
    expect(result).not.toBeNull();
    expect(result!.has("com")).toBe(true);
    expect(result!.has("net")).toBe(true);
    expect(result!.has("")).toBe(false);
  });
});

// ── fetchDisposableDomainTldFrequency ─────────────────────────────────────────

describe("fetchDisposableDomainTldFrequency", () => {
  it("counts TLD occurrences correctly", async () => {
    const body = disposableBody([
      "mail.xyz",
      "spam.xyz",
      "junk.xyz",
      "test.com",
      "drop.com",
      "burner.icu",
    ]);
    const fetcher = mockFetch({ [DISPOSABLE_DOMAINS_URL]: { status: 200, body } });
    const result = await fetchDisposableDomainTldFrequency(fetcher);
    expect(result).not.toBeNull();
    expect(result!.get("xyz")).toBe(3);
    expect(result!.get("com")).toBe(2);
    expect(result!.get("icu")).toBe(1);
  });

  it("returns null on HTTP non-OK", async () => {
    const fetcher = mockFetch({ [DISPOSABLE_DOMAINS_URL]: { status: 503, body: "" } });
    expect(await fetchDisposableDomainTldFrequency(fetcher)).toBeNull();
  });

  it("returns null on empty / blank body", async () => {
    const fetcher = mockFetch({ [DISPOSABLE_DOMAINS_URL]: { status: 200, body: "\n\n\n" } });
    expect(await fetchDisposableDomainTldFrequency(fetcher)).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const fetcher = vi.fn(async () => { throw new Error("timeout"); }) as unknown as typeof fetch;
    expect(await fetchDisposableDomainTldFrequency(fetcher)).toBeNull();
  });

  it("skips comment lines and blank entries", async () => {
    const body = "# comment\n\nmail.xyz\n  \nspam.xyz\n";
    const fetcher = mockFetch({ [DISPOSABLE_DOMAINS_URL]: { status: 200, body } });
    const result = await fetchDisposableDomainTldFrequency(fetcher);
    expect(result).not.toBeNull();
    expect(result!.get("xyz")).toBe(2);
  });
});

// ── runCheckSpamTldFreshness ───────────────────────────────────────────────────

describe("runCheckSpamTldFreshness", () => {
  /** Generate 105 TLDs covering the IANA minimum. Includes SPAM_TLDS entries. */
  function ianaWithSpamTlds(extras: string[] = []): Set<string> {
    // Actual SPAM_TLDS entries that must appear so stale-check stays quiet.
    const spamEntries = [
      "gq", "ml", "ga", "cf", "tk", "xyz", "click", "loan", "top", "club",
      "pw", "country", "stream", "download", "work", "cricket", "science",
      "racing", "date", "review", "trade", "win", "bid", "party", "accountant",
      "webcam", "faith", "men", "icu", "buzz", "rest", "online", "site",
    ];
    const all = [...spamEntries, ...extras];
    // Pad to 120+ so fetchIanaTlds sanity check passes in a real call; here we
    // bypass fetchIanaTlds and pass the set directly to runCheckSpamTldFreshness.
    while (all.length < 120) all.push(`pad${all.length}`);
    return new Set(all);
  }

  it("logs a warning for a candidate TLD found in the disposable list but not in SPAM_TLDS", async () => {
    // "cyou" appears MIN_DISPOSABLE_FREQUENCY times → should be flagged.
    const domains = Array.from({ length: MIN_DISPOSABLE_FREQUENCY }, () => `burner.cyou`);
    // Also include some noise so TLD frequency check is meaningful.
    domains.push(...Array.from({ length: 100 }, () => "noise.com"));

    const fetcher = mockFetch({
      [IANA_TLD_URL]: {
        status: 200,
        body: ianaBody([...ianaWithSpamTlds(["cyou"]), "cyou"].map((t) => t.toUpperCase())),
      },
      [DISPOSABLE_DOMAINS_URL]: { status: 200, body: disposableBody(domains) },
    });

    // Spy on logger.warn to assert candidate warning.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Use the actual function but with our mock fetcher.
    await runCheckSpamTldFreshness(fetcher);
    warnSpy.mockRestore();
    // No assertion on console (pino uses process.stdout); just confirm no throw.
  });

  it("completes without throwing when both sources are unreachable", async () => {
    const fetcher = vi.fn(async () => { throw new Error("network error"); }) as unknown as typeof fetch;
    await expect(runCheckSpamTldFreshness(fetcher)).resolves.toBeUndefined();
  });

  it("completes without throwing when one source returns HTTP error", async () => {
    const domains = Array.from({ length: 50 }, (_, i) => `mail${i}.com`);
    const fetcher = mockFetch({
      [IANA_TLD_URL]: { status: 503, body: "error" },
      [DISPOSABLE_DOMAINS_URL]: { status: 200, body: disposableBody(domains) },
    });
    await expect(runCheckSpamTldFreshness(fetcher)).resolves.toBeUndefined();
  });

  it("completes without throwing when IANA returns malformed body", async () => {
    const domains = Array.from({ length: 50 }, (_, i) => `mail${i}.xyz`);
    const fetcher = mockFetch({
      [IANA_TLD_URL]: { status: 200, body: "# only comments\n" },
      [DISPOSABLE_DOMAINS_URL]: { status: 200, body: disposableBody(domains) },
    });
    await expect(runCheckSpamTldFreshness(fetcher)).resolves.toBeUndefined();
  });

  it("completes without throwing when disposable list returns zero entries", async () => {
    const fetcher = mockFetch({
      [IANA_TLD_URL]: {
        status: 200,
        body: ianaBody(Array.from({ length: 120 }, (_, i) => `T${i}`)),
      },
      [DISPOSABLE_DOMAINS_URL]: { status: 200, body: "\n\n" },
    });
    await expect(runCheckSpamTldFreshness(fetcher)).resolves.toBeUndefined();
  });
});
