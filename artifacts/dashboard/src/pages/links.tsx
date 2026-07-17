import { useLocation, Link } from "wouter";
import { Inbox, Sparkles, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import SemanticLinks from "@/pages/semantic-links";
import LinkLookups from "@/pages/link-lookups";
import StructuralFixes from "@/pages/structural-fixes";

const TABS = [
  {
    href: "/links",
    match: ["/links", "/suggestions", "/semantic-links"],
    label: "Semantic Links",
    icon: Inbox,
    component: SemanticLinks,
  },
  {
    href: "/links/lookups",
    match: ["/links/lookups", "/link-lookups"],
    label: "Suggest Links",
    icon: Sparkles,
    component: LinkLookups,
  },
  {
    href: "/links/structural",
    match: ["/links/structural", "/structural"],
    label: "Structural Fixes",
    icon: Unplug,
    component: StructuralFixes,
  },
];

export default function LinksHub() {
  const [location] = useLocation();
  const active = TABS.find((t) => t.match.includes(location)) ?? TABS[0];
  const ActiveComponent = active.component;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-none mb-5 flex items-center gap-1 border-b border-border/60">
        {TABS.map((tab) => {
          const isActive = tab.href === active.href;
          return (
            <Link key={tab.href} href={tab.href}>
              <Button
                variant="ghost"
                className={`gap-2 rounded-none border-b-2 -mb-px ${
                  isActive
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground"
                }`}
              >
                <tab.icon className="h-4 w-4" />
                {tab.label}
              </Button>
            </Link>
          );
        })}
      </div>
      <div className="flex-1 min-h-0">
        <ActiveComponent key={active.href} />
      </div>
    </div>
  );
}
