import { useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import {
  useGetPerson,
  useUpdatePerson,
  useDeletePerson,
  useGetHousehold,
  useGetOrganization,
  useGetPaymentIntermediary,
  useGetCurrentUser,
  useListPersonSuppressionWindows,
  useCreatePersonSuppressionWindow,
  useUpdatePersonSuppressionWindow,
  useDeletePersonSuppressionWindow,
  getGetPersonQueryKey,
  getGetHouseholdQueryKey,
  getGetOrganizationQueryKey,
  getGetPaymentIntermediaryQueryKey,
  getListPeopleQueryKey,
  getListPersonSuppressionWindowsQueryKey,
  type PersonDetail,
  type UpdatePersonBody,
  type Pronouns,
  type ConnectionStatus,
  type Enthusiasm,
  type Priority,
  type EntityRoleType,
  type PersonSuppressionWindow,
} from "@workspace/api-client-react";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import {
  EmailsEditor,
  PhoneNumbersEditor,
  AddressesEditor,
} from "@/components/contact-info-editor";
import { UnifiedActivityFeed } from "@/components/unified-activity-feed";
import { PinnedMediaCard } from "@/components/media-mentions-panel";
import { GivesThroughCard } from "@/components/gives-through-card";
import { TasksPanel } from "@/components/tasks-panel";
import {
  LinkedGiftsCard,
  LinkedOpportunitiesCard,
} from "@/components/linked-records";
import {
  AddPersonOrgRoleDialog,
  AddPersonToHouseholdDialog,
  EditPeopleEntityRoleDialog,
} from "@/components/add-role-dialogs";
import {
  RecordLayout,
  FieldCard,
  RelatedCard,
  AffiliationRow,
  HideInactiveToggle,
  type Highlight,
} from "@/components/record-layout";
import { cn } from "@/lib/utils";
import {
  InlineEditBoolean,
  InlineEditCurrency,
  InlineEditSelect,
  InlineEditText,
  InlineEditTextarea,
  type InlineSelectOption,
} from "@/components/inline-edit";
import { InlineEditUserPicker, useUserNameMap } from "@/components/user-picker";
import { InlineEditRegionPicker } from "@/components/region-picker";
import {
  useOrganizationName,
  useHouseholdName,
  useIntermediaryName,
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
  formatCurrency,
  formatDate,
  formatEnum,
  formatEnthusiasm,
  formatOrganizationNameShort,
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
  { value: "tier_1k_10k", label: "$1k–$10k" },
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
  { value: "7-advocate", label: "7-Advocate" },
  { value: "6-supportive", label: "6-Supportive" },
  { value: "5-warm", label: "5-Warm" },
  { value: "4-neutral", label: "4-Neutral" },
  { value: "3-cool", label: "3-Cool" },
  { value: "2-unsupportive", label: "2-Unsupportive" },
  { value: "1-hostile", label: "1-Hostile" },
] as const satisfies ReadonlyArray<InlineSelectOption<Enthusiasm>>;

const PRIORITY_OPTIONS = [
  { value: "top", label: "Top" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
] as const satisfies ReadonlyArray<InlineSelectOption<Priority>>;
import { useToast } from "@/hooks/use-toast";
import { personDisplayName } from "@/lib/person";
import { canSeeIdentity, canManageIdentity, ANONYMOUS_LABEL } from "@/lib/visibility";
import { Badge } from "@/components/ui/badge";
import { PriorityTooltip } from "@/components/priority-tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

type NameDraft = {
  prefix: string;
  firstName: string;
  nickname: string;
  middleName: string;
  lastName: string;
  suffix: string;
};

function nameDraftFrom(p: PersonDetail): NameDraft {
  return {
    prefix: p.prefix ?? "",
    firstName: p.firstName ?? "",
    nickname: p.nickname ?? "",
    middleName: p.middleName ?? "",
    lastName: p.lastName ?? "",
    suffix: p.suffix ?? "",
  };
}

const NAME_FIELDS = [
  { key: "prefix", label: "Prefix", width: "w-20" },
  { key: "firstName", label: "First", width: "w-36" },
  { key: "nickname", label: "Nickname", width: "w-32" },
  { key: "middleName", label: "Middle", width: "w-28" },
  { key: "lastName", label: "Last", width: "w-40" },
  { key: "suffix", label: "Suffix", width: "w-20" },
] as const satisfies ReadonlyArray<{
  key: keyof NameDraft;
  label: string;
  width: string;
}>;

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
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(() => nameDraftFrom(person));

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

  const viewer = useGetCurrentUser().data ?? null;
  const canSeeName = canSeeIdentity(person, viewer);

  function patch(body: UpdatePersonBody) {
    return update.mutateAsync({ id: person.id, data: body });
  }

  function startEditName() {
    setNameDraft(nameDraftFrom(person));
    setEditingName(true);
  }

  async function saveName() {
    const norm = (s: string) => {
      const t = s.trim();
      return t.length ? t : null;
    };
    const prefix = norm(nameDraft.prefix);
    const firstName = norm(nameDraft.firstName);
    const nickname = norm(nameDraft.nickname);
    const middleName = norm(nameDraft.middleName);
    const lastName = norm(nameDraft.lastName);
    const suffix = norm(nameDraft.suffix);
    // The 5th highlight box (full name) is calculated from the parts, so we
    // compose it here rather than letting it drift out of sync.
    const fullName =
      [prefix, firstName, middleName, lastName, suffix]
        .filter(Boolean)
        .join(" ") || null;
    await patch({
      prefix,
      firstName,
      nickname,
      middleName,
      lastName,
      suffix,
      fullName,
    });
    setEditingName(false);
  }

  const title = editingName ? (
    <div className="flex flex-wrap items-end gap-2">
      {NAME_FIELDS.map((f) => (
        <div key={f.key} className="space-y-1">
          <label className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {f.label}
          </label>
          <Input
            value={nameDraft[f.key]}
            onChange={(e) =>
              setNameDraft((d) => ({ ...d, [f.key]: e.target.value }))
            }
            className={cn("h-9 font-sans text-base font-normal", f.width)}
            aria-label={f.label}
            data-testid={`input-person-${f.key}`}
            autoFocus={f.key === "firstName"}
          />
        </div>
      ))}
    </div>
  ) : (
    canSeeName ? personDisplayName(person) : ANONYMOUS_LABEL
  );

  const actions = editingName ? (
    <>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-8 w-8 text-primary"
        onClick={saveName}
        disabled={update.isPending}
        aria-label="Save name"
        data-testid="button-save-person-name"
      >
        <Check className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-8 w-8 text-muted-foreground"
        onClick={() => setEditingName(false)}
        disabled={update.isPending}
        aria-label="Cancel name edit"
      >
        <X className="h-4 w-4" />
      </Button>
    </>
  ) : (
    <>
      {canSeeName && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={startEditName}
          aria-label="Edit name"
          data-testid="button-edit-person-name"
        >
          <Pencil className="h-4 w-4" />
        </Button>
      )}
      <ConfirmDeleteDialog
        title={`Delete ${canSeeName ? personDisplayName(person) : ANONYMOUS_LABEL}?`}
        description="This person record will be removed. Household memberships and links from opportunities or gifts may need to be cleaned up separately."
        onConfirm={() => del.mutateAsync({ id: person.id })}
        disabled={del.isPending}
        confirmTestId="button-confirm-delete-person"
        trigger={
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            disabled={del.isPending}
            aria-label="Delete person"
            data-testid="button-delete-person"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        }
      />
    </>
  );

  const highlights: Highlight[] = [
    {
      label: (
        <span className="inline-flex items-center gap-1">
          Priority
          <PriorityTooltip />
        </span>
      ),
      value: (
        <InlineEditSelect
          label="Priority"
          testIdBase="person-priority"
          value={person.priority ?? null}
          options={PRIORITY_OPTIONS}
          display={
            person.priority ? (
              <Badge
                variant={person.priority === "top" ? "default" : "outline"}
              >
                {formatEnum(person.priority)}
              </Badge>
            ) : (
              "—"
            )
          }
          onSave={(next) => patch({ priority: next })}
        />
      ),
      accent: true,
    },
    {
      label: "Capacity",
      value: (
        <InlineEditSelect
          label="Capacity rating"
          testIdBase="person-capacity"
          value={person.capacityRating ?? null}
          options={CAPACITY_OPTIONS}
          display={formatCapacity(person.capacityRating)}
          onSave={(next) =>
            patch({ capacityRating: next as PersonDetail["capacityRating"] })
          }
        />
      ),
    },
    {
      label: "Connection",
      value: (
        <InlineEditSelect
          label="Connection status"
          testIdBase="person-connection"
          value={person.connectionStatus ?? null}
          options={CONNECTION_STATUS_OPTIONS}
          display={formatEnum(person.connectionStatus)}
          onSave={(next) => patch({ connectionStatus: next })}
        />
      ),
    },
    {
      label: "Enthusiasm",
      value: (
        <InlineEditSelect
          label="Enthusiasm"
          testIdBase="person-enthusiasm"
          value={person.enthusiasm ?? null}
          options={ENTHUSIASM_OPTIONS}
          display={formatEnthusiasm(person.enthusiasm)}
          onSave={(next) => patch({ enthusiasm: next })}
        />
      ),
    },
    {
      label: "Lifetime giving",
      value: formatCurrency(person.lifetimeGiving),
    },
    {
      label: "Owner",
      value: (
        <InlineEditUserPicker
          testIdBase="person-owner-header"
          value={person.ownerUserId ?? null}
          display={ownerDisplay}
          onSave={(next) => patch({ ownerUserId: next })}
        />
      ),
    },
  ];

  const roles = person.roles ?? [];

  return (
    <RecordLayout
      backHref="/individuals"
      backLabel="Back to individuals"
      title={title}
      typeBadge="Individual"
      subtitle={
        <div className="w-full space-y-2">
          {person.pronouns ? <div>{formatEnum(person.pronouns)}</div> : null}
          <InlineEditTextarea
            label="About"
            testIdBase="person-about-me"
            value={person.aboutMe ?? null}
            placeholder="Add a bio…"
            display={
              person.aboutMe ? (
                <p className="whitespace-pre-wrap text-left text-sm text-foreground">
                  {person.aboutMe}
                </p>
              ) : (
                <span className="text-muted-foreground">Add a bio…</span>
              )
            }
            onSave={(next) => patch({ aboutMe: next })}
          />
        </div>
      }
      actions={actions}
      highlights={highlights}
      left={
        <>
          <FieldCard title="Basics">
            <div className="space-y-1">
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
              {canManageIdentity(person, viewer) && (
                <Row label="Anonymous">
                  <InlineEditBoolean
                    label="Anonymous"
                    testIdBase="person-anonymous"
                    value={person.anonymous}
                    trueLabel="Anonymous"
                    falseLabel="Visible"
                    allowNull={false}
                    display={person.anonymous ? "Yes" : "No"}
                    onSave={(next) => patch({ anonymous: next ?? false })}
                  />
                </Row>
              )}
              <Row label="Home region">
                <InlineEditRegionPicker testIdBase="person-region"
                  label="Home region"
                  value={person.currentHomeRegionId ?? null}
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
              <Row label="Net worth">
                <InlineEditCurrency
                  label="Net worth"
                  testIdBase="person-net-worth"
                  value={person.netWorth ?? null}
                  display={formatCurrency(person.netWorth)}
                  onSave={(next) => patch({ netWorth: next })}
                />
              </Row>
            </div>
          </FieldCard>

          <FieldCard title="Contact info">
            <div className="space-y-4">
              <EmailsEditor
                owner={{ kind: "person", id: person.id }}
                emails={person.emails}
              />
              <Separator />
              <PhoneNumbersEditor
                owner={{ kind: "person", id: person.id }}
                phoneNumbers={person.phoneNumbers}
              />
              <Separator />
              <AddressesEditor
                owner={{ kind: "person", id: person.id }}
                addresses={person.addresses}
              />
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

          <FieldCard title="Engagement">
            <div className="space-y-1">
              <Row label="Owner">
                <InlineEditUserPicker testIdBase="person-owner"
                  value={person.ownerUserId ?? null}
                  display={ownerDisplay}
                  onSave={(next) => patch({ ownerUserId: next })} />
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

          <div className="px-1 text-xs text-muted-foreground">
            Created {formatDate(person.createdAt)} • Updated {formatDate(person.updatedAt)}
          </div>
        </>
      }
      center={
        (() => {
          const householdRole = (person.roles ?? []).find(
            (r) => r.entityType === "household" && r.householdId && r.current === "current",
          );
          const personDefaultLinks: Partial<{ personIds: string[]; organizationIds: string[]; householdIds: string[]; opportunityIds: string[]; giftIds: string[] }> = householdRole?.householdId
            ? { householdIds: [householdRole.householdId] }
            : {};
          return (
            <>
              <TasksPanel personId={person.id} defaultLinks={personDefaultLinks} />
              <UnifiedActivityFeed
                personId={person.id}
                notesContext={{ personId: person.id, defaultLinks: personDefaultLinks }}
                hideTasks
              />
            </>
          );
        })()
      }
      right={
        <>
          <PinnedMediaCard personId={person.id} />
          <LinkedOpportunitiesCard
            scope={{ individualGiverPersonId: person.id }}
            title="Open opportunities"
            pledgeView="opportunities"
            status="open"
            emptyLabel="No open opportunities."
          />

          <HouseholdCard person={person} />

          <PeopleCard person={person} />

          <OrganizationsCard roles={roles} personId={person.id} />

          <GivesThroughCard donor={{ individualGiverPersonId: person.id }} />

          <LinkedOpportunitiesCard
            scope={{ individualGiverPersonId: person.id }}
            title="Pledges"
            pledgeView="pledges"
            emptyLabel="No pledges from this individual."
          />

          <LinkedGiftsCard scope={{ individualGiverPersonId: person.id }} />

          <SuppressionWindowsCard personId={person.id} />
        </>
      }
    />
  );
}

