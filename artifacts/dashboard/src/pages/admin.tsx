import { useGetAdminOverview } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Users, Globe, ShieldCheck } from "lucide-react";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function AdminPage() {
  const { data, isLoading, error } = useGetAdminOverview();

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-xl mx-auto mt-16 text-center space-y-2">
        <ShieldCheck className="h-8 w-8 mx-auto text-muted-foreground" />
        <h1 className="font-display text-lg font-semibold">Admin access required</h1>
        <p className="text-sm text-muted-foreground">
          This page is only available to the platform administrator.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Everyone who has signed up, and every domain they've added. Newest first.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 max-w-md">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Users className="h-4 w-4" /> Users
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold" data-testid="text-total-users">
              {data.totals.users}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Globe className="h-4 w-4" /> Domains added
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold" data-testid="text-total-sites">
              {data.totals.sites}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Users &amp; their domains</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.users.length === 0 && (
            <p className="text-sm text-muted-foreground">No users yet.</p>
          )}
          {data.users.map((u) => (
            <div
              key={u.id}
              className="rounded-lg border p-4 space-y-2"
              data-testid={`row-user-${u.id}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-sm">
                  {u.email ?? <span className="font-mono text-xs">{u.id}</span>}
                </span>
                {u.isAdmin && (
                  <Badge variant="secondary" className="gap-1">
                    <ShieldCheck className="h-3 w-3" /> Admin
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground ml-auto">
                  Joined {formatDate(u.createdAt)}
                </span>
              </div>
              {u.sites.length === 0 ? (
                <p className="text-xs text-muted-foreground">No domains added yet.</p>
              ) : (
                <div className="space-y-1">
                  {u.sites.map((s) => (
                    <div
                      key={s.id}
                      className="flex flex-wrap items-center gap-2 text-sm"
                      data-testid={`row-site-${s.id}`}
                    >
                      <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="font-medium">{s.displayName}</span>
                      <span className="text-muted-foreground font-mono text-xs">{s.host}</span>
                      <span className="text-xs text-muted-foreground ml-auto">
                        Added {formatDate(s.createdAt)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {data.unclaimedSites.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Unclaimed sites</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {data.unclaimedSites.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-sm">
                <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium">{s.displayName}</span>
                <span className="text-muted-foreground font-mono text-xs">{s.host}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
