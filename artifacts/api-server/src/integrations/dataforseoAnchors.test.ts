import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for fetchBacklinkAnchors in dataforseo.ts.
 *
 * Key regression being guarded: the old filter `typeof i.anchor === "string"`
 * silently dropped null-anchor items (links with no anchor text), which are
 * often the largest bucket in a site's anchor profile. The corrected filter
 * `i.anchor !== undefined` keeps null anchors and maps them to "".
 */

// ---------------------------------------------------------------------------
// Helpers: build a DataForSEO-shaped anchors response
// ---------------------------------------------------------------------------

function makeDfsAnchorsResponse(
  items: Array<{
    anchor?: string | null;
    backlinks?: number;
    referring_domains?: number;
    referring_links_attributes?: Record<string, number>;
  }>,
) {
  return {
    status_code: 20000,
    tasks: [
      {
        status_code: 20000,
        status_message: "Ok.",
        result: [{ items }],
      },
    ],
  };
}

function mockFetch(json: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(json),
  });
}

// Set credentials so the function doesn't short-circuit with an empty array.
beforeEach(() => {
  process.env["DATAFORSEO_LOGIN"] = "test-login";
  process.env["DATAFORSEO_PASSWORD"] = "test-pass";
});

describe("fetchBacklinkAnchors — anchor inclusion", () => {
  it("includes items with anchor: null (no-anchor-text bucket)", async () => {
    global.fetch = mockFetch(
      makeDfsAnchorsResponse([
        { anchor: null, backlinks: 12548, referring_domains: 800 },
        { anchor: "Wellows", backlinks: 3110, referring_domains: 420 },
      ]),
    );

    const { fetchBacklinkAnchors } = await import("./dataforseo");
    const result = await fetchBacklinkAnchors("wellows.com", 30);

    // The null-anchor bucket must appear, mapped to anchor: "".
    const nullBucket = result.find((a) => a.anchor === "");
    expect(nullBucket).toBeDefined();
    expect(nullBucket!.backlinks).toBe(12548);
    expect(nullBucket!.referringDomains).toBe(800);
  });

  it("excludes items where the anchor field is missing (undefined) from the response", async () => {
    // An item with no `anchor` key at all (distinct from anchor: null).
    global.fetch = mockFetch(
      makeDfsAnchorsResponse([
        { backlinks: 999, referring_domains: 10 }, // anchor field absent
        { anchor: "brand", backlinks: 500, referring_domains: 50 },
      ]),
    );

    const { fetchBacklinkAnchors } = await import("./dataforseo");
    const result = await fetchBacklinkAnchors("wellows.com", 30);

    // Only the item with the explicit anchor survives.
    expect(result).toHaveLength(1);
    expect(result[0]!.anchor).toBe("brand");
  });

  it("includes items with anchor: '' (empty string)", async () => {
    global.fetch = mockFetch(
      makeDfsAnchorsResponse([{ anchor: "", backlinks: 200, referring_domains: 15 }]),
    );

    const { fetchBacklinkAnchors } = await import("./dataforseo");
    const result = await fetchBacklinkAnchors("wellows.com", 30);

    expect(result).toHaveLength(1);
    expect(result[0]!.anchor).toBe("");
  });

  it("computes dofollow correctly for null-anchor items", async () => {
    global.fetch = mockFetch(
      makeDfsAnchorsResponse([
        {
          anchor: null,
          backlinks: 100,
          referring_domains: 40,
          referring_links_attributes: { nofollow: 30 },
        },
      ]),
    );

    const { fetchBacklinkAnchors } = await import("./dataforseo");
    const result = await fetchBacklinkAnchors("wellows.com", 30);

    expect(result).toHaveLength(1);
    expect(result[0]!.dofollow).toBe(70); // 100 - 30
    expect(result[0]!.nofollow).toBe(30);
  });

  it("returns all three anchor types (null, empty, text) when present together", async () => {
    global.fetch = mockFetch(
      makeDfsAnchorsResponse([
        { anchor: null, backlinks: 5000 },
        { anchor: "", backlinks: 100 },
        { anchor: "click here", backlinks: 50 },
        { backlinks: 999 }, // no anchor field — should be excluded
      ]),
    );

    const { fetchBacklinkAnchors } = await import("./dataforseo");
    const result = await fetchBacklinkAnchors("wellows.com", 30);

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.anchor)).toEqual(["", "", "click here"]);
    expect(result.map((r) => r.backlinks)).toEqual([5000, 100, 50]);
  });
});
