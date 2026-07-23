import { Link } from "wouter";
import { Cable } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Friendly empty state for the "data source isn't connected yet" case.
 * The API signals it with a 409 + code "integration_not_connected" (see the
 * error middleware in the api-server); anything else is a real error and
 * should keep the caller's normal error UI.
 */

const PROVIDER_LABELS: Record<string, string> = {
  gsc: "Google Search Console",
  ga4: "Google Analytics 4",
  bing: "Bing Webmaster Tools",
};

export function notConnectedProvider(error: unknown): string | null {
  const e = error as {
    status?: number;
    data?: { code?: string; provider?: string } | null;
  } | null;
  if (e?.status === 409 && e.data?.code === "integration_not_connected") {
    return e.data.provider ?? "unknown";
  }
  return null;
}

export function NotConnectedNotice({ provider }: { provider: string }) {
  const label = PROVIDER_LABELS[provider] ?? "This data source";
  return (
    <Card data-testid="notice-not-connected">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
          <Cable className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">{label} isn't connected yet</p>
          <p className="text-sm text-muted-foreground max-w-sm">
            This page shows live data from {label}. Connect it for this site and the
            data will appear here.
          </p>
        </div>
        <Button asChild size="sm" data-testid="button-goto-connections">
          <Link href="/settings">Open Settings → Connections</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
