import { describe, expect, it } from "vitest";
import { routeSeoQuestion } from "./gscQuestionRouter";

describe("routeSeoQuestion", () => {
  it("does not conflate Copilot citations with Bing Webmaster or GA4 AI referrals", () => {
    const route = routeSeoQuestion("Which pages gained Copilot citations?", []);
    expect(route.capabilities).toContain("copilot-citations");
    expect(route.directAnswer).toContain("separate datasets");
    expect(route.directAnswer).toContain("not present");
  });

  it("routes a standalone Copilot question to the missing citation capability", () => {
    const route = routeSeoQuestion("How are we doing on Copilot?", []);
    expect(route.capabilities).toContain("copilot-citations");
    expect(route.directAnswer).toContain("not present");
  });

  it("requires confirmation instead of starting paid scans", () => {
    const route = routeSeoQuestion("Run a competitor DataForSEO scan for the UK", []);
    expect(route.capabilities).toContain("paid-scan");
    expect(route.directAnswer).toContain("explicit confirmation");
  });

  it("rejects pretending all-country evidence is market-filtered", () => {
    const route = routeSeoQuestion("How did clicks change in Canada?", []);
    expect(route.capabilities).toContain("market-filter");
    expect(route.directAnswer).toContain("all available countries");
  });
});