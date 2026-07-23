import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useClerk, useUser } from "@clerk/react";
import { useClaimLegacySite } from "@workspace/api-client-react";
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
import { Globe, KeyRound, LogOut } from "lucide-react";

export function WelcomePage() {
  const { legacyClaimable } = useSiteContext();
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
            : status === 409
              ? "This site has already been claimed."
              : status === 429
                ? "Too many attempts — wait a minute and try again."
                : "Claim failed. Try again.";
        toast({ title: message, variant: "destructive" });
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
          <CardContent className="space-y-3">
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
                There are no sites linked to your account. Ask the site owner
                for access, or contact support if you believe this is a
                mistake.
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
