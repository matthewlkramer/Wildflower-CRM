import { useEffect, useState, type ComponentType } from "react";
import { Link, useLocation } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import { 
  LayoutDashboard, 
  Users, 
  Building2, 
  Target, 
  HandCoins, 
  Gift, 
  Activity, 
  LineChart, 
  CalendarDays,
  Settings,
  LogOut,
  Menu,
  Inbox,
  Eye,
  Scale,
  PanelLeftClose,
  PanelLeftOpen,
  Lightbulb,
  FileBarChart,
  ScrollText,
  Megaphone,
  Newspaper,
  CalendarCheck2,
  Plane,
  GalleryVerticalEnd,
  Rss,
} from "lucide-react";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { adminMaintenanceLinks } from "@/lib/admin-maintenance";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { HeaderEntityFilter } from "@/components/entity-filter";
import { SidebarCollapsedContext } from "@/components/sidebar-collapsed-context";
import { CommandPaletteProvider, CommandPaletteTrigger } from "@/components/command-palette";
import { MeetingLauncherDialog } from "@/components/meeting-launcher-dialog";
import { FeedbackDialog } from "@/components/feedback-dialog";
import { LogInteractionDialog } from "@/components/log-interaction-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type NavLink = {
  href: string;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  adminOnly?: boolean;
  indent?: boolean;
};
type NavSection = { section: string; adminOnly?: boolean; indent?: boolean };
type NavEntry = NavLink | NavSection;

function BrandLockup({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`flex items-center ${compact ? "justify-center" : "gap-2"}`}>
      <span className="flex h-10 w-12 shrink-0 items-center justify-center rounded-md bg-white/95 p-1 shadow-sm">
        <img
          src={`${import.meta.env.BASE_URL}wildflower-watercolor-mark.png`}
          alt=""
          className="h-full w-full object-contain"
        />
      </span>
      {compact ? null : (
        <span className="leading-none">
          <span className="block font-serif text-[1.05rem] font-medium tracking-wide text-sidebar-foreground">
            Wildflower
          </span>
          <span className="mt-0.5 block text-[10px] font-bold uppercase tracking-[0.18em] text-sidebar-foreground/65">
            Fundraising CRM
          </span>
        </span>
      )}
    </div>
  );
}

const navItems: NavEntry[] = [
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    description: "See your priorities, follow-ups, and fundraising progress.",
  },

  { section: "Donors & pipeline" },
  {
    href: "/individuals",
    label: "Individuals",
    icon: Users,
    description:
      "Find people, household connections, and relationship history.",
  },
  {
    href: "/organizations",
    label: "Organizations",
    icon: Building2,
    description:
      "Find institutional donors and the people affiliated with them.",
  },
  {
    href: "/opportunities",
    label: "Opportunities",
    icon: Target,
    description: "Track potential asks, decisions, and next steps.",
  },
  {
    href: "/pledges",
    label: "Pledges",
    icon: HandCoins,
    description: "Track donor commitments, payment plans, and balances due.",
  },
  {
    href: "/grant-leads",
    label: "Grant Leads",
    icon: Lightbulb,
    description: "Review potential grants before adding them to the pipeline.",
  },

  { section: "Engagement" },
  {
    href: "/feed",
    label: "Feed",
    icon: Rss,
    description: "Scan recent activity and updates across relationships.",
  },
  {
    href: "/moves",
    label: "Moves",
    icon: Activity,
    description: "Review outreach and follow-up across donor portfolios.",
  },
  {
    href: "/meetings",
    label: "Meetings",
    icon: CalendarCheck2,
    description: "Prepare for meetings and find notes and next steps.",
  },
  {
    href: "/trips",
    label: "Trip Planner",
    icon: Plane,
    description: "Plan trips and organize visits with donors and schools.",
  },
  {
    href: "/conferences",
    label: "Conferences",
    icon: GalleryVerticalEnd,
    description: "Find conferences and track attendance.",
  },
  {
    href: "/newsletter",
    label: "Newsletter",
    icon: Newspaper,
    description: "Review newsletter audiences and engagement.",
  },
  {
    href: "/email-tracking",
    label: "Email Tracking",
    icon: Eye,
    description: "Review activity on tracked emails.",
  },
  {
    href: "/email-intelligence",
    label: "Email Intelligence",
    icon: Inbox,
    description: "Review suggested updates from synced email.",
  },

  { section: "Gift processing" },
  {
    href: "/reconciliation/deposits",
    label: "Reconciliation",
    icon: Scale,
    description:
      "Start here when money arrives. Identify and match each payment.",
  },
  {
    href: "/gifts",
    label: "Gifts",
    icon: Gift,
    description:
      "Review received gifts and total giving by credited fiscal year and purpose.",
  },
  { section: "Accounting" },
  {
    href: "/revenue-extractor",
    label: "Accounting Data",
    icon: FileBarChart,
    description: "Review gift coding and prepare the Finance export.",
  },

  { section: "Reporting & planning" },
  {
    href: "/fiscal-year-report/current",
    label: "FY Report",
    icon: FileBarChart,
    description: "See received goal credit, unpaid commitments, and open asks.",
  },
  {
    href: "/deadlines",
    label: "Deadlines",
    icon: CalendarDays,
    description: "Track applications, projected closes, and reports due to donors.",
  },
  {
    href: "/projections",
    label: "Projections",
    icon: LineChart,
    description: "Review expected fundraising against goals.",
  },

  { section: "Development team" },
  {
    href: "/meetings/development",
    label: "Development Team Meetings",
    icon: Users,
    description: "Plan weekly development team agendas and review past meetings.",
  },
  {
    href: "/campaigns",
    label: "Campaigns",
    icon: Megaphone,
    adminOnly: true,
    description: "Maintain fundraising appeals and campaign attribution.",
  },

  { section: "Administration" },
  {
    href: "/admin",
    label: "Admin",
    icon: Settings,
    description: "Find maintenance tools, app improvements, settings, and integrations.",
  },
  {
    href: "/audit-log",
    label: "Audit Log",
    icon: ScrollText,
    adminOnly: true,
    description: "See who changed a record and when.",
  },
];