function RoleRow({ role: r }: { role: PeopleEntityRole }) {
  // Call all four resolvers unconditionally to keep hook order stable; only
  // one of the four IDs is populated per role (per-entity discriminator
  // CHECK in the DB), so only one returns a non-null name.
  const organizationName = useOrganizationName(r.organizationId ?? null);
  const householdName = useHouseholdName(r.householdId ?? null);
  const intermediaryName = useIntermediaryName(r.paymentIntermediaryId ?? null);
  const entityHref = r.organizationId
    ? `/organizations/${r.organizationId}`
    : r.householdId
      ? `/households/${r.householdId}`
      : null;
  // RoleRow is a per-row list-style display (organization/household per role),
  // so organization names get the compact abbreviation. Detail pages for the
  // funder/household themselves still show the full name.
  const entityLabel =
    (organizationName ? formatOrganizationNameShort(organizationName) : null) ??
    householdName ??
    intermediaryName ??
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
        {entityHref ? (
          <Link href={entityHref} className="text-primary hover:underline">
            {entityLabel ?? formatEnum(r.entityType)}
          </Link>
        ) : (
          (entityLabel ?? formatEnum(r.entityType))
        )}
      </span>
      <span className="flex items-center gap-1 whitespace-nowrap">
        <span className="text-muted-foreground text-xs">
          {r.externalTitleOrRole ?? formatEnum(r.connection)}
          {r.current && r.current !== "current"
            ? ` (${formatEnum(r.current)})`
            : ""}
          {r.primaryContact ? " • primary" : ""}
        </span>
        <EditPeopleEntityRoleDialog
          role={r}
          contextLabel={entityLabel ?? undefined}
        />
      </span>
    </li>
  );
}

