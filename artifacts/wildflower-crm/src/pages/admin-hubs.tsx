import { useIsAdmin } from "@/hooks/use-is-admin";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import AdminFeedback from "@/pages/admin-feedback";
import CleanupQueuePage from "@/pages/cleanup-queue";
import FutureFunctionality from "@/pages/future-functionality";
import PotentialDuplicatesPage from "@/pages/potential-duplicates";
import RestrictionTextReviewPage from "@/pages/restriction-text-review";

function requestedTab(fallback: string, allowed: readonly string[]): string {
  const requested = new URLSearchParams(window.location.search).get("tab");
  return requested && allowed.includes(requested) ? requested : fallback;
}

export function DataCleanupHub() {
  const isAdmin = useIsAdmin();
  const allowed = isAdmin
    ? ["cleanup-queue", "potential-duplicates", "restriction-text-review"]
    : ["cleanup-queue"];

  return (
    <Tabs
      defaultValue={requestedTab("cleanup-queue", allowed)}
      className="space-y-6"
    >
      <TabsList className="flex h-auto flex-wrap justify-start gap-1">
        <TabsTrigger value="cleanup-queue">Cleanup Queue</TabsTrigger>
        {isAdmin && (
          <>
            <TabsTrigger value="potential-duplicates">
              Potential Duplicates
            </TabsTrigger>
            <TabsTrigger value="restriction-text-review">
              Restriction Text Review
            </TabsTrigger>
          </>
        )}
      </TabsList>

      <TabsContent value="cleanup-queue">
        <CleanupQueuePage />
      </TabsContent>
      {isAdmin && (
        <>
          <TabsContent value="potential-duplicates">
            <PotentialDuplicatesPage />
          </TabsContent>
          <TabsContent value="restriction-text-review">
            <RestrictionTextReviewPage />
          </TabsContent>
        </>
      )}
    </Tabs>
  );
}

export function AppImprovementsHub() {
  const isAdmin = useIsAdmin();
  if (!isAdmin) {
    return <p role="alert">Only admins can review app improvements.</p>;
  }

  const allowed = ["feedback", "future-functionality"] as const;
  return (
    <Tabs
      defaultValue={requestedTab("feedback", allowed)}
      className="space-y-6"
    >
      <TabsList className="flex h-auto flex-wrap justify-start gap-1">
        <TabsTrigger value="feedback">Feedback Queue</TabsTrigger>
        <TabsTrigger value="future-functionality">
          Future Functionality
        </TabsTrigger>
      </TabsList>

      <TabsContent value="feedback">
        <AdminFeedback />
      </TabsContent>
      <TabsContent value="future-functionality">
        <FutureFunctionality />
      </TabsContent>
    </Tabs>
  );
}
