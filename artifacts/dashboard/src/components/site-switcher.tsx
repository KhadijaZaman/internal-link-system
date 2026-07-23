import { Check, ChevronsUpDown, Globe } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSiteContext } from "@/lib/site-context";

export function SiteSwitcher() {
  const { sites, activeSite, switchSite } = useSiteContext();

  if (!activeSite) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex w-full items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-left text-[13px] font-medium hover:bg-muted transition-colors"
        data-testid="button-site-switcher"
      >
        <Globe className="h-4 w-4 shrink-0 text-muted-foreground/70" />
        <span className="min-w-0 flex-1 truncate">{activeSite.displayName}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Sites
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {sites.map((site) => (
          <DropdownMenuItem
            key={site.id}
            onClick={() => switchSite(site.id)}
            className="gap-2"
            data-testid={`menuitem-site-${site.id}`}
          >
            <span className="min-w-0 flex-1 truncate">
              <span className="block truncate text-[13px] font-medium">
                {site.displayName}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {site.host}
              </span>
            </span>
            {site.id === activeSite.id && (
              <Check className="h-4 w-4 shrink-0 text-primary" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
