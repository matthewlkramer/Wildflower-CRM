import { useEffect, useRef } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from '@clerk/react';
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from 'wouter';
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

// Page imports
import Dashboard from "@/pages/dashboard";
import Individuals from "@/pages/individuals";
import IndividualDetail from "@/pages/individual-detail";
import HouseholdDetail from "@/pages/household-detail";
import Organizations from "@/pages/funding-entities";
import OrganizationDetail from "@/pages/funding-entity-detail";
import Opportunities from "@/pages/opportunities";
import OpportunityDetail from "@/pages/opportunity-detail";
import Pledges from "@/pages/pledges";
import PledgeDetail from "@/pages/pledge-detail";
import Gifts from "@/pages/gifts";
import GiftDetail from "@/pages/gift-detail";
import Moves from "@/pages/moves";
import Interactions from "@/pages/interactions";
import Projections from "@/pages/projections";
import GrantsCalendar from "@/pages/grants-calendar";
import FiscalYearDetail from "@/pages/fiscal-year-detail";
import FiscalYearReport from "@/pages/fiscal-year-report";
import Admin from "@/pages/admin";
import AuditLog from "@/pages/audit-log";
import PotentialDuplicates from "@/pages/potential-duplicates";
import CleanupQueue from "@/pages/cleanup-queue";
import RevenueExtractor from "@/pages/revenue-extractor";
import CodingFormImport from "@/pages/coding-form-import";
import FundableProjects from "@/pages/fundable-projects";
import Settings from "@/pages/settings";
import ReconciliationClusters from "@/pages/reconciliation-clusters";
import EmailIntelligence from "@/pages/email-intelligence";
import GrantLeads from "@/pages/grant-leads";
import EmailTracking from "@/pages/email-tracking";
import ReportingDeadlines from "@/pages/reporting-deadlines";
import TopPriorities from "@/pages/top-priorities";
import PaymentIntermediaries from "@/pages/payment-intermediaries";
import PaymentIntermediaryDetail from "@/pages/payment-intermediary-detail";
import Layout from "@/components/layout";
import { ErrorBoundary } from "@/components/error-boundary";
import { EntityFilterProvider } from "@/lib/entity-filter-context";

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
        <Redirect to="/sign-in" />
      </Show>
    </>
  );
}

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  // EntityFilterProvider lives inside the signed-in tree so the entities
  // list query (which requires auth) doesn't fire while signed out.
  return (
    <>
      <Show when="signed-in">
        <EntityFilterProvider>
          <Layout>
            <Component />
          </Layout>
        </EntityFilterProvider>
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
          <Route path="/top-priorities"><ProtectedRoute component={TopPriorities} /></Route>
          
          <Route path="/individuals"><ProtectedRoute component={Individuals} /></Route>
          <Route path="/individuals/:id"><ProtectedRoute component={IndividualDetail} /></Route>
          
          <Route path="/households/:id"><ProtectedRoute component={HouseholdDetail} /></Route>
          
          <Route path="/organizations"><ProtectedRoute component={Organizations} /></Route>
          <Route path="/organizations/:id"><ProtectedRoute component={OrganizationDetail} /></Route>
          
          <Route path="/payment-intermediaries"><ProtectedRoute component={PaymentIntermediaries} /></Route>
          <Route path="/payment-intermediaries/:id"><ProtectedRoute component={PaymentIntermediaryDetail} /></Route>
          
          <Route path="/pipeline"><Redirect to="/opportunities" /></Route>
          <Route path="/opportunities"><ProtectedRoute component={() => <Opportunities pledgeView="opportunities" />} /></Route>
          <Route path="/opportunities/:id"><ProtectedRoute component={OpportunityDetail} /></Route>
          
          <Route path="/pledges"><ProtectedRoute component={Pledges} /></Route>
          <Route path="/pledges/:id"><ProtectedRoute component={PledgeDetail} /></Route>
          
          <Route path="/gifts"><ProtectedRoute component={Gifts} /></Route>
          <Route path="/gifts/:id"><ProtectedRoute component={GiftDetail} /></Route>
          {/* Legacy reconciliation surfaces — all superseded by the cluster workbench. */}
          <Route path="/staged-payments"><Redirect to="/reconciliation/clusters" /></Route>
          <Route path="/stripe-staged-charges"><Redirect to="/reconciliation/clusters" /></Route>
          <Route path="/stripe-reconciliation"><Redirect to="/reconciliation/clusters" /></Route>
          <Route path="/donorbox-review"><Redirect to="/reconciliation/clusters" /></Route>
          <Route path="/reconciliation"><Redirect to="/reconciliation/clusters" /></Route>
          <Route path="/reconciliation-workbench"><Redirect to="/reconciliation/clusters" /></Route>
          <Route path="/reconciliation/clusters"><ProtectedRoute component={ReconciliationClusters} /></Route>
          <Route path="/moves"><ProtectedRoute component={Moves} /></Route>
          <Route path="/interactions"><ProtectedRoute component={Interactions} /></Route>
          <Route path="/projections"><ProtectedRoute component={Projections} /></Route>
          <Route path="/fiscal-year/:fyId"><ProtectedRoute component={FiscalYearDetail} /></Route>
          <Route path="/fiscal-year-report/:fyId"><ProtectedRoute component={FiscalYearReport} /></Route>
          <Route path="/grants-calendar"><ProtectedRoute component={GrantsCalendar} /></Route>
          <Route path="/reporting-deadlines"><ProtectedRoute component={ReportingDeadlines} /></Route>
          <Route path="/grant-leads"><ProtectedRoute component={GrantLeads} /></Route>
          <Route path="/email-intelligence"><ProtectedRoute component={EmailIntelligence} /></Route>
          <Route path="/email-tracking"><ProtectedRoute component={EmailTracking} /></Route>
          <Route path="/fundable-projects"><ProtectedRoute component={FundableProjects} /></Route>
          <Route path="/settings"><ProtectedRoute component={Settings} /></Route>
          <Route path="/admin"><ProtectedRoute component={Admin} /></Route>
          <Route path="/audit-log"><ProtectedRoute component={AuditLog} /></Route>
          <Route path="/potential-duplicates"><ProtectedRoute component={PotentialDuplicates} /></Route>
          <Route path="/revenue-extractor"><ProtectedRoute component={RevenueExtractor} /></Route>
          <Route path="/financial-corrections"><Redirect to="/reconciliation/clusters" /></Route>
          <Route path="/cleanup-queue"><ProtectedRoute component={CleanupQueue} /></Route>
          <Route path="/coding-form-import"><ProtectedRoute component={CodingFormImport} /></Route>
          
          <Route component={NotFound} />
        </Switch>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    // The error boundary wraps the entire routed app so a render crash on
    // any page shows a contained "Something went wrong" card instead of
    // unmounting everything to a blank screen.
    <ErrorBoundary>
      <TooltipProvider>
        <WouterRouter base={basePath}>
          <ClerkProviderWithRoutes />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

export default App;