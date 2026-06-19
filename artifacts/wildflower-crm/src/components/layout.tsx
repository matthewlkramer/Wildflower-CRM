import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import { 
  LayoutDashboard, 
  Users, 
  MessageSquare,
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
  FileClock,
  Landmark,
  Star,
  FolderKanban,
  ReceiptText,
  CreditCard,
  Scale,
  PanelLeftClose,
  PanelLeftOpen,
  Lightbulb,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { HeaderEntityFilter } from "@/components/entity-filter";
import { SidebarCollapsedContext } from "@/components/sidebar-collapsed-context";
import { CommandPaletteProvider, CommandPaletteTrigger } from "@/components/command-palette";
import { AddMeetingNoteDialog } from "@/components/meeting-notes-panel";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/top-priorities", label: "Top Priorities", icon: Star },
  { href: "/individuals", label: "Individuals", icon: Users },
  { href: "/organizations", label: "Organizations", icon: Building2 },
  { href: "/payment-intermediaries", label: "Payment Intermediaries", icon: Landmark },
  { href: "/opportunities", label: "Opportunities", icon: Target },
  { href: "/pledges", label: "Pledges", icon: HandCoins },
  { href: "/gifts", label: "Gifts", icon: Gift },
  { href: "/staged-payments", label: "Finance Reconciliation", icon: ReceiptText },
  { href: "/stripe-staged-charges", label: "Stripe Review", icon: CreditCard },
  { href: "/stripe-reconciliation", label: "Stripe ↔ QB", icon: Scale },
  { href: "/moves", label: "Moves", icon: Activity },
  { href: "/interactions", label: "Interactions", icon: MessageSquare },
  { href: "/projections", label: "Projections", icon: LineChart },
  { href: "/grants-calendar", label: "Grants Calendar", icon: CalendarDays },
  { href: "/fundable-projects", label: "Fundable Projects", icon: FolderKanban },
  { href: "/reporting-deadlines", label: "Reporting Deadlines", icon: FileClock },
  { href: "/grant-leads", label: "Grant Leads", icon: Lightbulb },
  { href: "/email-intelligence", label: "Email Intelligence", icon: Inbox },
  { href: "/email-tracking", label: "Email Tracking", icon: Eye },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/admin", label: "Admin", icon: Settings },
];

