import { Link, useLocation } from "wouter";
import { useLogout } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { LayoutDashboard, Network, TrendingDown, Settings2, LogOut, LineChart, FileText, Ban, PenLine, Link2, Compass, BookOpen, ClipboardList, Bot, Gauge, Table2, ListTodo, Newspaper, Waypoints, SearchCheck, Boxes, GitCompareArrows, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface NavSection {
  label: string | null;
  items: NavItem[];
}

const navSections: NavSection[] = [
  {
    label: null,
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/actions", label: "Action Queue", icon: ListTodo },
      { href: "/digest", label: "Weekly Digest", icon: Newspaper },
    ],
  },
  {
    label: "Search performance",
    items: [
      { href: "/gsc/overview", label: "GSC Pro", icon: LineChart },
      { href: "/ga4", label: "GA4 Engagement", icon: Gauge },
      { href: "/bing", label: "Bing & AI Citations", icon: Sparkles },
      { href: "/losers", label: "Query Losers", icon: TrendingDown },
      { href: "/report", label: "Page Report", icon: Table2 },
      { href: "/keyword-report", label: "Keyword Report", icon: SearchCheck },
      { href: "/clustering", label: "Keyword Clusters", icon: Boxes },
      { href: "/gsc/ask", label: "Ask AI", icon: Bot },
    ],
  },
  {
    label: "Internal linking",
    items: [
      { href: "/links", label: "Links", icon: Link2 },
      { href: "/link-map", label: "Link Map", icon: Network },
      { href: "/knowledge-graph", label: "Knowledge Graph", icon: Waypoints },
      { href: "/authority", label: "Site Authority", icon: Compass },
    ],
  },
  {
    label: "Content",
    items: [
      { href: "/optimize", label: "Optimizer", icon: Settings2 },
      { href: "/content/writer", label: "Content Writer", icon: PenLine },
      { href: "/similarity", label: "Similarity Explorer", icon: GitCompareArrows },
      { href: "/knowledge-base", label: "Knowledge Base", icon: BookOpen },
      { href: "/submissions", label: "My Submissions", icon: ClipboardList },
    ],
  },
  {
    label: "Site settings",
    items: [
      { href: "/wp/classifications", label: "WP Classifications", icon: FileText },
      { href: "/wp/exclude-list", label: "Exclude List", icon: Ban },
    ],
  },
];

function isItemActive(href: string, location: string): boolean {
  if (href === "/gsc/overview") {
    return location.startsWith("/gsc") && location !== "/gsc/ask";
  }
  if (href === "/gsc/ask") {
    return location === "/gsc/ask";
  }
  if (href === "/links") {
    return (
      location.startsWith("/links") ||
      ["/suggestions", "/semantic-links", "/link-lookups", "/structural"].includes(location)
    );
  }
  return location === href;
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const logout = useLogout();
  const { toast } = useToast();

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        setLocation("/login");
      },
      onError: () => {
        toast({ title: "Failed to logout", variant: "destructive" });
      }
    });
  };

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      {/* Sidebar */}
      <aside className="w-60 border-r bg-card flex flex-col">
        <div className="px-4 pt-5 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground font-display text-sm font-bold">
              W
            </div>
            <div className="min-w-0">
              <div className="font-display text-sm font-semibold leading-tight truncate">
                Wellows
              </div>
              <div className="text-[11px] text-muted-foreground leading-tight truncate">
                SEO Operations
              </div>
            </div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 pb-4 space-y-4">
          {navSections.map((section, si) => (
            <div key={section.label ?? si}>
              {section.label && (
                <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 select-none">
                  {section.label}
                </div>
              )}
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const isActive = isItemActive(item.href, location);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors ${
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      }`}
                    >
                      <item.icon
                        className={`h-4 w-4 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground/70"}`}
                      />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
        <div className="border-t px-3 py-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            className="w-full justify-start gap-2.5 text-[13px] font-medium text-muted-foreground"
          >
            <LogOut className="h-4 w-4" />
            Logout
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        <main className="flex-1 overflow-y-auto p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
