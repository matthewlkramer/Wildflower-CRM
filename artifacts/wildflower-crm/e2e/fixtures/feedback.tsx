// Synthetic browser fixture; it never authenticates or connects to a real CRM database.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Layout from "../../src/components/layout";
import MeetingsPage from "../../src/pages/meetings";
import { EntityFilterProvider } from "../../src/lib/entity-filter-context";
import {
  DashboardCardSettings,
  useDashboardCards,
} from "../../src/components/dashboard-card-settings";
import { MeetingNextStepsProposalDialog } from "../../src/components/meeting-notes-panel";
import { RecordConferenceAttendance } from "../../src/components/conferences/record-attendance";
import { EditNoteDialog } from "../../src/components/notes-panel";
import { LogInteractionDialog } from "../../src/components/log-interaction-dialog";
import {
  EmailsEditor,
  PhoneNumbersEditor,
  AddressesEditor,
} from "../../src/components/contact-info-editor";
import "../../src/index.css";
function Fixture() {
  const settings = useDashboardCards("synthetic-user");
  const [open, setOpen] = useState(false);
  return (
    <Layout>
      <DashboardCardSettings userId="synthetic-user" {...settings} />
      <MeetingsPage />
      <section className="space-y-4 mt-4" aria-label="Record actions">
        <RecordConferenceAttendance personId="synthetic-person" />
        <EditNoteDialog
          note={{
            id: "synthetic-note",
            body: "Original note",
            authorUserId: "synthetic-user",
            createdAt: "2026-10-01T12:00:00Z",
            updatedAt: "2026-10-01T12:00:00Z",
          }}
        />
        <LogInteractionDialog
          compact
          interaction={{
            id: "synthetic-interaction",
            kind: "phone_call",
            summary: "Original call",
            personIds: ["synthetic-person"],
            occurredAt: "2026-10-01T12:00:00Z",
            createdAt: "2026-10-01T12:00:00Z",
            updatedAt: "2026-10-01T12:00:00Z",
          }}
        />
        <EmailsEditor
          owner={{ kind: "person", id: "synthetic-person" }}
          emails={[]}
        />
        <PhoneNumbersEditor
          owner={{ kind: "person", id: "synthetic-person" }}
          phoneNumbers={[]}
        />
        <AddressesEditor
          owner={{ kind: "person", id: "synthetic-person" }}
          addresses={[]}
        />
        <button onClick={() => setOpen(true)}>Review task proposals</button>
        <MeetingNextStepsProposalDialog
          open={open}
          onOpenChange={setOpen}
          onConfirm={async () => setOpen(false)}
          proposals={[
            {
              title:
                "Send Robin the detailed school budget and follow up on the requested introduction after the meeting",
              description: null,
              assigneeName: null,
              assigneeUserId: null,
              assignmentDate: "2026-10-13",
              dueDate: null,
            },
          ]}
        />
      </section>
    </Layout>
  );
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    <EntityFilterProvider>
      <Fixture />
    </EntityFilterProvider>
  </QueryClientProvider>,
);
