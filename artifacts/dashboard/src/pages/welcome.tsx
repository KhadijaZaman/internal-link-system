import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useClerk, useUser } from "@clerk/react";
import {
  useClaimLegacySite,
  useCreateSite,
  getListSitesQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useSiteContext } from "@/lib/site-context";
import { Globe, KeyRound, LogOut, Plus } from "lucide-react";

export function WelcomePage() {
  const { legacyClaimable, switchSite } = useSiteContext();
  const { signOut } = useClerk();
  const { user } = useUser();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [claimOpen, setClaimOpen] = useState(false);
  const [password, setPassword] = useState("");

  const claim = useClaimLegacySite({
    mutation: {
      onSuccess: () => {
        toast({ title: "Site claimed", description: "Loading your data…" });
        setClaimOpen(false);
        queryClient.clear();
      },
      onError: (err: unknown) => {
        const status = (err as { status?: number })?.status;
        const message =
          status === 403
            ? "Wrong password."
            : status === 409 || status === 410
              ? "This site has already been claimed."
              : status === 429
                ? "Too many attempts — wait a minute and try again."
                : "Claim failed. Try again.";
        toast({ title: message, variant: "destructive" });
      },
    },
  });

  const [domain, setDomain] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [sitemapUrl, setSitemapUrl] = useState("");
  const sitemapInvalid =
    sitemapUrl.trim().length > 0 && !/^https?:\/\/.+\..+/i.test(sitemapUrl.trim());

  const createSite = useCreateSite({
    mutation: {
      onSuccess: async (site) => {
        toast({
          title: "Site added",
          description: "Now connect Search Console in Settings → Connections.",
        });
        await queryClient.invalidateQueries({ queryKey: getListSitesQueryKey() });
        switchSite(site.id);
      },
      onError: (err: unknown) => {
        const status = (err as { status?: number })?.status;
        const data = (err as { data?: { error?: string } })?.data;
        toast({
          title:
            data?.error ??
            (status === 409
              ? "A site with this domain already exists."
              : "Could not add the site. Check the domain and try again."),
          variant: "destructive",
        });
      },
    },
  });

  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-4">
        <Card>
          <CardHeader>
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-primary-foreground font-display text-lg font-bold">
              W
            </div>
            <CardTitle className="pt-2">Welcome to Wellows</CardTitle>
            <CardDescription>
              {user?.primaryEmailAddress?.emailAddress
                ? `Signed in as ${user.primaryEmailAddress.emailAddress}. `
                : ""}
              You don't have any sites yet.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!domain.trim() || sitemapInvalid || createSite.isPending) return;
                createSite.mutate({
                  data: {
                    domain: domain.trim(),
                    ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
                    ...(sitemapUrl.trim() ? { sitemapUrl: sitemapUrl.trim() } : {}),
                  },
                });
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="add-site-domain">Your website</Label>
                <Input
                  id="add-site-domain"
                  placeholder="example.com"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  data-testid="input-add-site-domain"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="add-site-name">
                  Display name{" "}
                  <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input
                  id="add-site-name"
                  placeholder="My Site"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  data-testid="input-add-site-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="add-site-sitemap">
                  Sitemap URL{" "}
                  <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input
                  id="add-site-sitemap"
                  placeholder="https://example.com/sitemap.xml"
                  value={sitemapUrl}
                  onChange={(e) => setSitemapUrl(e.target.value)}
                  data-testid="input-add-site-sitemap"
                />
                {sitemapInvalid ? (
                  <p className="text-xs text-destructive">
                    Enter a full URL starting with http:// or https://
                  </p>
                ) : null}
              </div>
              <Button
                type="submit"
                className="w-full gap-2"
                disabled={!domain.trim() || sitemapInvalid || createSite.isPending}
                data-testid="button-add-site"
              >
                <Plus className="h-4 w-4" />
                {createSite.isPending ? "Adding…" : "Add your site"}
              </Button>
            </form>
            {legacyClaimable ? (
              <>
                <p className="text-sm text-muted-foreground">
                  If you previously used the admin password to access this
                  dashboard, you can claim the existing Wellows site and all of
                  its data.
                </p>
                <Button
                  className="w-full gap-2"
                  onClick={() => setClaimOpen(true)}
                  data-testid="button-open-claim"
                >
                  <KeyRound className="h-4 w-4" />
                  Claim the Wellows site
                </Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground flex items-start gap-2">
                <Globe className="h-4 w-4 mt-0.5 shrink-0" />
                Add your website above to get started — you'll connect Google
                Search Console right after.
              </p>
            )}
            <Button
              variant="ghost"
              className="w-full gap-2 text-muted-foreground"
              onClick={() => signOut({ redirectUrl: basePath || "/" })}
              data-testid="button-signout-welcome"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </CardContent>
        </Card>
      </div>

      <Dialog open={claimOpen} onOpenChange={setClaimOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Claim the Wellows site</DialogTitle>
            <DialogDescription>
              Enter the previous admin password to verify you're the operator.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (password.length === 0 || claim.isPending) return;
              claim.mutate({ data: { password } });
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="claim-password">Admin password</Label>
              <Input
                id="claim-password"
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="input-claim-password"
              />
            </div>
            <DialogFooter>
              <Button
                type="submit"
                disabled={password.length === 0 || claim.isPending}
                data-testid="button-submit-claim"
              >
                {claim.isPending ? "Verifying…" : "Claim site"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
