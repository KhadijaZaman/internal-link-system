import { Activity, AlertTriangle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  useGetJobStatus,
  useRunJob,
  getGetJobStatusQueryKey,
  type JobBudgetUsage,
} from "@workspace/api-client-react";

type RunnableJobName = Parameters<ReturnType<typeof useRunJob>["mutate"]>[0]["jobName"];

const BUDGET_KIND_LABELS: Record<string, string> = {
  llmCalls: "AI calls",
  serpQueries: "SERP queries",
  crawlPages: "crawled pages",
};

export function SpendCapBadge({
  budget,
  testId,
  onRunAgain,
  runDisabled,
}: {
  budget: JobBudgetUsage;
  testId: string;
  onRunAgain?: () => void;
  runDisabled?: boolean;
}) {
  const capped = budget.kinds.filter((k) => k.capHit);
  if (capped.length === 0) return null;
  const detail = capped
    .map((k) => `${k.used.toLocaleString()}/${k.limit.toLocaleString()} ${BUDGET_KIND_LABELS[k.kind] ?? k.kind}`)
    .join(" · ");
  return (
    <div
      className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-md px-2 py-1.5"
      data-testid={testId}
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
      <div className="flex-1 leading-snug">
        <span className="font-semibold">Hit spend cap</span> — stopped early at {detail}. Results are
        partial; run again to continue, or raise the site's per-run limits.
        {onRunAgain && (
          <Button
            size="sm"
            variant="outline"
            className="mt-1.5 flex h-6 px-2 text-[11px] border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 bg-amber-100/50 dark:bg-amber-950/50 hover:bg-amber-100 hover:text-amber-900 dark:hover:bg-amber-900/50"
            onClick={onRunAgain}
            disabled={runDisabled}
            data-testid={`${testId}-run-again`}
          >
            <Activity className="h-3 w-3 mr-1.5" />
            Run again
          </Button>
        )}
      </div>
    </div>
  );
}

export function JobSpendCapNotice({ jobName }: { jobName: RunnableJobName }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const runJob = useRunJob();
  const { data: jobs } = useGetJobStatus({
    query: { queryKey: getGetJobStatusQueryKey(), staleTime: 30_000 },
  });
  const job = jobs?.find((j) => j.name === jobName);
  const budget = job?.lastBudget;
  if (!budget || !budget.capped) return null;
  const handleRunAgain = () => {
    runJob.mutate(
      { jobName },
      {
        onSuccess: () => {
          toast({ title: "Job started", description: "Continuing from where it stopped." });
          queryClient.invalidateQueries({ queryKey: getGetJobStatusQueryKey() });
        },
        onError: () => toast({ variant: "destructive", title: "Failed to start the job" }),
      },
    );
  };
  return (
    <SpendCapBadge
      budget={budget}
      testId={`badge-spend-cap-${jobName}`}
      onRunAgain={handleRunAgain}
      runDisabled={runJob.isPending || job?.running === true}
    />
  );
}
