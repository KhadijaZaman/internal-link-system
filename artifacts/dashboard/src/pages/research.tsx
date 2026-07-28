import { useQueryClient } from "@tanstack/react-query";
import {
  useGetResearchLatest,
  useRunResearch,
  getGetResearchLatestQueryKey,
} from "@workspace/api-client-react";
import type { ResearchFinding } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { CopyButton } from "@/components/copy-button";
import { HowThisWorks } from "@/components/how-this-works";
import { FlaskConical, RefreshCw } from "lucide-react";

function FindingCard({ finding }: { finding: ResearchFinding }) {
  return (
    <Card data-testid={`finding-${finding.slug}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{finding.title}</CardTitle>
            <div className="mt-1 text-3xl font-semibold tracking-tight">{finding.headlineStat}</div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border bg-muted/40 p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm leading-relaxed">{finding.citation}</p>
            <CopyButton getText={() => finding.citation} />
          </div>
        </div>
        {finding.detail.length > 0 ? (
          <div className="space-y-1">
            {finding.detail.map((d) => (
              <div key={d.label} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate">{d.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {d.value.toLocaleString()}
                  {d.extra ? ` · ${d.extra}` : ""}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Methodology</summary>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{finding.methodology}</p>
        </details>
      </CardContent>
    </Card>
  );
}

export default function ResearchPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetResearchLatest();
  const runMutation = useRunResearch({
    mutation: {
      onSuccess: (fresh) => {
        queryClient.setQueryData(getGetResearchLatestQueryKey(), fresh);
      },
    },
  });

  const run = runMutation.data ?? data;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl flex items-center gap-2">
            <FlaskConical className="h-6 w-6" />
            Data Research
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Original statistics mined from your own search data — numbers nobody else has
            published, with a citation-ready sentence and methodology for each. The part everyone
            skips is the part AI quotes back.
          </p>
        </div>
        <Button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending}
          className="gap-1.5 shrink-0"
          data-testid="run-research"
        >
          <RefreshCw className={`h-4 w-4 ${runMutation.isPending ? "animate-spin" : ""}`} />
          {runMutation.isPending ? "Running…" : run?.available ? "Run again" : "Run research"}
        </Button>
      </div>

      <HowThisWorks
        summary="Mines your own Search Console, CMS, and AI-citation data into publishable original statistics."
        steps={[
          {
            title: "Run the analysis",
            body: "One click pulls a 90-day finalized Search Console window plus your crawl and AI-citation data. No paid or external data sources.",
          },
          {
            title: "Get citation-ready sentences",
            body: "Each finding is a single defensible sentence with the stat and sample size baked in — copy it straight into a post or pitch.",
          },
          {
            title: "Check the methodology",
            body: "Every stat documents exactly how it was computed, so it survives scrutiny when journalists or AI assistants quote it.",
          },
        ]}
        tips={[
          "Original numbers are what AI answers and journalists cite — publish the stat with its methodology and your page becomes the source.",
        ]}
      />

      {runMutation.isError ? (
        <p className="text-sm text-destructive">
          Research run failed — check the Search Console connection and try again.
        </p>
      ) : null}

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : !run?.available ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No research yet. Run your first analysis — it takes a few seconds and uses only data
            you already have.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex gap-2">
            <Badge variant="outline">
              window {run.windowStart} → {run.windowEnd}
            </Badge>
            <Badge variant="secondary">{run.findings.length} findings</Badge>
            {run.finishedAt ? (
              <Badge variant="outline">run {new Date(run.finishedAt).toLocaleDateString()}</Badge>
            ) : null}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {run.findings.map((f) => (
              <FindingCard key={f.slug} finding={f} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
