import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import { useGetSession } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { SiteSwitcher } from "@/components/site-switcher";
import { LayoutDashboard, Network, TrendingDown, Settings2, LogOut, LineChart, FileText, Ban, PenLine, Link2, Compass, BookOpen, ClipboardList, Bot, Gauge, Table2, ListTodo, Newspaper, Waypoints, SearchCheck, Boxes, GitCompareArrows, Sparkles, Map, Plug, ChevronDown, ShieldCheck } from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

// Always visible at the top — the everyday starting points.
const primaryItems: NavItem[] = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/actions", label: "To-Do List", icon: ListTodo },
  { href: "/digest", label: "Weekly Digest", icon: Newspaper },
];

const navSections: NavSection[] = [
  {
    label: "Track performance",
    items: [
      { href: "/gsc/overview", label: "Google Search", icon: LineChart },
      { href: "/ga4", label: "Visitor Engagement", icon: Gauge },
      { href: "/bing", label: "Bing & AI Citations", icon: Sparkles },
      { href: "/losers", label: "Declining Queries", icon: TrendingDown },
      { href: "/report", label: "Page Report", icon: Table2 },
      { href: "/keyword-report", label: "Keyword Report", icon: SearchCheck },
      { href: "/clustering", label: "Keyword Clusters", icon: Boxes },
      { href: "/gsc/ask", label: "Ask AI", icon: Bot },
    ],
  },
  {
    label: "Improve linking",
    items: [
      { href: "/links", label: "Link Suggestions", icon: Link2 },
      { href: "/link-map", label: "Link Map", icon: Network },
      { href: "/knowledge-graph", label: "Knowledge Graph", icon: Waypoints },
      { href: "/authority", label: "Site Authority", icon: Compass },
    ],
  },
  {
    label: "Improve content",
    items: [
      { href: "/optimize", label: "Page Optimizer", icon: Settings2 },
      { href: "/content/writer", label: "Content Writer", icon: PenLine },
      { href: "/topical-map", label: "Topical Map", icon: Map },
      { href: "/similarity", label: "Content Similarity", icon: GitCompareArrows },
      { href: "/knowledge-base", label: "Knowledge Base", icon: BookOpen },
      { href: "/submissions", label: "My Submissions", icon: ClipboardList },
    ],
  },
  {
    label: "Setup",
    items: [
      { href: "/settings", label: "Connections", icon: Plug },
      { href: "/wp/classifications", label: "Page Classifications", icon: FileText },
      { href: "/wp/exclude-list", label: "Excluded URLs", icon: Ban },
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

function sectionContainsActive(section: NavSection, location: string): boolean {
  // The Admin link is conditionally injected into Setup, so account for it here.
  if (section.label === "Setup" && isItemActive("/admin", location)) return true;
  return section.items.some((item) => isItemActive(item.href, location));
}

const OPEN_SECTIONS_KEY = "wellows-nav-open-sections";

function loadStoredOpenSections(): Record<string, boolean> | null {
  try {
    const raw = localStorage.getItem(OPEN_SECTIONS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : null;
  } catch {
    return null;
  }
}

function NavLink({ item, isActive }: { item: NavItem; isActive: boolean }) {
  return (
    <Link
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
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { user } = useUser();
  const { data: session } = useGetSession();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  // Sections start open where the user currently is; their manual toggles
  // are remembered across visits.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => {
    const stored = loadStoredOpenSections();
    const initial: Record<string, boolean> = {};
    for (const section of navSections) {
      initial[section.label] =
        sectionContainsActive(section, location) || (stored?.[section.label] ?? true);
    }
    return initial;
  });

  const toggleSection = (label: string) => {
    setOpenSections((prev) => {
      const next = { ...prev, [label]: !prev[label] };
      try {
        localStorage.setItem(OPEN_SECTIONS_KEY, JSON.stringify(next));
      } catch {
        // localStorage unavailable — non-fatal
      }
      return next;
    });
  };

  const handleLogout = () => {
    void signOut({ redirectUrl: basePath || "/" });
  };

  const isAdmin = session?.isAdmin === true;

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
        <div className="px-3 pb-3">
          <SiteSwitcher />
        </div>
        <nav className="flex-1 overflow-y-auto px-3 pb-4 space-y-4">
          <div className="space-y-0.5">
            {primaryItems.map((item) => (
              <NavLink key={item.href} item={item} isActive={isItemActive(item.href, location)} />
            ))}
          </div>
          {navSections.map((section) => {
            const isOpen = openSections[section.label] ?? true;
            const hasActive = sectionContainsActive(section, location);
            return (
              <div key={section.label}>
                <button
                  type="button"
                  onClick={() => toggleSection(section.label)}
                  aria-expanded={isOpen}
                  data-testid={`nav-section-${section.label.toLowerCase().replace(/\s+/g, "-")}`}
                  className={`flex w-full items-center justify-between px-2 pb-1 text-[11px] font-medium uppercase tracking-wider select-none transition-colors ${
                    hasActive && !isOpen
                      ? "text-primary"
                      : "text-muted-foreground/70 hover:text-foreground"
                  }`}
                >
                  {section.label}
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${isOpen ? "" : "-rotate-90"}`}
                  />
                </button>
                {isOpen && (
                  <div className="space-y-0.5">
                    {section.items.map((item) => (
                      <NavLink
                        key={item.href}
                        item={item}
                        isActive={isItemActive(item.href, location)}
                      />
                    ))}
                    {section.label === "Setup" && isAdmin && (
                      <NavLink
                        item={{ href: "/admin", label: "Admin", icon: ShieldCheck }}
                        isActive={isItemActive("/admin", location)}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <div className="border-t px-3 py-3 space-y-1">
          {user?.primaryEmailAddress?.emailAddress && (
            <div className="px-2 text-[11px] text-muted-foreground truncate" data-testid="text-user-email">
              {user.primaryEmailAddress.emailAddress}
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            className="w-full justify-start gap-2.5 text-[13px] font-medium text-muted-foreground"
            data-testid="button-logout"
          >
            <LogOut className="h-4 w-4" />
            Sign out
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
