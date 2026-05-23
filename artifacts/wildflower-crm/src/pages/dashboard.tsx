import { Link } from "wouter";
import {
  useListPeople,
  useListFunders,
  useListHouseholds,
  useListOpportunitiesAndPledges,
  useListGiftsAndPayments,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const COUNT_QUERY: { limit: number; page: number } = { limit: 1, page: 1 };

export default function Dashboard() {
  const people = useListPeople(COUNT_QUERY);
  const funders = useListFunders(COUNT_QUERY);
  const households = useListHouseholds(COUNT_QUERY);
  const opps = useListOpportunitiesAndPledges(COUNT_QUERY);
  const wonOpps = useListOpportunitiesAndPledges({ ...COUNT_QUERY, status: "won" });
  const openOpps = useListOpportunitiesAndPledges({ ...COUNT_QUERY, status: "open" });
  const gifts = useListGiftsAndPayments(COUNT_QUERY);

  const tiles = [
    { label: "People", value: people.data?.pagination.total, href: "/individuals", testId: "tile-people" },
    { label: "Funding entities", value: funders.data?.pagination.total, href: "/funding-entities", testId: "tile-funders" },
    { label: "Households", value: households.data?.pagination.total, href: "/households", testId: "tile-households" },
    { label: "Opportunities", value: opps.data?.pagination.total, href: "/opportunities", testId: "tile-opps" },
    { label: "Pledges (won)", value: wonOpps.data?.pagination.total, href: "/pledges", testId: "tile-pledges" },
    { label: "Open opportunities", value: openOpps.data?.pagination.total, href: "/opportunities", testId: "tile-open-opps" },
    { label: "Gifts & payments", value: gifts.data?.pagination.total, href: "/gifts", testId: "tile-gifts" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">
          A quick snapshot of the CRM.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {tiles.map((t) => (
          <Link key={t.label} href={t.href} data-testid={t.testId}>
            <Card className="cursor-pointer hover:bg-muted/30 transition-colors h-full">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {t.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-serif font-bold text-foreground">
                  {t.value === undefined ? "…" : t.value.toLocaleString()}
                </p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link href="/projections">
          <Card className="cursor-pointer hover:bg-muted/30 transition-colors h-full">
            <CardHeader><CardTitle className="text-lg">Projections</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Expected revenue from open opportunities, grouped by quarter.
            </CardContent>
          </Card>
        </Link>
        <Link href="/grants-calendar">
          <Card className="cursor-pointer hover:bg-muted/30 transition-colors h-full">
            <CardHeader><CardTitle className="text-lg">Grants calendar</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Upcoming application deadlines and projected close dates.
            </CardContent>
          </Card>
        </Link>
        <Link href="/moves">
          <Card className="cursor-pointer hover:bg-muted/30 transition-colors h-full">
            <CardHeader><CardTitle className="text-lg">Moves</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              People who haven't been contacted recently.
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
