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
import { Activity, Heart, Signal, MapPin, Globe, Linkedin, Mail, Phone } from "lucide-react";

export function IndividualRecord() {
  return (
    <RecordShell
      backLabel="Back to individuals"
      title="Eleanor Whitcomb"
      typeBadge="Individual"
      subtitle={<><MapPin className="h-3.5 w-3.5 text-slate-400" /> Greenwich, CT</>}
      highlights={[
        { label: "Priority", value: <Badge tone="primary">High</Badge>, accent: true },
        { label: "Capacity", value: "$100K–$250K" },
        { label: "Lifetime giving", value: "$185K", accent: true },
        { label: "Open opportunities", value: "1" },
        { label: "Last contacted", value: "May 20, 2026" },
      ]}
      left={
        <>
          <FieldCard title="Identity & Engagement">
            <div className="mb-4">
              <AttributeBadges attributes={[
                { label: "Status", value: "Active", tone: "success" },
                { label: "Connection", value: "Connected", icon: Signal, tone: "secondary" },
                { label: "Enthusiasm", value: "Advocate", icon: Heart, tone: "secondary" }
              ]} />
            </div>

            <FieldRow label="Pronouns">she/her</FieldRow>
            <FieldRow label="Household">
              <span className="rr-text-primary font-semibold underline decoration-slate-200 underline-offset-4 cursor-pointer">Whitcomb Family</span>
            </FieldRow>
            <FieldRow label="Owner">Kayla Drennen</FieldRow>

            <div className="pt-2">
              <ContactIconRow 
                contacts={[
                  { icon: Mail, label: "Email", value: "eleanor@ewhitcomb.com" },
                  { icon: Phone, label: "Mobile", value: "(203) 555-0148" },
                  { icon: Globe, label: "Website", value: "ewhitcomb.com", href: "#" },
                  { icon: Linkedin, label: "LinkedIn", value: "@eleanorwhitcomb", href: "#" }
                ]}
              />
            </div>
          </FieldCard>

          <FieldCard title="Interests">
            <TagRow label="Thematic" tags={["Education equity", "Montessori"]} />
            <TagRow label="Ages" tags={["Early childhood"]} />
            <TagRow label="Regions" tags={["Northeast"]} />
          </FieldCard>

          <FieldCard title="More details" defaultOpen={false} className="opacity-80 hover:opacity-100 transition-opacity">
            <FieldRow label="Capacity">$100K–$250K</FieldRow>
            <FieldRow label="Full Address">14 Field Point Rd<br/>Greenwich, CT 06830</FieldRow>
          </FieldCard>
        </>
      }
      center={
        <div className="space-y-4">
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
          <ActivityCard>
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
          <RelatedCard
            title="People"
            count={3}
            action={<CardAction label="New" />}
          >
            <AffiliationRow
              name="James Whitcomb"
              role="Spouse · Whitcomb household"
              status="active"
              primary
            />
            <AffiliationRow
              name="Margaret Chen"
              role="Wealth advisor"
              status="active"
            />
            <AffiliationRow
              name="Robert Hale"
              role="Colleague · Meridian Capital"
              status="active"
            />
          </RelatedCard>

          <RelatedCard
            title="Organizations"
            count={4}
            action={<CardAction label="New" />}
          >
            <AffiliationRow
              name="Whitcomb Foundation"
              role="Trustee"
              status="active"
              primary
            />
            <AffiliationRow
              name="Meridian Capital"
              role="Managing Partner"
              status="active"
            />
            <AffiliationRow
              name="Fidelity Charitable"
              role="Payment intermediary"
              status="active"
            />
            <AffiliationRow
              name="Greenwich Academy"
              role="Former board chair"
              status="past"
            />
          </RelatedCard>

          <RelatedCard title="Giving & Pipeline" action={<CardAction label="Add" />}>
            <GivingSection title="Open Asks">
              <GivingRow name="FY27 3-year leadership pledge" date="Expected Oct 2026" stage="Cultivation" amount="$150K" tone="primary" />
            </GivingSection>
            
            <GivingSection title="Active Pledges">
              <GivingRow name="FY26 Leadership gift" date="Committed Oct 2025" stage="Paying" amount="$150K" tone="warning" />
              <GivingRow name="Payment 2 of 2" date="Expected Apr 2026" stage="Scheduled" amount="$75K" isChild tone="muted" />
              <GivingRow name="Payment 1 of 2" date="Oct 12, 2025" stage="Paid" amount="$75K" isChild tone="success" />
            </GivingSection>

            <GivingSection title="Past Giving">
              <GivingRow name="FY25 annual gift" date="Nov 30, 2024" stage="Fulfilled" amount="$50K" tone="success" />
              <GivingRow name="Gala paddle raise" date="May 4, 2024" stage="Fulfilled" amount="$25K" tone="success" />
            </GivingSection>
          </RelatedCard>
        </>
      }
    />
  );
}
