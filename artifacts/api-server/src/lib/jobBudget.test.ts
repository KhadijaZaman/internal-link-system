import { describe, it, expect } from "vitest";
import { JobBudget, budgetForSite, usageReport } from "./jobBudget";
import { runWithBudgetCapture } from "./budgetContext";

describe("JobBudget", () => {
  it("allows takes within the limit and tracks usage", () => {
    const b = new JobBudget({ llmCalls: 3, serpQueries: 1, crawlPages: 10 });
    expect(b.take("llmCalls")).toBe(true);
    expect(b.take("llmCalls", 2)).toBe(true);
    expect(b.usedCount("llmCalls")).toBe(3);
    expect(b.remaining("llmCalls")).toBe(0);
    expect(b.exhausted("llmCalls")).toBe(false);
  });

  it("refuses takes that exceed the cap without consuming anything", () => {
    const b = new JobBudget({ llmCalls: 2, serpQueries: 5, crawlPages: 5 });
    expect(b.take("llmCalls", 2)).toBe(true);
    expect(b.take("llmCalls")).toBe(false);
    expect(b.usedCount("llmCalls")).toBe(2);
    expect(b.exhausted("llmCalls")).toBe(true);
    expect(b.anyExhausted()).toBe(true);
  });

  it("refuses an oversized batch even with partial room left", () => {
    const b = new JobBudget({ llmCalls: 10, serpQueries: 3, crawlPages: 5 });
    expect(b.take("serpQueries", 2)).toBe(true);
    expect(b.take("serpQueries", 2)).toBe(false);
    expect(b.usedCount("serpQueries")).toBe(2);
    expect(b.remaining("serpQueries")).toBe(1);
  });

  it("treats non-positive takes as free no-ops", () => {
    const b = new JobBudget({ llmCalls: 1, serpQueries: 1, crawlPages: 1 });
    expect(b.take("crawlPages", 0)).toBe(true);
    expect(b.usedCount("crawlPages")).toBe(0);
  });

  it("keeps budget kinds independent", () => {
    const b = new JobBudget({ llmCalls: 1, serpQueries: 1, crawlPages: 1 });
    expect(b.take("llmCalls")).toBe(true);
    expect(b.take("llmCalls")).toBe(false);
    expect(b.take("serpQueries")).toBe(true);
    expect(b.exhausted("serpQueries")).toBe(false);
  });

  it("builds from site limit columns", () => {
    const b = budgetForSite({
      maxLlmCallsPerRun: 7,
      maxSerpQueriesPerRun: 8,
      maxCrawlPages: 9,
    });
    expect(b.limits).toEqual({ llmCalls: 7, serpQueries: 8, crawlPages: 9 });
  });

  it("summary marks cap hits", () => {
    const b = new JobBudget({ llmCalls: 1, serpQueries: 1, crawlPages: 1 });
    b.take("llmCalls");
    b.take("llmCalls");
    expect(b.summary()).toContain("llmCalls=1/1 (cap hit)");
  });
});

describe("usageReport", () => {
  it("returns null when no budgets were created", () => {
    expect(usageReport([])).toBeNull();
  });

  it("aggregates usage across budgets and flags cap hits", () => {
    const a = new JobBudget({ llmCalls: 2, serpQueries: 5, crawlPages: 5 });
    a.take("llmCalls", 2);
    a.take("llmCalls"); // refused → cap hit
    const b = new JobBudget({ llmCalls: 3, serpQueries: 5, crawlPages: 5 });
    b.take("llmCalls");
    b.take("crawlPages", 4);
    const report = usageReport([a, b])!;
    expect(report.capped).toBe(true);
    const llm = report.kinds.find((k) => k.kind === "llmCalls")!;
    expect(llm).toEqual({ kind: "llmCalls", used: 3, limit: 5, capHit: true });
    const crawl = report.kinds.find((k) => k.kind === "crawlPages")!;
    expect(crawl.capHit).toBe(false);
    expect(crawl.used).toBe(4);
  });

  it("reports capped=false when everything fit in budget", () => {
    const b = new JobBudget({ llmCalls: 5, serpQueries: 5, crawlPages: 5 });
    b.take("llmCalls", 3);
    expect(usageReport([b])!.capped).toBe(false);
  });
});

describe("budget capture context", () => {
  it("captures budgets created via budgetForSite inside a run", async () => {
    const { budgets, result } = runWithBudgetCapture(async () => {
      const b = budgetForSite({
        maxLlmCallsPerRun: 1,
        maxSerpQueriesPerRun: 1,
        maxCrawlPages: 1,
      });
      b.take("llmCalls");
      b.take("llmCalls");
    });
    await result;
    expect(budgets).toHaveLength(1);
    expect(budgets[0]!.exhausted("llmCalls")).toBe(true);
  });

  it("captures budgets even when the job throws", async () => {
    const { budgets, result } = runWithBudgetCapture(async () => {
      budgetForSite({ maxLlmCallsPerRun: 1, maxSerpQueriesPerRun: 1, maxCrawlPages: 1 });
      throw new Error("boom");
    });
    await expect(result).rejects.toThrow("boom");
    expect(budgets).toHaveLength(1);
  });

  it("is a no-op outside a captured run", () => {
    const b = budgetForSite({
      maxLlmCallsPerRun: 1,
      maxSerpQueriesPerRun: 1,
      maxCrawlPages: 1,
    });
    expect(b.take("llmCalls")).toBe(true);
  });
});
