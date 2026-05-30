import { useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import {
  useGetPerson,
  useUpdatePerson,
  useDeletePerson,
  getGetPersonQueryKey,
  getListPeopleQueryKey,
  type PersonDetail,
  type UpdatePersonBody,
  type Pronouns,
  type ConnectionStatus,
  type Enthusiasm,
  type Priority,
} from "@workspace/api-client-react";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import {
  EmailsEditor,
  PhoneNumbersEditor,
} from "@/components/contact-info-editor";
import { ActivityTimeline } from "@/components/activity-timeline";
import { NotesPanel } from "@/components/notes-panel";
import { TasksPanel } from "@/components/tasks-panel";
import {
  LinkedGiftsCard,
  LinkedOpportunitiesCard,
} from "@/components/linked-records";
import {
  RecordLayout,
  FieldCard,
  RelatedCard,
  type Highlight,
} from "@/components/record-layout";
import {
  InlineEditBoolean,
  InlineEditSelect,
  InlineEditText,
  InlineEditTextarea,
  type InlineSelectOption,
} from "@/components/inline-edit";
import { InlineEditUserPicker, useUserNameMap } from "@/components/user-picker";
import { InlineEditRegionPicker, useRegionNameMap } from "@/components/region-picker";
import {
  useFunderName,
  useHouseholdName,
  useIntermediaryName,
  useOrganizationName,
} from "@/components/entity-picker";
import type { PeopleEntityRole } from "@workspace/api-client-react";
import {
  InlineEditInterestsThematic,
  InlineEditInterestsAges,
  InlineEditInterestsGovModels,
  InlineEditMultiRegionPicker,
} from "@/components/multi-select-picker";
import { useQueryClient } from "@tanstack/react-query";
import {
  formatCapacity,
  formatDate,
  formatEnum,
  formatFunderNameShort,
  formatFacebookHandle,
  formatInstagramHandle,
  formatLinkedinHandle,
  formatXHandle,
} from "@/lib/format";

const PRONOUNS_OPTIONS = [
  { value: "he_him_his", label: "he / him / his" },
  { value: "she_her_hers", label: "she / her / hers" },
  { value: "they_them_theirs", label: "they / them / theirs" },
  { value: "other", label: "Other" },
] as const satisfies ReadonlyArray<InlineSelectOption<Pronouns>>;

// Same enum used on funders (see funding-entity-detail.tsx). Kept local
// here to avoid a cross-page import for a 4-row constant.
const CAPACITY_OPTIONS = [
  { value: "tier_10k_50k", label: "$10k–$50k" },
  { value: "tier_50k_250k", label: "$50k–$250k" },
  { value: "tier_250k_1m", label: "$250k–$1M" },
  { value: "tier_1m_plus", label: "$1M+" },
] as const satisfies ReadonlyArray<InlineSelectOption<string>>;

// Same enums used on funders; mirrored here so the funder + person
// pipeline vocabulary stays in sync.
const CONNECTION_STATUS_OPTIONS = [
  { value: "connected", label: "Connected" },
  { value: "have_a_connector", label: "Have a connector" },
  { value: "no_connection", label: "No connection" },
] as const satisfies ReadonlyArray<InlineSelectOption<ConnectionStatus>>;

const ENTHUSIASM_OPTIONS = [
  { value: "advocate", label: "Advocate" },
  { value: "supportive", label: "Supportive" },
  { value: "warm", label: "Warm" },
  { value: "neutral", label: "Neutral" },
  { value: "unsupportive", label: "Unsupportive" },
] as const satisfies ReadonlyArray<InlineSelectOption<Enthusiasm>>;

const PRIORITY_OPTIONS = [
  { value: "top", label: "Top" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
] as const satisfies ReadonlyArray<InlineSelectOption<Priority>>;
import { useToast } from "@/hooks/use-toast";
import { personDisplayName } from "@/lib/person";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { DerivedRow } from "@/components/derived-row";

export default function IndividualDetail() {
  const [, params] = useRoute("/individuals/:id");
  const id = params?.id ?? "";

  const { data, isLoading, isError, error } = useGetPerson(id, {
    query: { queryKey: getGetPersonQueryKey(id), enabled: !!id },
  });

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading person…</div>;
  }
  if (isError || !data) {
    return (
      <div className="space-y-4">
        <Link href="/individuals" className="text-sm text-primary hover:underline">
          ← Back to individuals
        </Link>
        <div className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Person not found."}
        </div>
      </div>
    );
  }

  return <PersonView person={data} />;
}

function PersonView({ person }: { person: PersonDetail }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const userNames = useUserNameMap();
  const ownerDisplay = person.ownerUserId
    ? (userNames.get(person.ownerUserId) ?? person.ownerUserId)
    : "—";
  const regionNames = useRegionNameMap();
  const regionDisplay = person.currentHomeRegionId
    ? (regionNames.get(person.currentHomeRegionId) ?? person.currentHomeRegionId)
    : "—";

  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(person.fullName ?? "");

  const update = useUpdatePerson({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetPersonQueryKey(person.id) }),
          queryClient.invalidateQueries({ queryKey: getListPeopleQueryKey() }),
        ]);
        toast({ title: "Person updated" });
      },
      onError: (err: unknown) => {
        toast({
          title: "Update failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const del = useDeletePerson({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListPeopleQueryKey() });
        toast({ title: "Person deleted" });
        navigate("/individuals");
      },
      onError: (err: unknown) => {
        toast({
          title: "Delete failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  function patch(body: UpdatePersonBody) {
    return update.mutateAsync({ id: person.id, data: body });
  }

  async function saveName() {
    const trimmed = nameValue.trim();
    if (trimmed === (person.fullName ?? "")) {
      setEditingName(false);
      return;
    }
    await patch({ fullName: trimmed || null });
    setEditingName(false);
  }

  const title = editingName ? (
    <Input
      value={nameValue}
      onChange={(e) => setNameValue(e.target.value)}
      className="h-11 max-w-md font-serif text-2xl font-bold"
      aria-label="Full name"
      data-testid="input-person-name"
      autoFocus
    />
  ) : (
    personDisplayName(person)
  );

  const actions = editingName ? (
    <>
      <Button
        onClick={saveName}
        disabled={update.isPending}
        data-testid="button-save-person-name"
      >
        {update.isPending ? "Saving…" : "Save"}
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          setNameValue(person.fullName ?? "");
          setEditingName(false);
        }}
        disabled={update.isPending}
      >
        Cancel
      </Button>
    </>
  ) : (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setEditingName(true)}
        data-testid="button-edit-person-name"
      >
        Edit name
      </Button>
      <ConfirmDeleteDialog
        title={`Delete ${personDisplayName(person)}?`}
        description="This person record will be removed. Household memberships and links from opportunities or gifts may need to be cleaned up separately."
        onConfirm={() => del.mutateAsync({ id: person.id })}
        disabled={del.isPending}
        triggerTestId="button-delete-person"
        confirmTestId="button-confirm-delete-person"
      />
    </>
  );

  const highlights: Highlight[] = [
    {
      label: "Priority",
      value: person.priority ? (
        <Badge variant={person.priority === "top" ? "default" : "outline"}>
          {formatEnum(person.priority)}
        </Badge>
      ) : (
        "—"
      ),
      accent: true,
    },
    { label: "Capacity", value: formatCapacity(person.capacityRating) },
    { label: "Enthusiasm", value: formatEnum(person.enthusiasm) },
    { label: "Owner", value: ownerDisplay },
    { label: "Last contacted", value: formatDate(person.lastContacted) },
  ];

  const roles = person.roles ?? [];

  return (
    <RecordLayout
      backHref="/individuals"
      backLabel="Back to individuals"
      title={title}
      typeBadge="Individual"
      subtitle={person.pronouns ? formatEnum(person.pronouns) : undefined}
      actions={actions}
      highlights={highlights}
      left={
        <>
          <FieldCard title="Basics">
            <div className="space-y-1">
              <Row label="Prefix">
                <InlineEditText label="Prefix" testIdBase="person-prefix"
                  value={person.prefix ?? null} display={person.prefix ?? "—"}
                  onSave={(next) => patch({ prefix: next })} />
              </Row>
              <Row label="First">
                <InlineEditText label="First name" testIdBase="person-first"
                  value={person.firstName ?? null} display={person.firstName ?? "—"}
                  onSave={(next) => patch({ firstName: next })} />
              </Row>
              <Row label="Middle">
                <InlineEditText label="Middle name" testIdBase="person-middle"
                  value={person.middleName ?? null} display={person.middleName ?? "—"}
                  onSave={(next) => patch({ middleName: next })} />
              </Row>
              <Row label="Last">
                <InlineEditText label="Last name" testIdBase="person-last"
                  value={person.lastName ?? null} display={person.lastName ?? "—"}
                  onSave={(next) => patch({ lastName: next })} />
              </Row>
              <Row label="Suffix">
                <InlineEditText label="Suffix" testIdBase="person-suffix"
                  value={person.suffix ?? null} display={person.suffix ?? "—"}
                  onSave={(next) => patch({ suffix: next })} />
              </Row>
              <Row label="Nickname">
                <InlineEditText label="Nickname" testIdBase="person-nickname"
                  value={person.nickname ?? null} display={person.nickname ?? "—"}
                  onSave={(next) => patch({ nickname: next })} />
              </Row>
              <Row label="Pronouns">
                <InlineEditSelect label="Pronouns" testIdBase="person-pronouns"
                  value={person.pronouns ?? null} options={PRONOUNS_OPTIONS}
                  display={formatEnum(person.pronouns)}
                  onSave={(next) => patch({ pronouns: next })} />
              </Row>
              <Row label="Status">
                <InlineEditBoolean
                  label="Deceased"
                  testIdBase="person-deceased"
                  value={person.deceased ?? null}
                  trueLabel="Deceased"
                  falseLabel="Living"
                  allowNull={false}
                  display={
                    person.deceased == null
                      ? "—"
                      : person.deceased
                        ? <Badge variant="outline">Deceased</Badge>
                        : "Living"
                  }
                  onSave={(next) => patch({ deceased: next ?? false })}
                />
              </Row>
              <Row label="Capacity">
                <InlineEditSelect
                  label="Capacity rating"
                  testIdBase="person-capacity"
                  value={person.capacityRating ?? null}
                  options={CAPACITY_OPTIONS}
                  display={formatCapacity(person.capacityRating)}
                  onSave={(next) => patch({ capacityRating: next as PersonDetail["capacityRating"] })}
                />
              </Row>
              <Row label="Connection">
                <InlineEditSelect
                  label="Connection status"
                  testIdBase="person-connection"
                  value={person.connectionStatus ?? null}
                  options={CONNECTION_STATUS_OPTIONS}
                  display={formatEnum(person.connectionStatus)}
                  onSave={(next) => patch({ connectionStatus: next })}
                />
              </Row>
              <Row label="Enthusiasm">
                <InlineEditSelect
                  label="Enthusiasm"
                  testIdBase="person-enthusiasm"
                  value={person.enthusiasm ?? null}
                  options={ENTHUSIASM_OPTIONS}
                  display={formatEnum(person.enthusiasm)}
                  onSave={(next) => patch({ enthusiasm: next })}
                />
              </Row>
              <Row label="Priority">
                <InlineEditSelect
                  label="Priority"
                  testIdBase="person-priority"
                  value={person.priority ?? null}
                  options={PRIORITY_OPTIONS}
                  display={
                    person.priority ? (
                      <Badge variant={person.priority === "top" ? "default" : "outline"}>
                        {formatEnum(person.priority)}
                      </Badge>
                    ) : (
                      "—"
                    )
                  }
                  onSave={(next) => patch({ priority: next })}
                />
              </Row>
            </div>
          </FieldCard>

          <FieldCard title="Engagement">
            <div className="space-y-1">
              <DerivedRow label="Last contacted" hint="derived from interactions">
                {formatDate(person.lastContacted)}
              </DerivedRow>
              <DerivedRow label="Interactions" hint="derived from interactions">
                {person.interactionCount ?? "—"}
              </DerivedRow>
              <Row label="Owner">
                <InlineEditUserPicker testIdBase="person-owner"
                  value={person.ownerUserId ?? null}
                  display={ownerDisplay}
                  onSave={(next) => patch({ ownerUserId: next })} />
              </Row>
              <Row label="Region">
                <InlineEditRegionPicker testIdBase="person-region"
                  value={person.currentHomeRegionId ?? null}
                  display={regionDisplay}
                  onSave={(next) => patch({ currentHomeRegionId: next })} />
              </Row>
              <Row label="Children at WF">
                <InlineEditText
                  label="Children at WF"
                  testIdBase="person-children-at-wf"
                  value={person.childrenAtWf ?? null}
                  placeholder="e.g. 2"
                  display={person.childrenAtWf ?? "—"}
                  onSave={(next) => patch({ childrenAtWf: next })}
                />
              </Row>
              <Row label="Newsletter">
                <InlineEditBoolean
                  label="Newsletter subscribed"
                  testIdBase="person-newsletter"
                  value={person.newsletter ?? null}
                  trueLabel="Subscribed"
                  falseLabel="Not subscribed"
                  allowNull={false}
                  display={
                    person.unsubscribedToNewsletter
                      ? "Unsubscribed"
                      : person.newsletter == null
                        ? "—"
                        : person.newsletter
                          ? "Subscribed"
                          : "Not subscribed"
                  }
                  onSave={(next) => patch({ newsletter: next ?? false })}
                />
              </Row>
              <Row label="Unsubscribed">
                <InlineEditBoolean
                  label="Unsubscribed to newsletter"
                  testIdBase="person-unsubscribed"
                  value={person.unsubscribedToNewsletter ?? null}
                  allowNull={false}
                  display={
                    person.unsubscribedToNewsletter == null
                      ? "—"
                      : person.unsubscribedToNewsletter
                        ? "Yes"
                        : "No"
                  }
                  onSave={(next) => patch({ unsubscribedToNewsletter: next ?? false })}
                />
              </Row>
            </div>
          </FieldCard>

          <FieldCard title="Web">
            <div className="space-y-1">
              <Row label="Website">
                <InlineEditText label="Website" testIdBase="person-website"
                  value={person.website ?? null} placeholder="https://…"
                  display={
                    person.website ? (
                      <a href={person.website} target="_blank" rel="noreferrer"
                        className="text-primary hover:underline break-all">
                        {person.website}
                      </a>
                    ) : "—"
                  }
                  onSave={(next) => patch({ website: next })} />
              </Row>
              <Row label="LinkedIn">
                <InlineEditText label="LinkedIn" testIdBase="person-linkedin"
                  value={person.linkedin ?? null}
                  display={
                    person.linkedin ? (
                      <a
                        href={person.linkedin}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline truncate"
                      >
                        {formatLinkedinHandle(person.linkedin)}
                      </a>
                    ) : (
                      "—"
                    )
                  }
                  onSave={(next) => patch({ linkedin: next })} />
              </Row>
              <Row label="X">
                <InlineEditText label="X" testIdBase="person-x"
                  value={person.x ?? null}
                  display={
                    person.x ? (
                      <a
                        href={person.x}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline truncate"
                      >
                        {formatXHandle(person.x)}
                      </a>
                    ) : (
                      "—"
                    )
                  }
                  onSave={(next) => patch({ x: next })} />
              </Row>
              <Row label="Facebook">
                <InlineEditText label="Facebook" testIdBase="person-facebook"
                  value={person.facebook ?? null}
                  display={
                    person.facebook ? (
                      <a
                        href={person.facebook}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline truncate"
                      >
                        {formatFacebookHandle(person.facebook)}
                      </a>
                    ) : (
                      "—"
                    )
                  }
                  onSave={(next) => patch({ facebook: next })} />
              </Row>
              <Row label="Instagram">
                <InlineEditText label="Instagram" testIdBase="person-instagram"
                  value={person.instagram ?? null}
                  display={
                    person.instagram ? (
                      <a
                        href={person.instagram}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline truncate"
                      >
                        {formatInstagramHandle(person.instagram)}
                      </a>
                    ) : (
                      "—"
                    )
                  }
                  onSave={(next) => patch({ instagram: next })} />
              </Row>
              <Row label="Meeting link">
                <InlineEditText label="Meeting link" testIdBase="person-meeting-link"
                  value={person.meetingLink ?? null} display={person.meetingLink ?? "—"}
                  onSave={(next) => patch({ meetingLink: next })} />
              </Row>
            </div>
          </FieldCard>

          <FieldCard title="Interests">
            <div className="space-y-3">
              <TagEditRow label="Thematic">
                <InlineEditInterestsThematic
                  testIdBase="person-interests-thematic"
                  value={person.interestsThematic ?? []}
                  onSave={(next) => patch({ interestsThematic: next })}
                />
              </TagEditRow>
              <TagEditRow label="Ages">
                <InlineEditInterestsAges
                  testIdBase="person-interests-ages"
                  value={person.interestsAges ?? []}
                  onSave={(next) => patch({ interestsAges: next })}
                />
              </TagEditRow>
              <TagEditRow label="Gov models">
                <InlineEditInterestsGovModels
                  testIdBase="person-interests-gov"
                  value={person.interestsGovModels ?? []}
                  onSave={(next) => patch({ interestsGovModels: next })}
                />
              </TagEditRow>
              <TagEditRow label="Regions">
                <InlineEditMultiRegionPicker
                  testIdBase="person-regions"
                  value={person.regionIds ?? []}
                  onSave={(next) => patch({ regionIds: next })}
                />
              </TagEditRow>
            </div>
          </FieldCard>

          <FieldCard title="Contact info" defaultOpen={false}>
            <div className="space-y-4">
              <EmailsEditor personId={person.id} emails={person.emails} />
              <Separator />
              <PhoneNumbersEditor
                personId={person.id}
                phoneNumbers={person.phoneNumbers}
              />
              <Separator />
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Addresses</div>
                {person.addresses && person.addresses.length > 0 ? (
                  <ul className="space-y-2 text-sm">
                    {person.addresses.map((a) => (
                      <li key={a.id}>
                        {[a.street, a.cityName, a.stateCode, a.postalCode]
                          .filter(Boolean)
                          .join(", ") || "—"}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No addresses.</p>
                )}
              </div>
            </div>
          </FieldCard>

          <FieldCard title="Other details" defaultOpen={false}>
            <div className="space-y-4">
              <Row label="Tags">
                <InlineEditText
                  label="Tags"
                  testIdBase="person-tags"
                  value={person.tags ?? null}
                  placeholder="Comma-separated tags"
                  display={person.tags ?? "—"}
                  onSave={(next) => patch({ tags: next })}
                />
              </Row>
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">About</div>
                <InlineEditTextarea
                  label="About"
                  testIdBase="person-about-me"
                  value={person.aboutMe ?? null}
                  placeholder="Add a bio…"
                  display={
                    person.aboutMe ? (
                      <p className="whitespace-pre-wrap text-left">{person.aboutMe}</p>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )
                  }
                  onSave={(next) => patch({ aboutMe: next })}
                />
              </div>
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Details</div>
                <InlineEditTextarea
                  label="Details"
                  testIdBase="person-details"
                  value={person.details ?? null}
                  placeholder="Add details…"
                  display={
                    person.details ? (
                      <p className="whitespace-pre-wrap text-left">{person.details}</p>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )
                  }
                  onSave={(next) => patch({ details: next })}
                />
              </div>
            </div>
          </FieldCard>

          <div className="px-1 text-xs text-muted-foreground">
            Created {formatDate(person.createdAt)} • Updated {formatDate(person.updatedAt)}
          </div>
        </>
      }
      center={
        <>
          <ActivityTimeline personId={person.id} />
          <NotesPanel personId={person.id} />
          <TasksPanel personId={person.id} />
        </>
      }
      right={
        <>
          <RelatedCard title="Affiliations" count={roles.length}>
            {roles.length > 0 ? (
              <ul className="space-y-1 px-2 py-1 text-sm">
                {roles.map((r) => (
                  <RoleRow key={r.id} role={r} />
                ))}
              </ul>
            ) : (
              <p className="px-2 py-2 text-sm text-muted-foreground">
                No affiliations.
              </p>
            )}
          </RelatedCard>

          <LinkedOpportunitiesCard
            scope={{ individualGiverPersonId: person.id }}
            title="Pledges"
            pledgeView="pledges"
            emptyLabel="No pledges from this individual."
          />

          <LinkedOpportunitiesCard
            scope={{ individualGiverPersonId: person.id }}
            title="Open opportunities"
            pledgeView="opportunities"
            status="open"
            emptyLabel="No open opportunities."
          />

          <LinkedGiftsCard scope={{ individualGiverPersonId: person.id }} />
        </>
      }
    />
  );
}

function RoleRow({ role: r }: { role: PeopleEntityRole }) {
  // Call all four resolvers unconditionally to keep hook order stable; only
  // one of the four IDs is populated per role (per-entity discriminator
  // CHECK in the DB), so only one returns a non-null name.
  const funderName = useFunderName(r.funderId ?? null);
  const orgName = useOrganizationName(r.organizationId ?? null);
  const householdName = useHouseholdName(r.householdId ?? null);
  const intermediaryName = useIntermediaryName(r.paymentIntermediaryId ?? null);
  const entityHref = r.funderId
    ? `/funding-entities/${r.funderId}`
    : r.householdId
      ? `/households/${r.householdId}`
      : null;
  // RoleRow is a per-row list-style display (funder/org/household per role),
  // so funder names get the compact abbreviation. Detail pages for the
  // funder/household themselves still show the full name.
  const entityLabel =
    (funderName ? formatFunderNameShort(funderName) : null) ??
    orgName ??
    householdName ??
    intermediaryName ??
    r.funderId ??
    r.organizationId ??
    r.householdId ??
    r.paymentIntermediaryId ??
    null;
  return (
    <li
      className="flex items-center justify-between gap-2"
      data-testid={`row-person-role-${r.id}`}
    >
      <span className="truncate">
        {r.externalTitleOrRole ?? formatEnum(r.entityType)}
        {entityLabel ? (
          <>
            {" @ "}
            {entityHref ? (
              <Link href={entityHref} className="text-primary hover:underline">
                {entityLabel}
              </Link>
            ) : (
              entityLabel
            )}
          </>
        ) : null}
      </span>
      <span className="text-muted-foreground text-xs whitespace-nowrap">
        {formatEnum(r.connection)}
        {r.current && r.current !== "current"
          ? ` (${formatEnum(r.current)})`
          : ""}
        {r.primaryContact ? " • primary" : ""}
      </span>
    </li>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function TagEditRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">
        {label}
      </div>
      {children}
    </div>
  );
}