const SIDEBAR_COLLAPSED_KEY = "wf-sidebar-collapsed";

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { user } = useUser();

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  });
  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  const [mobileOpen, setMobileOpen] = useState(false);

  const NavLinks = ({ collapsed = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) => (
    <nav className="space-y-1">
      {navItems.map((item) => {
        const isActive = location === item.href || location.startsWith(`${item.href}/`);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            title={collapsed ? item.label : undefined}
            onClick={onNavigate}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${collapsed ? "justify-center" : ""} ${isActive ? 'bg-primary/10 text-primary' : 'text-sidebar-foreground hover:bg-muted'}`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {collapsed ? null : item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <CommandPaletteProvider>
    <SidebarCollapsedContext.Provider value={collapsed}>
    <div className="flex min-h-screen bg-background">
      {/* Desktop Sidebar (collapsible to an icon-only rail). */}
      <aside
        className={`hidden flex-col border-r bg-sidebar transition-[width] duration-200 md:flex ${collapsed ? "w-16" : "w-64"}`}
        data-testid="desktop-sidebar"
        data-collapsed={collapsed ? "true" : "false"}
      >
        <div className={`flex h-14 items-center border-b ${collapsed ? "justify-center px-2" : "justify-between px-4"}`}>
          {collapsed ? null : (
            <div className="flex items-center gap-2 font-serif font-semibold text-primary">
              <svg viewBox="0 0 100 100" className="h-6 w-6" fill="none">
                <circle cx="50" cy="50" r="45" fill="#E8F3E8"/>
                <path d="M50 85 C50 85 45 60 50 40" stroke="currentColor" strokeWidth="4" strokeLinecap="round"/>
                <path d="M50 40 C35 35 30 50 50 55 C70 50 65 35 50 40" fill="currentColor"/>
                <circle cx="50" cy="40" r="6" fill="#F4A261"/>
                <path d="M50 60 C40 60 30 75 50 80 C70 75 60 60 50 60" fill="#40916C"/>
              </svg>
              Wildflower CRM
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            data-testid="button-toggle-sidebar"
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4 text-muted-foreground" />
            ) : (
              <PanelLeftClose className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
        </div>
        <div className={`flex-1 overflow-y-auto ${collapsed ? "p-2" : "p-4"}`}>
          <NavLinks collapsed={collapsed} />
        </div>
        <div className={`border-t ${collapsed ? "p-2" : "p-4"}`}>
          {collapsed ? (
            <div className="flex flex-col items-center gap-2">
              <Avatar className="h-8 w-8">
                <AvatarImage src={user?.imageUrl} />
                <AvatarFallback>{user?.firstName?.[0] || "U"}</AvatarFallback>
              </Avatar>
              <Button variant="ghost" size="icon" onClick={() => signOut()} title="Sign out" aria-label="Sign out">
                <LogOut className="h-4 w-4 text-muted-foreground" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Avatar className="h-8 w-8">
                  <AvatarImage src={user?.imageUrl} />
                  <AvatarFallback>{user?.firstName?.[0] || "U"}</AvatarFallback>
                </Avatar>
                <div className="flex flex-col">
                  <span className="text-sm font-medium leading-none">{user?.fullName}</span>
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => signOut()}>
                <LogOut className="h-4 w-4 text-muted-foreground" />
              </Button>
            </div>
          )}
        </div>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center justify-between gap-2 border-b bg-background px-3">
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
              <SheetContent side="left" className="w-72 p-0">
                <div className="flex h-14 items-center border-b px-4 gap-2 font-serif font-semibold text-primary">
                  <svg viewBox="0 0 100 100" className="h-6 w-6" fill="none">
                    <circle cx="50" cy="50" r="45" fill="#E8F3E8"/>
                    <path d="M50 85 C50 85 45 60 50 40" stroke="currentColor" strokeWidth="4" strokeLinecap="round"/>
                    <path d="M50 40 C35 35 30 50 50 55 C70 50 65 35 50 40" fill="currentColor"/>
                    <circle cx="50" cy="40" r="6" fill="#F4A261"/>
                    <path d="M50 60 C40 60 30 75 50 80 C70 75 60 60 50 60" fill="#40916C"/>
                  </svg>
                  Wildflower CRM
                </div>
                <div className="flex-1 overflow-y-auto p-4">
                  <NavLinks onNavigate={() => setMobileOpen(false)} />
                </div>
                <div className="border-t p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-8 w-8">
                        <AvatarImage src={user?.imageUrl} />
                        <AvatarFallback>{user?.firstName?.[0] || "U"}</AvatarFallback>
                      </Avatar>
                      <span className="text-sm font-medium leading-none">{user?.fullName}</span>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => signOut()}>
                      <LogOut className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                </div>
              </SheetContent>
            </Sheet>

            <div className="flex items-center gap-2 font-serif font-semibold text-primary md:hidden">
              <svg viewBox="0 0 100 100" className="h-6 w-6" fill="none">
                <circle cx="50" cy="50" r="45" fill="#E8F3E8"/>
                <path d="M50 85 C50 85 45 60 50 40" stroke="currentColor" strokeWidth="4" strokeLinecap="round"/>
                <path d="M50 40 C35 35 30 50 50 55 C70 50 65 35 50 40" fill="currentColor"/>
                <circle cx="50" cy="40" r="6" fill="#F4A261"/>
                <path d="M50 60 C40 60 30 75 50 80 C70 75 60 60 50 60" fill="#40916C"/>
              </svg>
              Wildflower CRM
            </div>
          </div>

          {/* Spacer on desktop (sidebar already shows logo) */}
          <div className="hidden md:block" />

          {/* Right: action buttons */}
          <div className="flex items-center gap-2">
            <AddMeetingNoteDialog unpinned />
            <CommandPaletteTrigger />
            <HeaderEntityFilter />
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