function OrganizationsCard({
  roles,
  personId,
}: {
  roles: PeopleEntityRole[];
  personId: string;
}) {
  // Everything that isn't a household membership is an organizational
  // affiliation (funder / non-funding org / payment intermediary).
  const orgRoles = roles.filter((r) => r.entityType !== "household");
  const [hideInactive, setHideInactive] = useState(false);
  const hasInactive = orgRoles.some((r) => r.current === "past");
  const visibleRoles = hideInactive
    ? orgRoles.filter((r) => r.current !== "past")
    : orgRoles;
  return (
    <RelatedCard
      title="Organizations"
      count={visibleRoles.length}
      action={
        <div className="flex items-center gap-1">
          {hasInactive ? (
            <HideInactiveToggle
              hidden={hideInactive}
              onToggle={() => setHideInactive((v) => !v)}
            />
          ) : null}
          <AddPersonOrgRoleDialog personId={personId} />
        </div>
      }
    >
      {visibleRoles.length > 0 ? (
        <ul className="space-y-1 px-2 py-1 text-sm">
          {visibleRoles.map((r) => (
            <RoleRow key={r.id} role={r} />
          ))}
        </ul>
      ) : (
        <p className="px-2 py-2 text-sm text-muted-foreground">
          No organizations.
        </p>
      )}
    </RelatedCard>
  );
}

