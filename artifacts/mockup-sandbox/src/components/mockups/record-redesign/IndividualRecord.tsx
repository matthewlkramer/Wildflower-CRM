import "./_group.css";
// Individual donor record — 3-lane Copper-style redesign mockup.
import {
  RecordShell,
  FieldCard,
  FieldRow,
  Badge,
  TagRow,
  ActivityComposer,
  FilterChips,
  ActivityCard,
  FeedItem,
  RelatedCard,
  RelatedRow,
} from "./_shared/parts";

export function IndividualRecord() {
  return (
    <RecordShell
      backLabel="Back to individuals"
      title="Eleanor Whitcomb"
      typeBadge="Individual"
      subtitle="Greenwich, CT"
      highlights={[
        { label: "Priority", value: <Badge tone="primary">High</Badge>, accent: true },
        { label: "Capacity", value: "$100K–$250K" },
        { label: "Lifetime giving", value: "$185K", accent: true },
        { label: "Open opportunities", value: "1" },
        { label: "Last contacted", value: "May 20, 2026" },
      ]}
      left={
        <>
          <FieldCard title="Basics">
            <FieldRow label="Full name">Eleanor Whitcomb</FieldRow>
            <FieldRow label="Pronouns">she/her</FieldRow>
            <FieldRow label="Household">
              <span className="rr-text-primary">Whitcomb Family</span>
            </FieldRow>
            <FieldRow label="Owner">Kayla Drennen</FieldRow>
          </FieldCard>

          <FieldCard title="Engagement">
            <FieldRow label="Status">
              <Badge tone="primary">Active</Badge>
            </FieldRow>
            <FieldRow label="Connection">Connected</FieldRow>
            <FieldRow label="Enthusiasm">Advocate</FieldRow>
            <FieldRow label="Capacity">$100K–$250K</FieldRow>
          </FieldCard>

          <FieldCard title="Web">
            <FieldRow label="LinkedIn">
              <span className="rr-text-primary">@eleanorwhitcomb</span>
            </FieldRow>
            <FieldRow label="Website">ewhitcomb.com</FieldRow>
          </FieldCard>

          <FieldCard title="Interests" defaultOpen={false}>
            <TagRow label="Thematic" tags={["Education equity", "Montessori"]} />
            <TagRow label="Ages" tags={["Early childhood"]} />
            <TagRow label="Regions" tags={["Northeast"]} />
          </FieldCard>

          <FieldCard title="Affiliations" defaultOpen={false}>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">
                  Trustee @{" "}
                  <span className="rr-text-primary">Whitcomb Foundation</span>
                </span>
                <span className="rr-text-muted text-xs">current · primary</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">Partner @ Meridian Capital</span>
                <span className="rr-text-muted text-xs">current</span>
              </div>
            </div>
          </FieldCard>

          <FieldCard title="Contact info" defaultOpen={false}>
            <FieldRow label="Email">eleanor@ewhitcomb.com</FieldRow>
            <FieldRow label="Phone">(203) 555-0148</FieldRow>
            <FieldRow label="Address">14 Field Point Rd, Greenwich, CT</FieldRow>
          </FieldCard>
        </>
      }
      center={
        <div className="space-y-3">
          <ActivityComposer />
          <FilterChips
            active="All"
            chips={[
              { label: "All", count: 31 },
              { label: "Notes", count: 11 },
              { label: "Email", count: 14 },
              { label: "Calendar", count: 3 },
              { label: "Meetings", count: 2 },
              { label: "Intel", count: 1 },
            ]}
          />
          <ActivityCard highlights={[]}>
            <FeedItem
              kind="note"
              when="May 20, 2026, 4:15 PM"
              title="Coffee with Eleanor — strong board interest"
              body="Wants to deepen involvement. Open to a 3-year leadership pledge if matched with a board seat. Follow up with formal invitation."
            />
            <FeedItem
              kind="intel"
              when="May 19, 2026, 8:40 AM"
              title="LinkedIn job change — now Managing Partner"
              meta="Capacity signal: promotion at Meridian Capital"
            />
            <FeedItem
              kind="email"
              when="May 15, 2026, 9:55 AM"
              title="Re: Spring gala + board conversation"
              meta="eleanor@ewhitcomb.com → kayla@wildflowerschools.org"
              body="Loved the visit. Let's talk about how I can do more."
            />
            <FeedItem
              kind="call"
              when="May 6, 2026, 1:00 PM"
              title="Stewardship call"
              meta="20 min · Phone call"
              body="Thanked her for the FY26 gift; she asked about regional expansion plans."
            />
            <FeedItem
              kind="meeting"
              when="Apr 28, 2026, 5:30 PM"
              title="School site visit — Cambridge"
              meta="Meeting"
              body="Toured the classroom, met two guides. Visibly moved by the student work."
              privateFlag
            />
          </ActivityCard>
        </div>
      }
      right={
        <>
          <RelatedCard title="Pledges" count={1}>
            <RelatedRow name="FY26 Leadership gift" sub="Committed · Oct 2025" amount="$75K" tone="primary" />
          </RelatedCard>

          <RelatedCard title="Open opportunities" count={1}>
            <RelatedRow name="FY27 3-year leadership pledge" sub="Cultivation" amount="$150K" tone="primary" />
          </RelatedCard>

          <RelatedCard title="Gifts & payments" count={5} defaultOpen={false}>
            <RelatedRow name="FY26 pledge payment" sub="Oct 12, 2025" amount="$75K" />
            <RelatedRow name="FY25 annual gift" sub="Nov 30, 2024" amount="$50K" />
            <RelatedRow name="Gala paddle raise" sub="May 4, 2024" amount="$25K" />
          </RelatedCard>

          <RelatedCard title="Household" count={3} defaultOpen={false}>
            <RelatedRow name="Whitcomb Family" sub="Joint account · primary" tone="primary" />
            <RelatedRow name="James Whitcomb" sub="Spouse" tone="primary" />
          </RelatedCard>
        </>
      }
    />
  );
}
