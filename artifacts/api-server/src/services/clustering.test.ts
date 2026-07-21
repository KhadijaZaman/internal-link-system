import { describe, it, expect } from "vitest";
import { isOperatorQuery } from "./clustering";

describe("isOperatorQuery", () => {
  it("flags quoted-phrase queries (AI fan-out scrapes seen in GSC)", () => {
    expect(
      isOperatorQuery('"fintech" "founded in 2020" "backed by" "venture capital"'),
    ).toBe(true);
    expect(
      isOperatorQuery(
        '"bronixengineering.com" content topic clusters depth publishing velocity',
      ),
    ).toBe(true);
    expect(isOperatorQuery('"vc-backed fintech" "founded in 2020" co-founder')).toBe(
      true,
    );
    expect(
      isOperatorQuery('"generative engine visibility" tools or software or platform'),
    ).toBe(true);
    expect(isOperatorQuery("best \u201cai seo\u201d tools")).toBe(true); // curly quotes
  });

  it("flags parenthesized boolean queries", () => {
    expect(
      isOperatorQuery(
        "(fintech companies founded in 2020) and (uk) and (venture capital backed)",
      ),
    ).toBe(true);
    expect(isOperatorQuery("(seo tools) or (marketing software)")).toBe(true);
    expect(isOperatorQuery("(a)|(b)")).toBe(true);
  });

  it("flags search-operator prefixes", () => {
    expect(isOperatorQuery("site:example.com seo")).toBe(true);
    expect(isOperatorQuery("seo tips inurl:blog")).toBe(true);
    expect(isOperatorQuery("intitle:seo checklist")).toBe(true);
    expect(isOperatorQuery("allintitle:ai visibility")).toBe(true);
    expect(isOperatorQuery("filetype:pdf seo guide")).toBe(true);
    expect(isOperatorQuery("-site:reddit.com ai tools")).toBe(true);
  });

  it("keeps legitimate human queries containing and/or", () => {
    expect(isOperatorQuery("pros and cons of ai content")).toBe(false);
    expect(isOperatorQuery("bed and breakfast seo")).toBe(false);
    expect(isOperatorQuery("seo or sem which is better")).toBe(false);
    expect(isOperatorQuery("black and white logo design")).toBe(false);
  });

  it("keeps normal queries, including apostrophes and colons in times", () => {
    expect(isOperatorQuery("startup business ideas 2026")).toBe(false);
    expect(isOperatorQuery("what's the best ai seo tool")).toBe(false);
    expect(isOperatorQuery("how to rank in chatgpt")).toBe(false);
    expect(isOperatorQuery("query fan out")).toBe(false);
    expect(isOperatorQuery("seo checklist (2026)")).toBe(false);
  });
});
