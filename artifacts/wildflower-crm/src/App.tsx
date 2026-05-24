import { useEffect, useRef } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from '@clerk/react';
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from 'wouter';
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

// Page imports
import Home from "@/pages/home";
import Dashboard from "@/pages/dashboard";
import Individuals from "@/pages/individuals";
import IndividualDetail from "@/pages/individual-detail";
import Households from "@/pages/households";
import HouseholdDetail from "@/pages/household-detail";
import FundingEntities from "@/pages/funding-entities";
import FundingEntityDetail from "@/pages/funding-entity-detail";
import Opportunities from "@/pages/opportunities";
import OpportunityDetail from "@/pages/opportunity-detail";
import Pledges from "@/pages/pledges";
import PledgeDetail from "@/pages/pledge-detail";
import Gifts from "@/pages/gifts";
import GiftDetail from "@/pages/gift-detail";
import Moves from "@/pages/moves";
import Projections from "@/pages/projections";
import GrantsCalendar from "@/pages/grants-calendar";
import FiscalYearDetail from "@/pages/fiscal-year-detail";
import Admin from "@/pages/admin";
import Layout from "@/components/layout";

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

const clerkAppearance = {
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(153, 43%, 28%)",
    colorBackground: "hsl(40, 33%, 98%)",
    colorInputBackground: "hsl(0, 0%, 100%)",
    colorText: "hsl(20, 20%, 15%)",
    colorTextSecondary: "hsl(20, 10%, 45%)",
    colorInputText: "hsl(20, 20%, 15%)",
    colorNeutral: "hsl(40, 15%, 85%)",
    borderRadius: "0.5rem",
    fontFamily: '"Inter", sans-serif',
    fontFamilyButtons: '"Inter", sans-serif',
  },
  elements: {
    rootBox: "w-full",
    cardBox: "rounded-2xl w-full overflow-hidden border border-border shadow-lg",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: { color: "hsl(20, 20%, 15%)" },
    headerSubtitle: { color: "hsl(20, 10%, 45%)" },
    socialButtonsBlockButtonText: { color: "hsl(20, 20%, 15%)" },
    formFieldLabel: { color: "hsl(20, 20%, 15%)" },
    footerActionLink: { color: "hsl(153, 43%, 28%)" },
    footerActionText: { color: "hsl(20, 10%, 45%)" },
    dividerText: { color: "hsl(20, 10%, 45%)" },
    formFieldSuccessText: { color: "hsl(153, 43%, 28%)" },
    alertText: { color: "hsl(0, 60%, 50%)" },
  },
};

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/dashboard" />
      </Show>
      <Show when="signed-out">
        <Home />
      </Show>
    </>
  );
}

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  return (
    <>
      <Show when="signed-in">
        <Layout>
          <Component />
        </Layout>
      </Show>
      <Show when="signed-out">
        <Redirect to="/sign-in" />
      </Show>
    </>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        queryClient.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);

  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            subtitle: "Sign in to access your CRM",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <Switch>
          <Route path="/" component={HomeRedirect} />
          <Route path="/sign-in/*?" component={SignInPage} />
          <Route path="/sign-up/*?" component={SignUpPage} />
          
          <Route path="/dashboard"><ProtectedRoute component={Dashboard} /></Route>
          
          <Route path="/individuals"><ProtectedRoute component={Individuals} /></Route>
          <Route path="/individuals/:id"><ProtectedRoute component={IndividualDetail} /></Route>
          
          <Route path="/households"><ProtectedRoute component={Households} /></Route>
          <Route path="/households/:id"><ProtectedRoute component={HouseholdDetail} /></Route>
          
          <Route path="/funding-entities"><ProtectedRoute component={FundingEntities} /></Route>
          <Route path="/funding-entities/:id"><ProtectedRoute component={FundingEntityDetail} /></Route>
          
          <Route path="/opportunities"><ProtectedRoute component={Opportunities} /></Route>
          <Route path="/opportunities/:id"><ProtectedRoute component={OpportunityDetail} /></Route>
          
          <Route path="/pledges"><ProtectedRoute component={Pledges} /></Route>
          <Route path="/pledges/:id"><ProtectedRoute component={PledgeDetail} /></Route>
          
          <Route path="/gifts"><ProtectedRoute component={Gifts} /></Route>
          <Route path="/gifts/:id"><ProtectedRoute component={GiftDetail} /></Route>
          <Route path="/moves"><ProtectedRoute component={Moves} /></Route>
          <Route path="/projections"><ProtectedRoute component={Projections} /></Route>
          <Route path="/fiscal-year/:fyId"><ProtectedRoute component={FiscalYearDetail} /></Route>
          <Route path="/grants-calendar"><ProtectedRoute component={GrantsCalendar} /></Route>
          <Route path="/admin"><ProtectedRoute component={Admin} /></Route>
          
          <Route component={NotFound} />
        </Switch>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <TooltipProvider>
      <WouterRouter base={basePath}>
        <ClerkProviderWithRoutes />
      </WouterRouter>
      <Toaster />
    </TooltipProvider>
  );
}

export default App;