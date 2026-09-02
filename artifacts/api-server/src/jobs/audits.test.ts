import { describe, expect, it } from "vitest";
import { isSamePageTrailingSlashRedirect } from "./audits";

describe("isSamePageTrailingSlashRedirect", () => {
  it.each([301, 308])("classifies a %s trailing-slash canonical redirect", (status) => {
    expect(
      isSamePageTrailingSlashRedirect(
        "https://example.com/about",
        status,
        "https://example.com/about/",
      ),
    ).toBe(true);
  });

  it("supports a relative Location header", () => {
    expect(
      isSamePageTrailingSlashRedirect("https://example.com/about", 301, "/about/"),
    ).toBe(true);
  });

  it.each([
    ["a different page", "https://example.com/about", 301, "https://example.com/contact"],
    ["a different host", "https://example.com/about", 301, "https://www.example.com/about/"],
    ["a query change", "https://example.com/about?x=1", 301, "/about/?x=2"],
    ["a temporary redirect", "https://example.com/about", 302, "/about/"],
    ["a failure", "https://example.com/about", 404, undefined],
  ])("does not classify %s as canonical", (_name, source, status, destination) => {
    expect(isSamePageTrailingSlashRedirect(source, status, destination)).toBe(false);
  });
});