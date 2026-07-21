import { useLocation, Link } from "wouter";
import { Inbox, Sparkles, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HowThisWorks } from "@/components/how-this-works";
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
      <HowThisWorks
        className="flex-none mb-5"
        summary="Your internal-linking control center — one place to review link suggestions, get new link ideas for any page, and fix pages that are cut off from the rest of your site."
        steps={[
          {
            title: "Semantic Links",
            body: "Review the internal-link recommendations the system generated and approve or reject each one. Approved links are ready for you to add to your pages.",
          },
          {
            title: "Suggest Links",
            body: "Paste any published page (or many at once) to get fresh ideas for pages it should link to, and pages that should link to it.",
          },
          {
            title: "Structural Fixes",
            body: "Find and repair “orphan” pages (nothing links to them) and “dead-end” pages (they link to nothing) — both are hard for Google to find and rank.",
          },
        ]}
        faqs={[
          {
            title: "What is an internal link?",
            body: "A link from one page on your own site to another. Internal links help visitors and Google move around your site and share ranking strength between pages.",
          },
          {
            title: "Do these tools change my site automatically?",
            body: "No. They only suggest links. You review and approve them, then add the links to your pages yourself (or through your CMS).",
          },
          {
            title: "Which tab should I start with?",
            body: "Start in Semantic Links to clear the suggestions already waiting, then use Structural Fixes to catch pages that are isolated.",
          },
        ]}
        tips={[
          "Switch tabs using the buttons below — each tab has its own detailed “How this works” panel.",
          "Approving a suggestion doesn't publish it; you still add the link to your content.",
        ]}
      />
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
