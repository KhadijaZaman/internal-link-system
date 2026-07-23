import { useEffect, useState } from "react";
import { useLocation } from "wouter";
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

const LOCKOUT_STORAGE_KEY = "claim-legacy-lockout-until";

function readStoredLockout(): number | null {
  try {
    const raw = sessionStorage.getItem(LOCKOUT_STORAGE_KEY);
    if (!raw) return null;
    const until = Number(raw);
    if (!Number.isFinite(until) || until <= Date.now()) {
      sessionStorage.removeItem(LOCKOUT_STORAGE_KEY);
      return null;
    }
    return until;
  } catch {
    return null;
  }
}

function writeStoredLockout(until: number): void {
  try {
    sessionStorage.setItem(LOCKOUT_STORAGE_KEY, String(until));
  } catch {
    // sessionStorage unavailable — countdown still works in-memory
  }
}

function clearStoredLockout(): void {
  try {
    sessionStorage.removeItem(LOCKOUT_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} hours`;
}

function formatCountdown(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function WelcomePage() {
  const { legacyClaimable, switchSite } = useSiteContext();
  const { signOut } = useClerk();
  const { user } = useUser();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [claimOpen, setClaimOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [lockoutUntil, setLockoutUntil] = useState<number | null>(() =>
    readStoredLockout(),
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (lockoutUntil === null) return;
    if (Date.now() >= lockoutUntil) {
      setLockoutUntil(null);
      clearStoredLockout();
      return;
    }
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= lockoutUntil) {
        setLockoutUntil(null);
        clearStoredLockout();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [lockoutUntil]);

  const lockoutSecondsLeft =
    lockoutUntil !== null ? Math.ceil((lockoutUntil - now) / 1000) : 0;
  const lockedOut = lockoutUntil !== null && lockoutSecondsLeft > 0;

  const claim = useClaimLegacySite({
    mutation: {
      onSuccess: () => {
        toast({ title: "Site claimed", description: "Loading your data…" });
        setClaimOpen(false);
        queryClient.clear();
      },
      onError: (err: unknown) => {
        const status = (err as { status?: number })?.status;
        let message: string;
        if (status === 403) {
          message = "Wrong password.";
        } else if (status === 409 || status === 410) {
          message = "This site has already been claimed.";
        } else if (status === 429) {
          const retryAfterSeconds = (
            err as { data?: { retryAfterSeconds?: number } }
          )?.data?.retryAfterSeconds;
          if (retryAfterSeconds && retryAfterSeconds > 0) {
            message = `Too many attempts — try again in ${formatWait(retryAfterSeconds)}.`;
            const until = Date.now() + retryAfterSeconds * 1000;
            setLockoutUntil(until);
            writeStoredLockout(until);
            setNow(Date.now());
          } else {
            message = "Too many attempts — try again later.";
          }
        } else {
          message = "Claim failed. Try again.";
        }
        toast({ title: message, variant: "destructive" });
      },
    },
  });

  const [, setLocation] = useLocation();
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
          description: "Next step: connect Google Search Console so data can start flowing.",
        });
        await queryClient.invalidateQueries({ queryKey: getListSitesQueryKey() });
        switchSite(site.id);
        // Land the new owner directly on Connections — connecting Search
        // Console is the required next step before any data shows up.
        setLocation("/settings");
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
              if (password.length === 0 || claim.isPending || lockedOut) return;
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
            <DialogFooter className="sm:flex-col sm:items-end gap-2">
              <Button
                type="submit"
                disabled={password.length === 0 || claim.isPending || lockedOut}
                data-testid="button-submit-claim"
              >
                {lockedOut
                  ? `Try again in ${formatCountdown(lockoutSecondsLeft)}`
                  : claim.isPending
                    ? "Verifying…"
                    : "Claim site"}
              </Button>
              {lockedOut ? (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="text-claim-lockout"
                >
                  Too many attempts. Claiming is temporarily locked.
                </p>
              ) : null}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
