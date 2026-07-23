import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetIntegrations,
  getGetIntegrationsQueryKey,
  useGetGscAuthUrl,
  useListGscProperties,
  getListGscPropertiesQueryKey,
  useSetGscProperty,
  useConnectGa4,
  useConnectBing,
  useDisconnectIntegration,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/hooks/use-toast";
import { useSiteContext } from "@/lib/site-context";
import { CheckCircle2, Circle, Plug, Unplug } from "lucide-react";

function StatusBadge({ connected }: { connected: boolean }) {
  return connected ? (
    <Badge className="gap-1 bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
      <CheckCircle2 className="h-3 w-3" /> Connected
    </Badge>
  ) : (
    <Badge variant="secondary" className="gap-1">
      <Circle className="h-3 w-3" /> Not connected
    </Badge>
  );
}

export default function SettingsPage() {
  const { activeSite } = useSiteContext();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: status, isLoading } = useGetIntegrations({
    query: { queryKey: getGetIntegrationsQueryKey() },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetIntegrationsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListGscPropertiesQueryKey() });
  };

  // Surface the OAuth callback result (?gsc=connected|pick-property|denied|error|invalid)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gsc = params.get("gsc");
    if (!gsc) return;
    params.delete("gsc");
    const qs = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}`,
    );
    if (gsc === "connected") {
      toast({ title: "Search Console connected", description: "Property matched automatically." });
    } else if (gsc === "pick-property") {
      toast({ title: "Search Console connected", description: "Now pick which property feeds this site." });
    } else if (gsc === "denied") {
      toast({ title: "Google access was denied", variant: "destructive" });
    } else {
      toast({ title: "Search Console connection failed — try again", variant: "destructive" });
    }
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const authUrl = useGetGscAuthUrl({
    mutation: {
      onSuccess: (d) => {
        window.location.href = d.url;
      },
      onError: () =>
        toast({ title: "Could not start the Google connection", variant: "destructive" }),
    },
  });

  const gscConnected = status?.gsc.connected ?? false;
  const { data: props } = useListGscProperties({
    query: {
      queryKey: getListGscPropertiesQueryKey(),
      enabled: gscConnected,
      retry: false,
    },
  });

  const setProperty = useSetGscProperty({
    mutation: {
      onSuccess: () => {
        toast({ title: "Property selected" });
        invalidate();
      },
      onError: () => toast({ title: "Could not select property", variant: "destructive" }),
    },
  });

  const [saJson, setSaJson] = useState("");
  const [ga4PropertyId, setGa4PropertyId] = useState("");
  const connectGa4 = useConnectGa4({
    mutation: {
      onSuccess: () => {
        toast({ title: "GA4 connected" });
        setSaJson("");
        setGa4PropertyId("");
        invalidate();
      },
      onError: (err: unknown) => {
        const msg =
          (err as { data?: { error?: string } })?.data?.error ??
          "GA4 connection failed";
        toast({ title: msg, variant: "destructive" });
      },
    },
  });

  const [bingKey, setBingKey] = useState("");
  const connectBing = useConnectBing({
    mutation: {
      onSuccess: () => {
        toast({ title: "Bing connected" });
        setBingKey("");
        invalidate();
      },
      onError: (err: unknown) => {
        const msg =
          (err as { data?: { error?: string } })?.data?.error ??
          "Bing connection failed";
        toast({ title: msg, variant: "destructive" });
      },
    },
  });

  const disconnect = useDisconnectIntegration({
    mutation: {
      onSuccess: () => {
        toast({ title: "Disconnected" });
        invalidate();
      },
      onError: () => toast({ title: "Disconnect failed", variant: "destructive" }),
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Connections
        </h1>
        <p className="text-sm text-muted-foreground">
          Data sources for {activeSite?.displayName ?? "this site"}. Credentials
          are stored securely and never shown again after saving.
        </p>
      </div>

      {/* GSC */}
      <Card data-testid="card-gsc">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Google Search Console</CardTitle>
            <StatusBadge connected={gscConnected} />
          </div>
          <CardDescription>
            Powers search performance, queries, indexing, and most reports.
            Connect with a Google account that has access to this site's
            Search Console property.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {gscConnected && status?.gsc.property ? (
            <p className="text-sm">
              Property: <span className="font-mono">{status.gsc.property}</span>
            </p>
          ) : null}
          {gscConnected && props && props.properties.length > 0 ? (
            <div className="space-y-2">
              <Label>Property feeding this site</Label>
              <Select
                value={props.selected ?? undefined}
                onValueChange={(v) =>
                  setProperty.mutate({ data: { property: v } })
                }
              >
                <SelectTrigger data-testid="select-gsc-property">
                  <SelectValue placeholder="Pick a property" />
                </SelectTrigger>
                <SelectContent>
                  {props.properties.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button
              onClick={() => authUrl.mutate()}
              disabled={authUrl.isPending}
              className="gap-2"
              data-testid="button-connect-gsc"
            >
              <Plug className="h-4 w-4" />
              {gscConnected ? "Reconnect Google account" : "Connect Search Console"}
            </Button>
            {gscConnected ? (
              <Button
                variant="ghost"
                className="gap-2 text-muted-foreground"
                onClick={() => disconnect.mutate({ provider: "gsc" })}
                disabled={disconnect.isPending}
                data-testid="button-disconnect-gsc"
              >
                <Unplug className="h-4 w-4" /> Disconnect
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* GA4 */}
      <Card data-testid="card-ga4">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Google Analytics 4</CardTitle>
            <StatusBadge connected={status?.ga4.connected ?? false} />
          </div>
          <CardDescription>
            Optional. Adds engagement, key events, and AI-referral sessions.
            Paste a service-account JSON key that has Viewer access to your
            GA4 property.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {status?.ga4.connected ? (
            <div className="flex items-center justify-between">
              <p className="text-sm">
                Property ID:{" "}
                <span className="font-mono">{status.ga4.propertyId}</span>
              </p>
              <Button
                variant="ghost"
                className="gap-2 text-muted-foreground"
                onClick={() => disconnect.mutate({ provider: "ga4" })}
                disabled={disconnect.isPending}
                data-testid="button-disconnect-ga4"
              >
                <Unplug className="h-4 w-4" /> Disconnect
              </Button>
            </div>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!saJson.trim() || !ga4PropertyId.trim() || connectGa4.isPending) return;
                connectGa4.mutate({
                  data: { serviceAccountJson: saJson, propertyId: ga4PropertyId },
                });
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="ga4-sa">Service account JSON</Label>
                <Textarea
                  id="ga4-sa"
                  rows={4}
                  placeholder='{"type":"service_account", ...}'
                  value={saJson}
                  onChange={(e) => setSaJson(e.target.value)}
                  data-testid="input-ga4-json"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ga4-prop">GA4 property ID</Label>
                <Input
                  id="ga4-prop"
                  placeholder="123456789"
                  value={ga4PropertyId}
                  onChange={(e) => setGa4PropertyId(e.target.value)}
                  data-testid="input-ga4-property"
                />
              </div>
              <Button
                type="submit"
                disabled={!saJson.trim() || !ga4PropertyId.trim() || connectGa4.isPending}
                data-testid="button-connect-ga4"
              >
                {connectGa4.isPending ? "Verifying…" : "Save & verify"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      {/* Bing */}
      <Card data-testid="card-bing">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Bing Webmaster Tools</CardTitle>
            <StatusBadge connected={status?.bing.connected ?? false} />
          </div>
          <CardDescription>
            Optional. Adds Bing search performance and AI-citation mapping.
            Generate an API key in Bing Webmaster Tools → Settings → API
            access.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {status?.bing.connected ? (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">API key saved.</p>
              <Button
                variant="ghost"
                className="gap-2 text-muted-foreground"
                onClick={() => disconnect.mutate({ provider: "bing" })}
                disabled={disconnect.isPending}
                data-testid="button-disconnect-bing"
              >
                <Unplug className="h-4 w-4" /> Disconnect
              </Button>
            </div>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!bingKey.trim() || connectBing.isPending) return;
                connectBing.mutate({ data: { apiKey: bingKey.trim() } });
              }}
            >
              <Input
                placeholder="Bing Webmaster API key"
                type="password"
                value={bingKey}
                onChange={(e) => setBingKey(e.target.value)}
                data-testid="input-bing-key"
              />
              <Button
                type="submit"
                disabled={!bingKey.trim() || connectBing.isPending}
                data-testid="button-connect-bing"
              >
                {connectBing.isPending ? "Verifying…" : "Save"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
