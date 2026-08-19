import { describe, expect, it, vi } from "vitest";
import type { SiteContext } from "../lib/site";
import { registerJob, runJob } from "./runner";

const TEST_SITE: SiteContext = {
  id: 987_654,
  ownerUserId: "test-scheduler-guard",
  domain: "scheduler-guard.example.com",
  host: "scheduler-guard.example.com",
  displayName: "Scheduler guard test",
  sitemapUrl: null,
  maxCrawlPages: 10,
  maxLlmCallsPerRun: 10,
  maxSerpQueriesPerRun: 10,
};

describe("scheduled integration-test site guard", () => {
  it("refuses the site before the job can run or record a claim", async () => {
    const job = vi.fn(async () => {});
    registerJob("migrate_url_hygiene", job);

    const result = await runJob("migrate_url_hygiene", TEST_SITE, {
      source: "scheduler",
    });

    expect(result).toEqual({
      started: false,
      reason: "Integration-test site",
    });
    expect(job).not.toHaveBeenCalled();
  });
});