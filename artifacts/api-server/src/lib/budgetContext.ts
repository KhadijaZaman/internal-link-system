/**
 * AsyncLocalStorage bridge between the job runner and JobBudget instances.
 *
 * The runner wraps each job execution in `runWithBudgetCapture()`; any
 * `budgetForSite()` call inside that async scope registers its JobBudget in
 * the captured list. When the job finishes, the runner reads the budgets to
 * persist a spend-cap usage report on job_runs — without every job having to
 * report its budget explicitly. A pipeline run that spawns several sub-jobs
 * simply captures all of their budgets.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { JobBudget } from "./jobBudget";

const store = new AsyncLocalStorage<JobBudget[]>();

export function runWithBudgetCapture<T>(fn: () => Promise<T>): {
  budgets: JobBudget[];
  result: Promise<T>;
} {
  const budgets: JobBudget[] = [];
  const result = store.run(budgets, fn);
  return { budgets, result };
}

/** Called by budgetForSite(); no-op outside a captured job run. */
export function registerBudget(budget: JobBudget): void {
  store.getStore()?.push(budget);
}