function NavLinks({
  location,
  isAdmin,
  collapsed = false,
  onNavigate,
}: {
  location: string;
  isAdmin: boolean;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const visibleItems = navItems.filter((item) => !item.adminOnly || isAdmin);
  const activePath = adminMaintenanceLinks.some(({ href }) => pathWithin(location, href))
    ? "/admin"
    : location;
  const activeHref = visibleItems.reduce((best, item) =>
    "href" in item && item.href.length > best.length && pathWithin(activePath, item.href)
      ? item.href
      : best, "");

  return (
    <TooltipProvider>
      <nav className="space-y-0.5" data-testid="primary-navigation">
        {visibleItems.map((item) => {
            if ("section" in item) {
              return collapsed ? (
                <div
                  key={`section-${item.section}`}
                  role="separator"
                  className="mx-auto my-2 h-px w-6 bg-sidebar-border"
                />
              ) : (
                <div
                  key={`section-${item.section}`}
                  className={`pb-0.5 pt-3 text-[10px] font-bold uppercase tracking-widest text-sidebar-foreground/50 ${item.indent ? "pl-6 pr-3" : "px-3"}`}
                >
                  {item.section}
                </div>
              );
            }
            const isActive = item.href === activeHref;
            const Icon = item.icon;
            const indented = !collapsed && "indent" in item && item.indent;
            const link = (
              <Link
                key={item.href}
                href={item.href}
                aria-label={item.label}
                aria-current={isActive ? "page" : undefined}
                onClick={onNavigate}
                className={`group flex items-center gap-3 rounded-lg py-1.5 text-sm font-medium transition-all duration-150 ${collapsed ? "justify-center px-3" : indented ? "pl-7 pr-3" : "px-3"} ${isActive ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm" : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"}`}
              >
                <Icon
                  className={`h-4 w-4 shrink-0 transition-transform duration-150 ${isActive ? "scale-110" : "group-hover:scale-110"}`}
                />
                {!collapsed && (
                  <span>
                    {item.label}
                    {onNavigate && (
                      <span className="block text-xs font-normal opacity-80">
                        {item.description}
                      </span>
                    )}
                  </span>
                )}
              </Link>
            );
            return onNavigate ? (
              link
            ) : (
              <Tooltip key={item.href}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right" className="max-w-60">
                  {collapsed && <strong className="block">{item.label}</strong>}
                  {item.description}
                </TooltipContent>
              </Tooltip>
            );
          })}
      </nav>
    </TooltipProvider>
  );
}

function pathWithin(location: string, href: string) {
  return location === href || location.startsWith(`${href}/`);
}

const SIDEBAR_COLLAPSED_KEY = "wf-sidebar-collapsed";

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { user } = useUser();
  const isAdmin = useIsAdmin();

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  });
  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  const [mobileOpen, setMobileOpen] = useState(false);


  return (
    <CommandPaletteProvider>
    <SidebarCollapsedContext.Provider value={collapsed}>
    <div
      className="flex h-[100dvh] overflow-hidden bg-background"
      data-testid="app-shell"
    >
      {/* Desktop Sidebar (collapsible to an icon-only rail). */}
      <aside
        className={`hidden flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 md:flex ${collapsed ? "w-16" : "w-64"}`}
        data-testid="desktop-sidebar"
        data-collapsed={collapsed ? "true" : "false"}
      >
        <div className={`flex h-14 items-center border-b border-sidebar-border ${collapsed ? "justify-center px-2" : "justify-between px-4"}`}>
          {collapsed ? null : <BrandLockup />}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            data-testid="button-toggle-sidebar"
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </Button>
        </div>
        <div className={`flex-1 overflow-y-auto ${collapsed ? "p-2" : "p-3"}`}>
          <NavLinks location={location} isAdmin={isAdmin} collapsed={collapsed} />
        </div>
        <div className={`border-t border-sidebar-border ${collapsed ? "p-2" : "p-3"}`}>
          {collapsed ? (
            <div className="flex flex-col items-center gap-2">
              <Avatar className="h-8 w-8 border border-sidebar-border">
                <AvatarImage src={user?.imageUrl} />
                <AvatarFallback className="bg-sidebar-accent text-sidebar-foreground">{user?.firstName?.[0] || "U"}</AvatarFallback>
              </Avatar>
              <Button asChild variant="ghost" size="icon" title="Settings" aria-label="Settings" className="text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground">
                <Link href="/settings">
                  <Settings className="h-4 w-4" />
                </Link>
              </Button>
              <Button variant="ghost" size="icon" onClick={() => signOut()} title="Sign out" aria-label="Sign out" className="text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground">
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Avatar className="h-8 w-8 border border-sidebar-border">
                  <AvatarImage src={user?.imageUrl} />
                  <AvatarFallback className="bg-sidebar-accent text-sidebar-foreground">{user?.firstName?.[0] || "U"}</AvatarFallback>
                </Avatar>
                <div className="flex flex-col">
                  <span className="text-sm font-medium leading-none text-sidebar-foreground">{user?.fullName}</span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button asChild variant="ghost" size="icon" title="Settings" aria-label="Settings" className="h-8 w-8 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground">
                  <Link href="/settings">
                    <Settings className="h-4 w-4" />
                  </Link>
                </Button>
                <Button variant="ghost" size="icon" onClick={() => signOut()} title="Sign out" aria-label="Sign out" className="h-8 w-8 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground">
                  <LogOut className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header
          className="sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between gap-2 border-b bg-background px-3 shadow-sm"
          data-testid="app-header"
        >
          {/* Left: hamburger (mobile) + logo */}
          <div className="flex items-center gap-2">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="md:hidden shrink-0"
                  aria-label="Open navigation menu"
                >
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="flex w-72 flex-col gap-0 p-0 bg-sidebar border-r-sidebar-border text-sidebar-foreground">
                <div className="flex h-16 shrink-0 items-center border-b border-sidebar-border px-4">
                  <BrandLockup />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  <NavLinks location={location} isAdmin={isAdmin} onNavigate={() => setMobileOpen(false)} />
                </div>
                <div className="shrink-0 border-t border-sidebar-border p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-8 w-8 border border-sidebar-border">
                        <AvatarImage src={user?.imageUrl} />
                        <AvatarFallback className="bg-sidebar-accent text-sidebar-foreground">{user?.firstName?.[0] || "U"}</AvatarFallback>
                      </Avatar>
                      <span className="text-sm font-medium leading-none text-sidebar-foreground">{user?.fullName}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button asChild variant="ghost" size="icon" title="Settings" aria-label="Settings" className="h-8 w-8 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground">
                        <Link href="/settings" onClick={() => setMobileOpen(false)}>
                          <Settings className="h-4 w-4" />
                        </Link>
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => signOut()} title="Sign out" aria-label="Sign out" className="h-8 w-8 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground">
                        <LogOut className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              </SheetContent>
            </Sheet>

            <div className="hidden sm:flex items-center gap-2 md:hidden">
              <span className="font-serif text-lg font-medium tracking-wide text-primary">
                Wildflower CRM
              </span>
            </div>
          </div>

          {/* Spacer on desktop (sidebar already shows logo) */}
          <div className="hidden md:block" />

          {/* Right: action buttons */}
          <div className="flex min-w-0 items-center gap-1 sm:gap-2">
            <FeedbackDialog />
            <LogInteractionDialog compact />
            <MeetingLauncherDialog />
            <CommandPaletteTrigger />
            {location !== "/gifts" && <HeaderEntityFilter />}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          {children}
        </main>
      </div>
    </div>
    </SidebarCollapsedContext.Provider>
    </CommandPaletteProvider>
  );
}
