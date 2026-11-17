import { useLocation, useSearch } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import GrantsCalendar from "@/pages/grants-calendar";
import ReportingDeadlines from "@/pages/reporting-deadlines";

export default function Deadlines() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const tab = new URLSearchParams(search).get("tab") === "reporting"
    ? "reporting"
    : "applications";

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-serif font-bold">Deadlines</h1>
      <Tabs
        value={tab}
        activationMode="manual"
        onValueChange={(value) => navigate(value === "reporting" ? "/deadlines?tab=reporting" : "/deadlines")}
      >
        <TabsList aria-label="Deadline types" className="flex h-auto flex-wrap justify-start gap-1">
          <TabsTrigger value="applications">Applications &amp; closes</TabsTrigger>
          <TabsTrigger value="reporting">Donor reporting</TabsTrigger>
        </TabsList>
        <TabsContent value="applications">
          <GrantsCalendar />
        </TabsContent>
        <TabsContent value="reporting">
          <ReportingDeadlines />
        </TabsContent>
      </Tabs>
    </div>
  );
}
