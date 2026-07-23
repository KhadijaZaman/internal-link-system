/**
 * Per-run spend guardrails for background jobs.
 *
 * Each spend-bearing job constructs one JobBudget per run from the site's
 * configured limits and calls `take()` before every unit of paid work
 * (LLM/embedding call, DataForSEO SERP task, crawled page). When a budget is
 * exhausted the job stops that class of work gracefully — partial progress is
 * normal for these drain-style jobs — and the exhaustion is logged via
 * `summary()` so the operator can see a cap was hit.
 */

import { registerBudget } from "./budgetContext";

export type BudgetKind = "llmCalls" | "serpQueries" | "crawlPages";

export interface BudgetLimits {
  llmCalls: number;
  serpQueries: number;
  crawlPages: number;
}

export interface SiteLimitsSource {
  maxLlmCallsPerRun: number;
  maxSerpQueriesPerRun: number;
  maxCrawlPages: number;
}

export class JobBudget {
  private used: Record<BudgetKind, number> = {
    llmCalls: 0,
    serpQueries: 0,
    crawlPages: 0,
  };
  private hitCap: Partial<Record<BudgetKind, boolean>> = {};

  constructor(readonly limits: BudgetLimits) {}

  /**
   * Try to consume `n` units of `kind`. Returns true when the units fit
   * within the remaining budget (and records them); false when the cap
   * would be exceeded (consumes nothing).
   */
  take(kind: BudgetKind, n = 1): boolean {
    if (n <= 0) return true;
    const limit = this.limits[kind];
    if (this.used[kind] + n > limit) {
      this.hitCap[kind] = true;
      return false;
    }
    this.used[kind] += n;
    return true;
  }

  /** Remaining units for `kind` (never negative). */
  remaining(kind: BudgetKind): number {
    return Math.max(0, this.limits[kind] - this.used[kind]);
  }

  /** True if any take() for `kind` has ever been refused. */
  exhausted(kind: BudgetKind): boolean {
    return this.hitCap[kind] === true;
  }

  /** True if any budget kind was ever refused. */
  anyExhausted(): boolean {
    return Object.values(this.hitCap).some(Boolean);
  }

  usedCount(kind: BudgetKind): number {
    return this.used[kind];
  }

  /** Human-readable usage summary for logs. */
  summary(): string {
    return (Object.keys(this.used) as BudgetKind[])
      .map(
        (k) =>
          `${k}=${this.used[k]}/${this.limits[k]}${this.hitCap[k] ? " (cap hit)" : ""}`,
      )
      .join(", ");
  }
}

/** Structured per-kind usage snapshot, persisted on job_runs when a cap is hit. */
export interface BudgetUsageReport {
  capped: boolean;
  kinds: Array<{ kind: BudgetKind; used: number; limit: number; capHit: boolean }>;
}

export function usageReport(budgets: JobBudget[]): BudgetUsageReport | null {
  if (budgets.length === 0) return null;
  const kinds = (["llmCalls", "serpQueries", "crawlPages"] as BudgetKind[]).map(
    (kind) => ({
      kind,
      used: budgets.reduce((s, b) => s + b.usedCount(kind), 0),
      limit: budgets.reduce((s, b) => s + b.limits[kind], 0),
      capHit: budgets.some((b) => b.exhausted(kind)),
    }),
  );
  return { capped: kinds.some((k) => k.capHit), kinds };
}

export function budgetForSite(site: SiteLimitsSource): JobBudget {
  const budget = new JobBudget({
    llmCalls: site.maxLlmCallsPerRun,
    serpQueries: site.maxSerpQueriesPerRun,
    crawlPages: site.maxCrawlPages,
  });
  registerBudget(budget);
  return budget;
}
