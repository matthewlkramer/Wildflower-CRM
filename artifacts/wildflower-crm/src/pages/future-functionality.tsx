import { Link } from "wouter";
import { CheckCircle2, Lightbulb } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useIsAdmin } from "@/hooks/use-is-admin";

type Possibility = {
  title: string;
  description: string;
  cleanupQueue?: boolean;
};

type PossibilityGroup = {
  title: string;
  description: string;
  items: Possibility[];
};

const POSSIBILITY_GROUPS: PossibilityGroup[] = [
  {
    title: "Fundraising and relationships",
    description: "Ideas that could help fundraisers manage relationships and day-to-day work.",
    items: [
      {
        title: "Relationship attention indicators",
        description:
          "Show important relationships that may need attention and explain the supporting signals.",
      },
      {
        title: "Mobile meeting experience",
        description:
          "Optimize meeting preparation, live notes, paper-note photos, tasks, and follow-up for phones.",
      },
      {
        title: "Opportunity workflow simplification",
        description:
          "Make asks, stages, expected amounts, timing, next actions, and conflicting information easier to understand.",
      },
      {
        title: "Cultivation sequences",
        description:
          "Offer reminder-based outreach plans that pause or adjust when a donor responds.",
      },
      {
        title: "Relationship mapping",
        description:
          "Help staff identify who at Wildflower may know a person connected with a prospective funder.",
      },
      {
        title: "Prospect and funder research",
        description:
          "Gather and summarize useful public information with links to the supporting evidence.",
      },
      {
        title: "Batch gift entry",
        description:
          "Enter and validate multiple checks or gifts in one workflow.",
      },
      {
        title: "Email composition inside the CRM",
        description:
          "Draft and log donor messages inside the CRM instead of relying on a mailto link.",
      },
    ],
  },
  {
    title: "Forecasting and reporting",
    description: "Ideas for longer-term planning, analysis, and access to information.",
    items: [
      {
        title: "Forecast scenarios and targets",
        description:
          "Compare conservative, likely, and ambitious funding outcomes with fundraising goals.",
      },
      {
        title: "Forecast accuracy tracking",
        description:
          "Preserve earlier forecasts and compare them with what was eventually received.",
      },
      {
        title: "Donor concentration analysis",
        description:
          "Show how much projected or received funding depends on a small number of donors.",
      },
      {
        title: "Flexible reports and dashboards",
        description:
          "Let staff assemble and save additional reporting views without a software release.",
      },
      {
        title: "Broader Ask the CRM assistant",
        description:
          "Answer questions across donor history, opportunities, gifts, meetings, and communications.",
      },
    ],
  },
  {
    title: "Data, marketing, and administration",
    description: "Ideas for historical cleanup, connected systems, and administrative flexibility.",
    items: [
      {
        title: "Historical newsletter evidence backfill",
        description:
          "Collect older consent and opt-out evidence from Fillout, Flodesk, and Mailchimp.",
        cleanupQueue: true,
      },
      {
        title: "Historical donation coding",
        description:
          "Apply reviewed coding decisions from the historical donation worksheet.",
        cleanupQueue: true,
      },
      {
        title: "Marketing attribution and integration monitoring",
        description:
          "Connect campaigns with gifts and surface failed Donorbox, Stripe, or newsletter handoffs.",
      },
      {
        title: "Address standardization",
        description:
          "Identify outdated, incomplete, or duplicate postal addresses.",
      },
      {
        title: "Custom-field administration",
        description:
          "Allow a limited set of new fields to be configured without a software release.",
      },
      {
        title: "Financial controls and security review",
        description:
          "Review permissions, approvals, audit trails, corrections, backups, and separation of duties.",
      },
    ],
  },
];

export default function FutureFunctionality() {
  const isAdmin = useIsAdmin();

  if (!isAdmin) {
    return (
      <Card className="max-w-xl">
        <CardContent className="pt-6">
          <p className="font-medium">Admin access required</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Only administrators can view future functionality possibilities.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-3xl font-serif font-bold">
          <Lightbulb className="h-7 w-7 text-primary" />
          Future functionality possibilities
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Ideas we may revisit later. None of these is critical, approved, or
          scheduled. An idea should become active work only when a clear need and
          expected outcome justify it.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <CheckCircle2 className="h-5 w-5 text-primary" />
            Already available
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm md:grid-cols-2">
          <div>
            <p className="font-medium">Saved and shareable views</p>
            <p className="mt-1 text-muted-foreground">
              Available for Individuals, Organizations, Payment Intermediaries,
              Opportunities, and Gifts.
            </p>
          </div>
          <div>
            <p className="font-medium">Bulk actions</p>
            <p className="mt-1 text-muted-foreground">
              Bulk editing is available for Individuals, Organizations,
              Opportunities, Gifts, and the grants calendar. Additional actions
              can be considered when a specific need arises.
            </p>
          </div>
        </CardContent>
      </Card>

      {POSSIBILITY_GROUPS.map((group) => (
        <Card key={group.title}>
          <CardHeader>
            <CardTitle className="text-xl">{group.title}</CardTitle>
            <p className="text-sm text-muted-foreground">{group.description}</p>
          </CardHeader>
          <CardContent>
            <div className="divide-y rounded-lg border">
              {group.items.map((item) => (
                <div
                  key={item.title}
                  className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div>
                    <p className="font-medium">{item.title}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {item.description}
                    </p>
                    {item.cleanupQueue ? (
                      <Link
                        href="/cleanup-queue"
                        className="mt-2 inline-block text-sm text-primary hover:underline"
                      >
                        Also tracked in the Cleanup Queue
                      </Link>
                    ) : null}
                  </div>
                  <Badge variant="outline" className="w-fit shrink-0">
                    Not prioritized
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