function PeopleCard({ person }: { person: PersonDetail }) {
  // "Colleagues" = current/former colleagues — people who hold a role at the
  // same funder / organization / payment intermediary this person does.
  // Household co-members live in the dedicated Household card above. Each
  // related entity is resolved by its own child component so the hooks stay
  // stable regardless of how many entities the person is tied to.
  const roles = person.roles ?? [];

  // Dedupe org affiliations by entity; a person can hold more than one role at
  // the same org (e.g. a current and a past one). The colleague is treated as
  // "current" only when this person is currently affiliated there too.
  const colleagueEntities = new Map<
    string,
    { entityType: EntityRoleType; entityId: string; viewerCurrent: boolean }
  >();
  for (const r of roles) {
    if (r.entityType === "household") continue;
    const entityId =
      r.organizationId ?? r.organizationId ?? r.paymentIntermediaryId ?? null;
    if (!entityId) continue;
    const key = `${r.entityType}:${entityId}`;
    const isCurrent = r.current === "current";
    const existing = colleagueEntities.get(key);
    if (existing) {
      existing.viewerCurrent = existing.viewerCurrent || isCurrent;
    } else {
      colleagueEntities.set(key, {
        entityType: r.entityType,
        entityId,
        viewerCurrent: isCurrent,
      });
    }
  }

  const hasAny = colleagueEntities.size > 0;
  // Past colleagues are resolved inside the child components, so we can't know
  // up here whether any inactive rows exist — offer the toggle whenever there
  // are colleague affiliations.
  const canHaveInactive = colleagueEntities.size > 0;
  const [hideInactive, setHideInactive] = useState(false);
  return (
    <RelatedCard
      title="Colleagues"
      action={
        canHaveInactive ? (
          <HideInactiveToggle
            hidden={hideInactive}
            onToggle={() => setHideInactive((v) => !v)}
          />
        ) : undefined
      }
    >
      {!hasAny ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">
          No colleagues.
        </p>
      ) : (
        <div>
          {Array.from(colleagueEntities.values()).map((e) => (
            <ColleagueMembers
              key={`${e.entityType}:${e.entityId}`}
              entityType={e.entityType}
              entityId={e.entityId}
              viewerCurrent={e.viewerCurrent}
              excludePersonId={person.id}
              hideInactive={hideInactive}
            />
          ))}
        </div>
      )}
    </RelatedCard>
  );
}

