import "./_group.css";
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
  AffiliationRow,
  CardAction,
} from "./_shared/parts";

export function FunderRecord() {
  return (
    <RecordShell
      backLabel="Back to funders"
      title="Walton Family Foundation"
      typeBadge="Family foundation"
      subtitle="waltonfamilyfoundation.org · Bentonville, AR"
      highlights={[
        { label: "Priority", value: <Badge tone="primary">Top</Badge>, accent: true },
        { label: "Capacity", value: "$1M+" },
        { label: "Lifetime giving", value: "$4.25M", accent: true },
        { label: "Open opportunities", value: "3" },
        { label: "Last contacted", value: "May 18, 2026" },
      ]}
      left={
        <>
          <FieldCard title="Status">
            <FieldRow label="Active">
              <Badge tone="primary">Active</Badge>
            </FieldRow>
            <FieldRow label="Connection">Connected</FieldRow>
            <FieldRow label="Enthusiasm">Advocate</FieldRow>
            <FieldRow label="Strategic alignment">High</FieldRow>
            <FieldRow label="National priorities">Yes</FieldRow>
          </FieldCard>

          <FieldCard title="Organization">
            <FieldRow label="Subtype">Family foundation</FieldRow>
            <FieldRow label="Employees">251–1,000</FieldRow>
            <FieldRow label="Capacity">$1M+</FieldRow>
            <FieldRow label="Makes PRIs">Yes</FieldRow>
            <FieldRow label="Owner">Kayla Drennen</FieldRow>
          </FieldCard>

          <FieldCard title="Web">
            <FieldRow label="Website">
              <span className="rr-text-primary">waltonfamilyfoundation.org</span>
            </FieldRow>
            <FieldRow label="Email">grants@wff.org</FieldRow>
            <FieldRow label="LinkedIn">
              <span className="rr-text-primary">@waltonfamilyfdn</span>
            </FieldRow>
          </FieldCard>

          <FieldCard title="Interests" defaultOpen={false}>
            <TagRow label="Thematic" tags={["Education", "K-12", "Charter"]} />
            <TagRow label="Ages" tags={["Early childhood", "Elementary"]} />
            <TagRow label="Regions" tags={["Southeast", "National"]} />
          </FieldCard>

          <FieldCard title="Other details" defaultOpen={false}>
            <FieldRow label="Other names">WFF</FieldRow>
            <TagRow label="Historical names" tags={["Walton Foundation"]} />
            <div>
              <div className="rr-text-muted mb-1 text-xs font-medium">Details</div>
              <p className="rr-text-muted">
                Multi-year education portfolio. Prefers concept memo before full
                proposal. Program officer rotates each cycle.
              </p>
            </div>
          </FieldCard>
        </>
      }
      center={
        <div className="space-y-3">
          <ActivityComposer />
          <FilterChips
            active="All"
            chips={[
              { label: "All", count: 42 },
              { label: "Notes", count: 14 },
              { label: "Email", count: 19 },
              { label: "Calendar", count: 5 },
              { label: "Meetings", count: 3 },
              { label: "Intel", count: 1 },
            ]}
          />
          <ActivityCard highlights={[]}>
            <FeedItem
              kind="intel"
              when="May 22, 2026, 9:04 AM"
              title="New RFP: Rural Education Innovation — up to $2M"
              meta="Matched from grants@wff.org newsletter"
            />
            <FeedItem
              kind="note"
              when="May 18, 2026, 2:30 PM"
              title="Concept memo well received"
              body="PO confirmed alignment with their FY27 K-12 strategy. Wants a 2-page concept by mid-June, full proposal in Q3."
            />
            <FeedItem
              kind="email"
              when="May 17, 2026, 11:12 AM"
              title="Re: Wildflower FY27 partnership"
              meta="program.officer@wff.org → kayla@wildflowerschools.org"
              body="Thanks for the update — let's find time to discuss the renewal."
              attachment
            />
            <FeedItem
              kind="meeting"
              when="May 9, 2026, 10:00 AM"
              title="Quarterly check-in"
              meta="45 min · Video call"
              body="Reviewed grant outcomes; strong interest in expanding to two new regions."
            />
            <FeedItem
              kind="calendar"
              when="Jun 14, 2026, 3:00 PM"
              title="Concept memo review (upcoming)"
              meta="kayla@wildflowerschools.org, program.officer@wff.org"
            />
          </ActivityCard>
        </div>
      }
      right={
        <>
          <RelatedCard
            title="People"
            count={4}
            action={<CardAction label="New" />}
          >
            <AffiliationRow
              name="Dana Whitfield"
              role="Program Officer"
              status="active"
              primary
            />
            <AffiliationRow
              name="Marcus Lee"
              role="Grants Manager"
              status="active"
            />
            <AffiliationRow
              name="Alice Walton"
              role="Board chair · principal"
              status="active"
            />
            <AffiliationRow
              name="Greg Penner"
              role="Former trustee"
              status="past"
            />
          </RelatedCard>

          <RelatedCard
            title="Organizations"
            count={4}
            action={<CardAction label="New" />}
          >
            <AffiliationRow
              name="Walton Enterprises"
              role="Parent entity"
              status="active"
              primary
            />
            <AffiliationRow
              name="Walton Family Charitable Support Foundation"
              role="Sister foundation"
              status="active"
            />
            <AffiliationRow
              name="Fidelity Charitable"
              role="Payment intermediary"
              status="active"
            />
            <AffiliationRow
              name="Walmart Foundation"
              role="Former co-funder"
              status="past"
            />
          </RelatedCard>

          <RelatedCard title="Open opportunities" count={3}>
            <RelatedRow name="FY27 K-12 renewal" sub="Cultivation" amount="$2.0M" tone="primary" />
            <RelatedRow name="Rural innovation RFP" sub="Identified" amount="$2.0M" tone="primary" />
            <RelatedRow name="Capacity-building PRI" sub="Solicitation" amount="$500K" tone="primary" />
          </RelatedCard>

          <RelatedCard title="Pledges" count={2}>
            <RelatedRow name="FY26 General operating" sub="Committed · Sep 2025" amount="$1.5M" tone="primary" />
            <RelatedRow name="FY24 Regional expansion" sub="Fulfilled" amount="$1.0M" tone="primary" />
          </RelatedCard>

          <RelatedCard title="Gifts & payments" count={8} defaultOpen={false}>
            <RelatedRow name="Payment 6 of 6" sub="Mar 15, 2026" amount="$250K" />
            <RelatedRow name="Payment 5 of 6" sub="Dec 15, 2025" amount="$250K" />
            <RelatedRow name="Payment 4 of 6" sub="Sep 15, 2025" amount="$250K" />
          </RelatedCard>
        </>
      }
    />
  );
}
