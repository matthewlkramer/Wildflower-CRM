import { Link, useLocation } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import { 
  LayoutDashboard, 
  Users, 
  Home, 
  MessageSquare,
  Building2, 
  Target, 
  Columns3,
  HandCoins, 
  Gift, 
  Activity, 
  LineChart, 
  CalendarDays,
  Settings,
  LogOut,
  Menu,
  Inbox,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { HeaderEntityFilter } from "@/components/entity-filter";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/individuals", label: "Individuals", icon: Users },
  { href: "/households", label: "Households", icon: Home },
  { href: "/funding-entities", label: "Funding Entities", icon: Building2 },
  { href: "/opportunities", label: "Opportunities", icon: Target },
  { href: "/pipeline", label: "Pipeline", icon: Columns3 },
  { href: "/pledges", label: "Pledges", icon: HandCoins },
  { href: "/gifts", label: "Gifts", icon: Gift },
  { href: "/moves", label: "Moves", icon: Activity },
  { href: "/interactions", label: "Interactions", icon: MessageSquare },
  { href: "/projections", label: "Projections", icon: LineChart },
  { href: "/grants-calendar", label: "Grants Calendar", icon: CalendarDays },
  { href: "/email-intelligence", label: "Email Intelligence", icon: Inbox },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/admin", label: "Admin", icon: Settings },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { user } = useUser();

  const NavLinks = () => (
    <nav className="space-y-1">
      {navItems.map((item) => {
        const isActive = location === item.href || location.startsWith(`${item.href}/`);
        const Icon = item.icon;
        return (
          <Link key={item.href} href={item.href} className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${isActive ? 'bg-primary/10 text-primary' : 'text-sidebar-foreground hover:bg-muted'}`}>
            <Icon className="h-4 w-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop Sidebar */}
      <aside className="hidden w-64 flex-col border-r bg-sidebar md:flex">
        <div className="flex h-14 items-center border-b px-4">
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
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <NavLinks />
        </div>
        <div className="border-t p-4">
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
        </div>
      </aside>

      {/* Header (desktop + mobile) + Content. The header carries the global
          entity filter so the user's selection persists across every page
          rather than being a per-page widget on /dashboard only. */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center justify-between gap-3 border-b bg-background px-4">
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
          {/* Spacer pushes the entity filter to the right on desktop where
              there's no logo (sidebar already shows it). */}
          <div className="hidden md:block" />
          <div className="flex items-center gap-2">
            <HeaderEntityFilter />
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="md:hidden">
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-64 p-0">
                <div className="flex h-14 items-center border-b px-4 font-serif font-semibold text-primary">
                  Menu
                </div>
                <div className="p-4">
                  <NavLinks />
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