// Dedicated Household card on the individual page. Households stay first-class
// donor entities (joint-account giving), but they no longer have a top-level
// list page — they surface contextually here: name, combined giving, the other
// members, and a link through to the full household. Inactive households (a
// couple split by death/divorce) render as "Former household" so both former
// members keep visibility of the shared giving history without either personally
// owning it.
function HouseholdCard({ person }: { person: PersonDetail }) {
  const roles = person.roles ?? [];
  const householdIds = Array.from(
    new Set(
      roles
        .filter((r) => r.entityType === "household" && r.householdId)
        .map((r) => r.householdId as string),
    ),
  );
  return (
    <RelatedCard
      title="Household"
      count={householdIds.length > 0 ? householdIds.length : undefined}
      action={<AddPersonToHouseholdDialog personId={person.id} />}
    >
      {householdIds.length === 0 ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">
          Not part of a household.
        </p>
      ) : (
        <div className="space-y-4">
          {householdIds.map((hid) => (
            <HouseholdCardItem
              key={hid}
              householdId={hid}
              excludePersonId={person.id}
            />
          ))}
        </div>
      )}
    </RelatedCard>
  );
}

function HouseholdCardItem({
  householdId,
  excludePersonId,
}: {
  householdId: string;
  excludePersonId: string;
}) {
  const { data, isLoading, isError } = useGetHousehold(householdId, {
    query: { queryKey: getGetHouseholdQueryKey(householdId) },
  });
  if (isLoading) {
    return <p className="px-2 py-2 text-sm text-muted-foreground">Loading…</p>;
  }
  if (isError || !data) {
    return (
      <p className="px-2 py-2 text-sm text-destructive">
        Couldn’t load household.
      </p>
    );
  }
  const otherMembers = (data.people ?? []).filter(
    (m) => m.personId !== excludePersonId,
  );
  const openAsks = data.openOpportunityCount ?? 0;
  return (
    <div data-testid={`household-card-item-${data.id}`}>
      <div className="flex items-center justify-between gap-2 px-2">
        <Link
          href={`/households/${data.id}`}
          className="truncate font-medium text-primary hover:underline"
          data-testid={`link-household-${data.id}`}
        >
          {data.name}
        </Link>
        {!data.active && (
          <Badge variant="outline" className="shrink-0">
            Former household
          </Badge>
        )}
      </div>

      <dl className="mt-2 grid grid-cols-3 gap-2 px-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Combined giving</dt>
          <dd className="font-medium tabular-nums">
            {formatCurrency(data.lifetimeGiving)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Last gift</dt>
          <dd className="font-medium tabular-nums">
            {data.mostRecentGiftDate ? formatDate(data.mostRecentGiftDate) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Open asks</dt>
          <dd className="font-medium tabular-nums">{openAsks}</dd>
        </div>
      </dl>

      <div className="mt-2">
        <div className="px-2 text-xs font-medium text-muted-foreground">
          {otherMembers.length > 0 ? "Other members" : "Members"}
        </div>
        {otherMembers.length > 0 ? (
          otherMembers.map((m) => (
            <AffiliationRow
              key={m.id}
              name={m.personName ?? `Person ${m.personId}`}
              href={`/individuals/${m.personId}`}
              role={m.externalTitleOrRole ?? formatEnum(m.connection)}
              status={m.current === "current" ? "active" : "past"}
              primary={m.primaryContact ?? false}
              hideStatusBadge
              action={<EditPeopleEntityRoleDialog role={m} />}
            />
          ))
        ) : (
          <p className="px-2 py-1 text-sm text-muted-foreground">
            No other members.
          </p>
        )}
      </div>
    </div>
  );
}

function ColleagueMembers({
  entityType,
  entityId,
  viewerCurrent,
  excludePersonId,
  hideInactive,
}: {
  entityType: EntityRoleType;
  entityId: string;
  viewerCurrent: boolean;
  excludePersonId: string;
  hideInactive: boolean;
}) {
  // All three resolvers are called unconditionally to keep hook order stable;
  // only the one matching this entity's type is enabled.
  const orgQ = useGetOrganization(entityId, {
    query: {
      queryKey: getGetOrganizationQueryKey(entityId),
      enabled: entityType === "organization",
    },
  });
  const piQ = useGetPaymentIntermediary(entityId, {
    query: {
      queryKey: getGetPaymentIntermediaryQueryKey(entityId),
      enabled: entityType === "payment_intermediary",
    },
  });
  const active = entityType === "organization" ? orgQ : piQ;
  const { data, isLoading, isError } = active;
  if (isLoading) {
    return <p className="px-2 py-2 text-sm text-muted-foreground">Loading…</p>;
  }
  if (isError) {
    return (
      <p className="px-2 py-2 text-sm text-destructive">
        Couldn’t load colleagues.
      </p>
    );
  }
  const entityName = data?.name ?? null;
  // A person can hold more than one role at the same entity; dedupe by person so
  // a colleague shows up once, preferring a "current" role for the status badge.
  const people = (data?.people ?? []).filter(
    (m) => m.personId !== excludePersonId,
  );
  const byPerson = new Map<string, (typeof people)[number]>();
  for (const m of people) {
    const existing = byPerson.get(m.personId);
    if (!existing || (m.current === "current" && existing.current !== "current")) {
      byPerson.set(m.personId, m);
    }
  }
  const colleagues = Array.from(byPerson.values()).filter(
    // A colleague is "current" only when both this person and the colleague
    // are presently affiliated with the shared entity.
    (m) => !hideInactive || (viewerCurrent && m.current === "current"),
  );
  if (colleagues.length === 0) return null;
  return (
    <>
      {colleagues.map((m) => {
        const title = m.externalTitleOrRole ?? formatEnum(m.connection);
        const roleLine = entityName
          ? title && title !== "—"
            ? `${title} · ${entityName}`
            : entityName
          : title;
        // A "current" colleague requires both people to be currently there.
        const isCurrent = viewerCurrent && m.current === "current";
        return (
          <AffiliationRow
            key={`${entityId}:${m.id}`}
            name={m.personName ?? `Person ${m.personId}`}
            href={`/individuals/${m.personId}`}
            role={roleLine}
            status={isCurrent ? "active" : "past"}
            primary={m.primaryContact}
            hideStatusBadge
            action={
              <EditPeopleEntityRoleDialog
                role={m}
                contextLabel={entityName ?? undefined}
              />
            }
          />
        );
      })}
    </>
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

// ── Suppression windows card ─────────────────────────────────────────────────

function SuppressionWindowsCard({ personId }: { personId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const meQ = useGetCurrentUser();
  const isAdmin = meQ.data?.role === "admin";

  const windowsQ = useListPersonSuppressionWindows(
    { personId },
    { query: { queryKey: getListPersonSuppressionWindowsQueryKey({ personId }), staleTime: 30_000 } },
  );

  const [showAdd, setShowAdd] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [fromDraft, setFromDraft] = useState("");
  const [untilDraft, setUntilDraft] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editFromDraft, setEditFromDraft] = useState("");
  const [editUntilDraft, setEditUntilDraft] = useState("");
  const [editNoteDraft, setEditNoteDraft] = useState("");

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListPersonSuppressionWindowsQueryKey({ personId }) });

  const createW = useCreatePersonSuppressionWindow({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        toast({ title: "Suppression window added" });
        setShowAdd(false);
        setNoteDraft("");
        setFromDraft("");
        setUntilDraft("");
      },
      onError: (err: unknown) => {
        toast({
          title: "Failed to add window",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const updateW = useUpdatePersonSuppressionWindow({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        toast({ title: "Suppression window updated" });
        setEditingId(null);
      },
      onError: (err: unknown) => {
        toast({
          title: "Failed to update window",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const deleteW = useDeletePersonSuppressionWindow({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        toast({ title: "Suppression window removed" });
      },
      onError: (err: unknown) => {
        toast({
          title: "Failed to remove window",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const windows = windowsQ.data?.data ?? [];

  // Don't render the card at all for non-admins when there are no windows
  if (!isAdmin && windows.length === 0) return null;

  const formatDateStr = (s: string | null | undefined) => {
    if (!s) return "—";
    return new Date(s).toLocaleDateString(undefined, { dateStyle: "medium" });
  };

  const inputCls =
    "w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <RelatedCard
      title="Sync suppression"
      defaultOpen={windows.length > 0}
    >
      <p className="text-xs text-muted-foreground mb-2">
        Email/calendar sync skips this person&apos;s addresses during active windows.
      </p>
      {windowsQ.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : windows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No suppression windows.</p>
      ) : (
        <ul className="space-y-2">
          {windows.map((w: PersonSuppressionWindow) =>
            isAdmin && editingId === w.id ? (
              <li key={w.id} className="text-sm space-y-2" data-testid={`suppression-window-${w.id}`}>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-muted-foreground mb-0.5 block">From</label>
                    <input
                      type="date"
                      className={inputCls}
                      value={editFromDraft}
                      onChange={(e) => setEditFromDraft(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-0.5 block">Until</label>
                    <input
                      type="date"
                      className={inputCls}
                      value={editUntilDraft}
                      onChange={(e) => setEditUntilDraft(e.target.value)}
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-0.5 block">Notes</label>
                  <input
                    type="text"
                    className={inputCls}
                    value={editNoteDraft}
                    onChange={(e) => setEditNoteDraft(e.target.value)}
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="text-xs font-medium bg-primary text-primary-foreground rounded px-2 py-1 disabled:opacity-50"
                    disabled={updateW.isPending}
                    onClick={() =>
                      updateW.mutate({
                        id: w.id,
                        data: {
                          startDate: editFromDraft || null,
                          endDate: editUntilDraft || null,
                          notes: editNoteDraft.trim() || null,
                        },
                      })
                    }
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setEditingId(null)}
                  >
                    Cancel
                  </button>
                </div>
              </li>
            ) : (
              <li
                key={w.id}
                className="flex items-start justify-between gap-2 text-sm"
                data-testid={`suppression-window-${w.id}`}
              >
                <div>
                  <div className="font-medium tabular-nums">
                    {formatDateStr(w.startDate)} → {formatDateStr(w.endDate)}
                  </div>
                  {w.notes && (
                    <div className="text-xs text-muted-foreground mt-0.5">{w.notes}</div>
                  )}
                </div>
                {isAdmin && (
                  <div className="flex items-center gap-1 shrink-0 mt-0.5">
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="Edit suppression window"
                      onClick={() => {
                        setEditingId(w.id);
                        setEditFromDraft(w.startDate ? String(w.startDate).slice(0, 10) : "");
                        setEditUntilDraft(w.endDate ? String(w.endDate).slice(0, 10) : "");
                        setEditNoteDraft(w.notes ?? "");
                      }}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="text-destructive hover:opacity-70"
                      aria-label="Delete suppression window"
                      disabled={deleteW.isPending}
                      onClick={() => deleteW.mutate({ id: w.id })}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                )}
              </li>
            ),
          )}
        </ul>
      )}

      {isAdmin && !showAdd && (
        <button
          type="button"
          className="mt-3 text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
          onClick={() => setShowAdd(true)}
        >
          + Add window
        </button>
      )}

      {isAdmin && showAdd && (
        <div className="mt-3 space-y-2 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground mb-0.5 block">
                From (leave blank for open start)
              </label>
              <input
                type="date"
                className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={fromDraft}
                onChange={(e) => setFromDraft(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-0.5 block">
                Until (leave blank for open end)
              </label>
              <input
                type="date"
                className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={untilDraft}
                onChange={(e) => setUntilDraft(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-0.5 block">
              Notes (optional)
            </label>
            <input
              type="text"
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="e.g. Staff member 2023–2025"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="text-xs font-medium bg-primary text-primary-foreground rounded px-2 py-1 disabled:opacity-50"
              disabled={createW.isPending}
              onClick={() =>
                createW.mutate({
                  data: {
                    personId,
                    ...(fromDraft ? { startDate: fromDraft } : {}),
                    ...(untilDraft ? { endDate: untilDraft } : {}),
                    ...(noteDraft.trim() ? { notes: noteDraft.trim() } : {}),
                  },
                })
              }
            >
              Save
            </button>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                setShowAdd(false);
                setNoteDraft("");
                setFromDraft("");
                setUntilDraft("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </RelatedCard>
  );
}
