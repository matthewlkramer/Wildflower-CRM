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
  AffiliationRow,
  CardAction,
  AttributeBadges,
  ContactIconRow,
  GivingSection,
  GivingRow
} from "./_shared/parts";
import { Activity, Heart, Signal, MapPin, Globe, Linkedin, Mail } from "lucide-react";

export function FunderRecord() {
  return (
    <RecordShell
      backLabel="Back to funders"
      title="Walton Family Foundation"
      typeBadge="Family foundation"
      subtitle={<><MapPin className="h-3.5 w-3.5 text-slate-400" /> Bentonville, AR</>}
      highlights={[
        { label: "Priority", value: <Badge tone="primary">Top</Badge>, accent: true },
        { label: "Capacity", value: "$1M+" },
        { label: "Lifetime giving", value: "$4.25M", accent: true },
        { label: "Open opportunities", value: "3" },
        { label: "Last contacted", value: "May 18, 2026" },
      ]}
      left={
        <>
          <FieldCard title="Identity & Engagement">
            <div className="mb-4">
              <AttributeBadges attributes={[
                { label: "Status", value: "Active", tone: "success" },
                { label: "Connection", value: "Connected", icon: Signal, tone: "secondary" },
                { label: "Enthusiasm", value: "Advocate", icon: Heart, tone: "secondary" },
                { label: "Strategic alignment", value: "High", icon: Activity, tone: "secondary" }
              ]} />
            </div>
            
            <FieldRow label="Subtype">Family foundation</FieldRow>
            <FieldRow label="Owner">Kayla Drennen</FieldRow>
            <FieldRow label="National priorities">Yes</FieldRow>

            <div className="pt-2">
              <ContactIconRow 
                demoOpenIndex={0}
                contacts={[
                  { icon: Mail, label: "Email", value: "grants@wff.org" },
                  { icon: Globe, label: "Website", value: "waltonfamilyfoundation.org", href: "#" },
                  { icon: Linkedin, label: "LinkedIn", value: "@waltonfamilyfdn", href: "#" }
                ]}
              />
            </div>
          </FieldCard>

          <FieldCard title="Interests">
            <TagRow label="Thematic" tags={["Education", "K-12", "Charter"]} />
            <TagRow label="Ages" tags={["Early childhood", "Elementary"]} />
            <TagRow label="Regions" tags={["Southeast", "National"]} />
          </FieldCard>

          <FieldCard title="More details" defaultOpen={false} className="opacity-80 hover:opacity-100 transition-opacity">
            <FieldRow label="Employees">251–1,000</FieldRow>
            <FieldRow label="Makes PRIs">Yes</FieldRow>
            <FieldRow label="Other names">WFF</FieldRow>
            <TagRow label="Historical names" tags={["Walton Foundation"]} />
            <div className="pt-2">
              <div className="rr-text-muted mb-1 text-xs font-medium">Internal Notes</div>
              <p className="text-slate-600 text-sm leading-relaxed bg-slate-50 p-3 rounded-lg border border-slate-100">
                Multi-year education portfolio. Prefers concept memo before full
                proposal. Program officer rotates each cycle.
              </p>
            </div>
          </FieldCard>
        </>
      }
      center={
        <div className="space-y-4">
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
          <ActivityCard>
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

          <RelatedCard title="Giving & Pipeline" action={<CardAction label="Add" />}>
            <GivingSection title="Open Asks">
              <GivingRow name="FY27 K-12 renewal" date="Expected Nov 2026" stage="Cultivation" amount="$2.0M" tone="primary" />
              <GivingRow name="Rural innovation RFP" date="Deadline Aug 2026" stage="Identified" amount="$2.0M" tone="primary" />
              <GivingRow name="Capacity-building PRI" date="Expected Jan 2027" stage="Solicitation" amount="$500K" tone="primary" />
            </GivingSection>
            
            <GivingSection title="Active Pledges">
              <GivingRow name="FY26 General operating" date="Committed Sep 2025" stage="Paying" amount="$1.5M" tone="warning" />
              <GivingRow name="Payment 6 of 6" date="Mar 15, 2026" stage="Scheduled" amount="$250K" isChild tone="muted" />
              <GivingRow name="Payment 5 of 6" date="Dec 15, 2025" stage="Paid" amount="$250K" isChild tone="success" />
              
              <GivingRow name="FY24 Regional expansion" date="Committed Nov 2023" stage="Fulfilled" amount="$1.0M" tone="success" />
            </GivingSection>
          </RelatedCard>
        </>
      }
    />
  );
}
