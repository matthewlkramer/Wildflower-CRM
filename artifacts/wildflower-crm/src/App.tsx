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
import Projections from "@/pages/projections";
import GrantsCalendar from "@/pages/grants-calendar";
import FiscalYearDetail from "@/pages/fiscal-year-detail";
import FiscalYearReport from "@/pages/fiscal-year-report";
import Admin from "@/pages/admin";
import AdminFeedback from "@/pages/admin-feedback";
import AuditLog from "@/pages/audit-log";
import PotentialDuplicates from "@/pages/potential-duplicates";
import CleanupQueue from "@/pages/cleanup-queue";
import RestrictionTextReview from "@/pages/restriction-text-review";
import RevenueExtractor from "@/pages/revenue-extractor";
import CodingFormImport from "@/pages/coding-form-import";
import FundableProjects from "@/pages/fundable-projects";
import Campaigns from "@/pages/campaigns";
import Settings from "@/pages/settings";
import ReconciliationDeposits from "@/pages/reconciliation-deposits";
import EmailIntelligence from "@/pages/email-intelligence";
import GrantLeads from "@/pages/grant-leads";
import EmailTracking from "@/pages/email-tracking";
import ReportingDeadlines from "@/pages/reporting-deadlines";
import TopPriorities from "@/pages/top-priorities";
import PaymentIntermediaries from "@/pages/payment-intermediaries";
import PaymentIntermediaryDetail from "@/pages/payment-intermediary-detail";
import Meetings from "@/pages/meetings";
import TripPlanner from "@/pages/trip-planner";
import Newsletter from "@/pages/newsletter";
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
    logoImageUrl: `${window.location.origin}${basePath}/wildflower-watercolor-logo.png`,
  },
  variables: {
    colorPrimary: "#00a69c",
    colorBackground: "#ffffff",
    colorInputBackground: "hsl(0, 0%, 100%)",
    colorText: "#137070",
    colorTextSecondary: "#58585b",
    colorInputText: "#137070",
    colorNeutral: "#b2c9c7",
    borderRadius: "0.375rem",
    fontFamily: '"Avenir Next", Avenir, "Helvetica Neue", Helvetica, Arial, sans-serif',
    fontFamilyButtons: '"Avenir Next", Avenir, "Helvetica Neue", Helvetica, Arial, sans-serif',
  },
  elements: {
    rootBox: "w-full",
    cardBox: "rounded-xl w-full overflow-hidden border border-primary/20 shadow-xl bg-card",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    logoImage: "h-20 w-auto object-contain",
    headerTitle: { color: "#137070", fontFamily: '"Mrs Eaves", "EB Garamond", Garamond, serif', fontWeight: 500 },
    headerSubtitle: { color: "#58585b" },
    socialButtonsBlockButtonText: { color: "#137070" },
    formFieldLabel: { color: "#137070" },
    footerActionLink: { color: "#137070" },
    footerActionText: { color: "#58585b" },
    dividerText: { color: "#58585b" },
    formFieldSuccessText: { color: "#00a69c" },
    alertText: { color: "hsl(0, 70%, 45%)" },
  },
};

function SignInPage() {
  return (
    <div className="wf-watercolor-bg relative flex min-h-[100dvh] items-center justify-center px-4">
      <div className="z-10 w-full max-w-md">
        <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
      </div>
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="wf-watercolor-bg relative flex min-h-[100dvh] items-center justify-center px-4">
      <div className="z-10 w-full max-w-md">
        <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
      </div>
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
          {/* Legacy reconciliation surfaces — all superseded by the deposit-first workbench. */}
          <Route path="/staged-payments"><Redirect to="/reconciliation/deposits" /></Route>
          <Route path="/stripe-staged-charges"><Redirect to="/reconciliation/deposits" /></Route>
          <Route path="/stripe-reconciliation"><Redirect to="/reconciliation/deposits" /></Route>
          <Route path="/donorbox-review"><Redirect to="/reconciliation/deposits" /></Route>
          <Route path="/reconciliation"><Redirect to="/reconciliation/deposits" /></Route>
          <Route path="/reconciliation-workbench"><Redirect to="/reconciliation/deposits" /></Route>
          <Route path="/reconciliation/deposits"><ProtectedRoute component={ReconciliationDeposits} /></Route>
          <Route path="/reconciliation/clusters"><Redirect to="/reconciliation/deposits" /></Route>
          <Route path="/moves"><ProtectedRoute component={Moves} /></Route>
          <Route path="/meetings"><ProtectedRoute component={Meetings} /></Route>
          <Route path="/trips"><ProtectedRoute component={TripPlanner} /></Route>
          <Route path="/newsletter"><ProtectedRoute component={Newsletter} /></Route>
          <Route path="/interactions"><Redirect to="/moves" /></Route>
          <Route path="/projections"><ProtectedRoute component={Projections} /></Route>
          <Route path="/fiscal-year/:fyId"><ProtectedRoute component={FiscalYearDetail} /></Route>
          <Route path="/fiscal-year-report/:fyId"><ProtectedRoute component={FiscalYearReport} /></Route>
          <Route path="/grants-calendar"><ProtectedRoute component={GrantsCalendar} /></Route>
          <Route path="/reporting-deadlines"><ProtectedRoute component={ReportingDeadlines} /></Route>
          <Route path="/grant-leads"><ProtectedRoute component={GrantLeads} /></Route>
          <Route path="/email-intelligence"><ProtectedRoute component={EmailIntelligence} /></Route>
          <Route path="/email-tracking"><ProtectedRoute component={EmailTracking} /></Route>
          <Route path="/fundable-projects"><ProtectedRoute component={FundableProjects} /></Route>
          <Route path="/campaigns"><ProtectedRoute component={Campaigns} /></Route>
          <Route path="/settings"><ProtectedRoute component={Settings} /></Route>
          <Route path="/admin"><ProtectedRoute component={Admin} /></Route>
          <Route path="/admin/feedback"><ProtectedRoute component={AdminFeedback} /></Route>
          <Route path="/audit-log"><ProtectedRoute component={AuditLog} /></Route>
          <Route path="/potential-duplicates"><ProtectedRoute component={PotentialDuplicates} /></Route>
          <Route path="/revenue-extractor"><ProtectedRoute component={RevenueExtractor} /></Route>
          <Route path="/financial-corrections"><Redirect to="/reconciliation/deposits" /></Route>
          <Route path="/cleanup-queue"><ProtectedRoute component={CleanupQueue} /></Route>
          <Route path="/restriction-text-review"><ProtectedRoute component={RestrictionTextReview} /></Route>
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
